// 3D 地球（add-map-settings-globe D9～D19）：three.js（WebGL），與 2D map.mjs 同一組資料介面，panel.mjs 可以互換。
// 幾何在 globemath.mjs（純函式、有單元測試），這裡只負責畫與手勢。three.js 在 createGlobe() 裡動態載入（選 3D 才下載）。
//
// 分兩層：WebGL canvas 畫球體（底圖貼圖）、光暈、國界、弧線與航線；上面一張 2D overlay canvas 畫標點、呼號、國名、漣漪、光點
// （文字清楚，碰撞與點選規則同 2D）。色調刻意調亮（使用者 2026-10-08：不要像範例那麼深）：背景用 CSS --globe-bg，貼圖在 shader 提亮。
// 國界也畫在 overlay（依底圖兩道線，同 2D borderStyle；WebGL 的線只能 1 像素寬）。日夜分界在 shader 裡把黑夜區調暗約 30%。
// 弧線高高拱起（arcLift）；自動框住把弧頂一起算進去。拖快放開會多滑一段（慣性），使用者動過 30 秒後恢復自動框住（同 2D）。
//
// createGlobe({ canvas, overlay, onPick, onSettings, approxLocate, outlineUrl }) → Promise<api>（WebGL 建不起來時 reject）
//   api 同 map.mjs：setMe、update、setTarget、setScene、setLinks、setRipples、setOptions、fit、resize、destroy、debug
import { loadOutline, EMPTY_OUTLINE } from './outline.mjs';
import { byPriority, kindOf, labelItems, pickAt, placeLabels } from './labels.mjs';
import { locate } from './stations.mjs';
import { gridToLatLon } from '../maidenhead.mjs';
import { LINK_CYCLE, dotPhase, linkCycle, pointAlong, polyline, sameGeometry } from './scene.mjs';
import { borderStyle, countryLabels, placeCountryNames } from './countrylayer.mjs';
import { NIGHT_DIM, TERMINATOR_COLOR, TWILIGHT_DEG, subsolarPoint, terminatorPoints } from './sun.mjs';
import { wrapLon } from './projection.mjs';
import { bigMove3d, overviewFlight, worldCam3d } from './flyplan.mjs';
import { isDarkTheme, loadBasemap, loadBorders, loadCountries, loadDetail, loadStates, loadZones } from './layers.mjs';
import { DETAIL_RETRY_MS, boxOf, canRequest, readyTier, regionCovers, regionFor, tiersToLoad, vectorFade, vectorPalette } from './detail.mjs';
import { affine, visibleLandPaths } from './vectorpaint.mjs';
import { globeGridBounds, gridLabels, gridLevel, gridLines, overlayLabelStyle, overlayStyle } from './overlays.mjs';
import { MAX_VIEW_TILES, MERC_MAX_LAT, TILE_PX, drawTileSet, tileCount, tilesFor, visibleTiles } from './tiles.mjs';
import { eoxSource, peekEoxSource } from './eoxsource.mjs';
import { LONG_PRESS_MS } from '../qso/contextmenu.mjs';
import { SELECT_PULSE_LIMIT_MS, drawSelectedMark, drawSelectedPulse, pulseActive, selectedFirst, selectedRadii } from './selection.mjs';
import {
  ARC_BASE, ARC_MAX_LIFT, MAX_CAM_LAT, arcFramePoints, arcLiftCap, arcPoints, cameraPosition, centerBounds3d, debounceGoal, rollSafeBounds, degPerPx, facing, fitGlobe, flingVelocity, globeFly, globeLonSpan, globeNearlySame,
  globePxPerDeg, inertiaStep, latLonToVec3, maxDistFor, occluded, rotateBy, startInertia, visibleBounds3d, zoomBy,
} from './globemath.mjs';

const THREE_URL = new URL('../../vendor/three/three.module.min.js', import.meta.url).href;
const FOV = 35;
const FRAME_MS = 33; // 平常（連線動畫）約 30 fps；飛行與慣性滑行每個 rAF 都畫（使用者 2026-10-09：轉得很生硬）
const FRAME_SLACK_MS = 4; // rAF 間隔有抖動：差一點點也算到了，60 Hz 時穩定隔一幀畫一次（不會 30／20 fps 交替）
const DPR_MAX = 2; // 手機像素比上限（D17）
const FONT_PX = 11;
const NAME_FONT_PX = 10;
const ZONE_FONT_PX = 10; // 區號、Grid 標籤（add-map-overlays，同 2D）
const GRID_FONT_PX = 9;
const FINE_GRID_ALPHA = 0.6;
const GRID_SAMPLE_DEG = 2; // 3D 的經緯線在球面上是弧：每 2° 取一點
const TAP_SLOP_PX = 6;
const PICK_RADIUS_PX = 14;
const WHEEL_ZOOM = 0.0015;
const ARC_SEGMENTS = 48;
const ARC_RADIAL = 6;
const LINK_BASE_ALPHA = 0.35;
const LINK_STAGGER_MS = 370;
const DOT_PERIOD_MS = 2200;
const RIPPLE_PERIOD_MS = 1600;
const RIPPLE_RINGS = 3;
const TAIL_STEPS = 7;
const SUN_MS = 60_000; // 日夜分界每分鐘更新
// 慣性門檻（畫面像素／秒，依縮放換算成角速度）：慢於 MIN 放開就停；快於 MAX 封頂；慢到 STOP 停下
const FLING_MIN_PX_S = 600;
const FLING_MAX_PX_S = 2500;
const FLING_STOP_PX_S = 30;
// 底圖在 shader 裡的提亮（D13）：gamma < 1 拉亮暗部（Blue Marble 的深海）、gain 整體亮度
const TONE = { outline: { gamma: 1, gain: 1, haze: 0 }, satellite: { gamma: 0.58, gain: 1.15, haze: 0.12 }, relief: { gamma: 0.95, gain: 1.03, haze: 0 }, eox: { gamma: 0.9, gain: 1.05, haze: 0 } };
// 線上衛星圖磚（add-map-eox-imagery D8、D9）：全球貼圖用 z2（16 張）；每度像素×dpr 超過 z2 的 2 倍（約 5.7，看整個地球時還不到）改畫細節貼圖；
// 拖曳、縮放、飛行停下 EOX_IDLE_MS 才換請求清單；全球貼圖最多每 DETAIL_BUSY_MS 更新一次
const EOX_BASE_Z = 2;
const EOX_DETAIL_PPD = ((TILE_PX * 2 ** EOX_BASE_Z) / 360) * 2;
const EOX_IDLE_MS = 150;
const WORLD = Object.freeze({ west: -180, east: 180, south: -MERC_MAX_LAT, north: MERC_MAX_LAT });
// 細節貼圖（add-map-overlays D16、D19）：顯示的淡化比例往目標值漸變（約 300 ms 從 0 到 1，貼圖晚一點才建好時不會單幀跳成向量圖）；
// 移動中（飛行、慣性、手動拖曳／縮放）最多每 DETAIL_BUSY_MS 重畫一次；淡化比例降到 0 後 DETAIL_RELEASE_MS 釋放畫布與貼圖
const DETAIL_RAMP_MS = 300;
const DETAIL_BUSY_MS = 250;
const DETAIL_RELEASE_MS = 10_000;
const DETAIL_TEX_STEP = 256; // 貼圖尺寸取 256 的倍數（不一律往上取 2 的次方：WebGL2 的非 2 次方貼圖照樣有 mipmap）

// 先試建一個 context（沒有 WebGL 就不必下載 three.js）；試完立刻釋放，不佔瀏覽器的 WebGL context 名額
export function webglAvailable(doc = document) {
  try {
    const c = doc.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export async function createGlobe({ canvas, overlay, onPick = () => {}, onSettings = null, approxLocate = null,
  outlineUrl = new URL('../../data/world_110m.bin', import.meta.url) }) {
  if (!webglAvailable()) throw new Error('webgl-unavailable');
  const THREE = await import(THREE_URL);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (err) {
    throw new Error(`webgl-unavailable: ${err.message}`);
  }
  renderer.setClearColor(0x000000, 0); // 透明：背景由 CSS --globe-bg 決定
  const phone = window.matchMedia?.('(max-width: 599px)').matches;
  const scene3 = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 50);
  const octx = overlay.getContext('2d');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  // ── 球體：底圖貼圖＋邊緣淡淡的明暗；colorSpace 不轉換（貼圖與輸出都是 sRGB 原值，亮度可預期） ──
  const uniforms = {
    tex: { value: null }, hasMap: { value: 0 }, gamma: { value: 1 }, gain: { value: 1 }, haze: { value: 0 }, sea: { value: new THREE.Vector3(0.72, 0.85, 0.94) },
    // 日夜分界：太陽方向（球的座標）、開關、黑夜調暗比例、晨昏帶半寬（太陽高度的 sin）
    sunDir: { value: new THREE.Vector3(1, 0, 0) }, dayNight: { value: 0 }, nightDim: { value: NIGHT_DIM }, twilight: { value: Math.sin((TWILIGHT_DEG / 2) * Math.PI / 180) },
    // 放大後的向量圖（D16）：看得到的那一塊畫成細節貼圖（等距圓柱），依 detailMix 與底圖交叉淡化；detailRect＝西、南、經度寬、緯度高（度）
    detailTex: { value: null }, detailRect: { value: new THREE.Vector4(0, 0, 1, 1) }, detailMix: { value: 0 },
  };
  const globeMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() { vUv = uv; vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D tex; uniform float hasMap; uniform float gamma; uniform float gain; uniform float haze; uniform vec3 sea;
      uniform vec3 sunDir; uniform float dayNight; uniform float nightDim; uniform float twilight;
      uniform sampler2D detailTex; uniform vec4 detailRect; uniform float detailMix;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec3 c = hasMap > 0.5 ? texture2D(tex, vUv).rgb : sea;
        c = mix(pow(c, vec3(gamma)) * gain, vec3(0.86, 0.93, 1.0), haze);
        // 細節貼圖：分支外一律取樣（分支內取樣的 mip 導數未定義，範圍邊界會有雜點），範圍外以 step 遮掉；
        // 導數用連續的 vUv 換算（mod 折回處 du 會跳，不能拿它算 mip）
        float du = mod(vUv.x * 360.0 - 180.0 - detailRect.x, 360.0) / detailRect.z;
        float dv = (vUv.y * 180.0 - 90.0 - detailRect.y) / detailRect.w;
        vec2 dsc = vec2(360.0 / detailRect.z, 180.0 / detailRect.w);
        vec3 dc = textureGrad(detailTex, clamp(vec2(du, dv), 0.0, 1.0), dFdx(vUv) * dsc, dFdy(vUv) * dsc).rgb;
        float inside = step(0.0, du) * step(du, 1.0) * step(0.0, dv) * step(dv, 1.0);
        c = mix(c, dc, detailMix * inside);
        float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float shade = mix(0.80, 1.0, pow(ndv, 0.6));
        // 黑夜區稍暗（太陽高度的 sin 在 ±twilight 之間漸變）；不是全黑，標點、文字、弧線照樣清楚
        float night = (1.0 - smoothstep(-twilight, twilight, dot(normalize(vP), sunDir))) * dayNight;
        gl_FragColor = vec4(min(c * shade * (1.0 - nightDim * night), vec3(1.0)), 1.0);
      }`,
  });
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1, phone ? 96 : 144, phone ? 48 : 72), globeMat);
  scene3.add(globe);

  // ── 光暈：Fresnel，比球大一點、只畫背面；顏色依深淺色 ──
  const glowUniforms = { glow: { value: new THREE.Vector3(0.45, 0.7, 1.0) }, strength: { value: 0.9 } };
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1.1, 64, 32), new THREE.ShaderMaterial({
    uniforms: glowUniforms,
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 glow; uniform float strength; varying vec3 vN; varying vec3 vV;
      // 畫的是光暈球（半徑 1.1）的背面（法向朝外、背對相機）：−N·V 在光暈球輪廓為 0、在地球邊緣約 0.42，往外漸淡
      void main() { float f = clamp(-dot(normalize(vN), normalize(vV)) / 0.42, 0.0, 1.0); float a = pow(f, 2.0) * strength;
        gl_FragColor = vec4(glow, a); }`,
    side: THREE.BackSide, transparent: true, depthWrite: false,
  }));
  scene3.add(glow);

  // ── 狀態（同 map.mjs） ──
  let outline = EMPTY_OUTLINE;
  let options = { type: 'outline', borders: false, names: false, grid: false, cqZones: false, ituZones: false, states: false, locale: 'en' };
  // 圖層（add-map-overlays）：線先轉成 3D 點（同國界），每幀投影；Grid 依縮放等級與相機中心快取
  const zones = { cqZones: null, ituZones: null };
  const zones3d = { cqZones: [], ituZones: [] };
  let states = [];
  let states3d = [];
  let gridCache = { key: '', bounds: null, coarse: [], fine: [], labels: [] };
  // 放大後的向量圖（D14、D16）：各級資料；細節貼圖 { tex, region, tier, ppd, key, at }
  const detail = { '50m': { land: null, borders: null, states: null }, '10m': { land: null, borders: null, states: null } };
  const detail3d = { '50m': { borders: [], states: [] }, '10m': { borders: [], states: [] } };
  const detailReq = new Map(); // '50m:land' → { failedAt }（detail.canRequest：失敗 30 秒後再試）
  let detailTimer = 0; // 下載失敗後到時間再排一次重畫
  let detailTex = null;
  let detailInfo = { pxPerDeg: 0, tier: null, fade: 0, target: 0, partial: false, region: null, builds: 0, releases: 0, tex: null };
  let detailMixAt = 0; // 上次更新顯示淡化比例的時間（漸變用）
  let detailBuildTimer = 0; // 移動中略過重畫時，停手後補畫
  let detailReleaseTimer = 0;
  let lastManualAt = -Infinity; // 手動拖曳／縮放的時間（重畫限流）
  // 圖層線（州界、國界、Grid、Zone）的離屏快取：相機、尺寸、設定沒變就直接貼（C3：連線動畫每幀不必重投影）
  let linesCanvas = null;
  let linesKey = '';
  let linesDraws = 0;
  let selectedAt = null; // 選取的時間：閃 SELECT_PULSE_LIMIT_MS 後改靜態粗環（C3）
  let pulseTimer = 0;
  let overlayInfo = { gridLevel: 0, gridTexts: [], zoneTexts: { cqZones: [], ituZones: [] } };
  let basemapImg = null;
  let outlineTex = null;
  let imageTex = null;
  let borders = [];
  let borders3d = []; // 國界折線的 3D 點（Float32Array x, y, z, …），overlay 每幀投影
  let sunMinute = -1;
  let terminator3d = []; // 晨昏線的 3D 點（overlay 投影）
  let liftCap = ARC_MAX_LIFT; // 弧線抬高上限（依相機距離，arcLiftCap）：拉近時壓低，弧頂不碰相機
  let countries = [];
  let namesShown = 0;
  let me = null;
  let stations = [];
  let target = null;
  let selected = null; // 清單左鍵選取的電台（add-map-overlays E，同 2D）
  let scene = null;
  let links = [];
  let ripples = new Set();
  const births = new Map();
  const linkKey = (l) => `${l.from}>${l.to}@${l.utc}`;
  let linkObjs = []; // [{ base, anim, born, segments }]
  let routeObjs = []; // [{ mesh, pts }]：pts＝3D 點，overlay 光點用
  let route1 = null; // 我方→對方 3D 點
  let route2 = null; // 對方→第三台
  let cam = null;
  let userMoved = false;
  let resumeMs = 30_000; // 使用者動過、停手這麼久後恢復自動框住（同 2D）
  let resumeTimer = 0;
  let inertia = null; // 拖曳慣性：globemath.startInertia 的狀態＋上一步時間 { state, last }
  let dragSamples = []; // 拖曳中的相機中心 [{ t, lat, lon }]
  let flight = null; // { path, to, start }
  let pending = null; // 等待穩定的新目標（globemath.debounceGoal）{ to, since }
  let pendingTimer = 0;
  let flyNow = false; // 使用者按「框住」或停手後恢復：不必等目標穩定
  let fitNext = null; // 自動框住的目標（輸入沒變就不重算，飛行中每幀只算路徑）
  let fitDirty = true;
  let linkRebuilds = 0; // 自動化檢查用：弧線重建次數；飛行中因距離分級重建的次數（應為 0）
  let flightRebuilds = 0;
  let flights = 0; // 起飛（含中途換目標）次數
  let overviews = 0; // 兩段式飛行（先看全世界，map-fly-overview）次數；第一段／停留中換終點的次數（不算起飛）
  let overviewRetargets = 0;
  let fitSize = '';
  let size = { w: 0, h: 0, dpr: 1 };
  let points = []; // overlay 上的標點（點選用）：[{ call, x, y, kind, approx }]
  let colorsCache = null;
  let frame = 0;
  let anim = 0;
  let lastFrame = 0;
  let onScreen = true;
  let destroyed = false;
  let renders = 0;
  let picked = null; // 最後一次點選的呼號（自動化檢查用）
  let namesText = [];
  let selectedShown = null; // 最後一次畫出來的選取電台（自動化檢查用；在背面就是 null）
  // 線上衛星圖磚：選了 eox 才建立來源；eoxBase＝全球貼圖 { canvas, tex, at, drawn, dark }
  // eoxUnder＝全球貼圖墊底的 1:110m 向量簡圖（畫一次存著，重畫全球貼圖時 drawImage；全球貼圖畫齊就釋放）
  let eox = null;
  let eoxUnsub = null;
  let eoxBase = null;
  let eoxUnder = null;
  let eoxBaseTimer = 0;
  let eoxIdleTimer = 0;
  let eoxCamKey = '';
  let eoxCamAt = 0;
  let eoxInfo = { on: false, status: 'off', baseDrawn: 0, baseBuilds: 0, z: null, tiles: 0, drawn: 0, fallback: 0, missing: 0, detailBuilds: 0 };
  const EOX_BASE_TILES = visibleTiles(WORLD, EOX_BASE_Z); // 全球貼圖的 16 張 z2
  const eoxUp = () => Boolean(eox) && eox.status !== 'down';
  function useEox(on) {
    if (on && !eox) {
      eox = eoxSource();
      eoxUnsub = eox.subscribe(() => schedule());
    } else if (!on && eox) {
      eoxUnsub?.();
      eoxUnsub = null;
      eox.cancel(); // 切到其他底圖：不再請求
      eox = null;
      releaseEoxBase();
    }
  }
  function releaseEoxUnder() {
    if (!eoxUnder) return;
    eoxUnder.canvas.width = 0;
    eoxUnder = null;
  }
  function releaseEoxBase() {
    clearTimeout(eoxBaseTimer);
    releaseEoxUnder();
    if (!eoxBase) return;
    eoxBase.tex.dispose();
    eoxBase.canvas.width = 0;
    eoxBase = null;
  }

  loadOutline(outlineUrl).then((rings) => {
    if (destroyed) return; // 卸載後才載好：renderer 已經釋放，不再建貼圖
    outline = rings;
    outlineTex?.dispose();
    outlineTex = null;
    applyTexture();
    schedule();
  });

  function colors() {
    const cs = getComputedStyle(canvas);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
      sea: v('--globe-sea', v('--map-sea', '#B9D9F0')), land: v('--globe-land', v('--map-land', '#F2F1EA')), coast: v('--globe-coast', v('--map-coast', '#8A96A3')),
      ink: v('--map-ink', '#141D28'), halo: v('--map-halo', '#FFFFFF'), other: v('--map-other', '#556170'),
      cq: v('--map-cq', '#137A3A'), me: v('--map-callme', '#C0247D'), selected: v('--map-selected', '#1F5FD6'),
      border: v('--globe-border', v('--map-border', '#8F7F96')), borderOnImage: v('--map-border-img', 'rgba(255,255,255,0.75)'),
      name: v('--map-name', '#4A5563'), nameHalo: v('--map-name-halo', 'rgba(255,255,255,0.85)'),
      nameOnImage: v('--map-name-img', '#FFFFFF'), nameHaloOnImage: v('--map-name-halo-img', 'rgba(0,0,0,0.55)'),
      glow: v('--globe-glow', '#7FB2FF'), glowStrength: Number(v('--globe-glow-strength', '0.9')) || 0.9,
      ink3d: v('--globe-route', v('--map-ink', '#141D28')),
    };
  }
  const rgb = (css) => {
    const c = new THREE.Color();
    c.setStyle(css, THREE.NoColorSpace); // shader 不做色彩空間轉換：直接用 sRGB 值
    return new THREE.Vector3(c.r, c.g, c.b);
  };

  // 簡圖貼圖：陸地輪廓畫進等距圓柱 canvas（同 2D 配色），深淺色切換時重畫
  function makeOutlineTexture(c) {
    const W = phone ? 2048 : 4096;
    const H = W / 2;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    paintOutline(cv.getContext('2d'), W, H, c);
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }
  function paintOutline(g, W, H, c) {
    g.fillStyle = c.sea;
    g.fillRect(0, 0, W, H);
    const land = new Path2D();
    for (const ring of outline) {
      for (let i = 0; i < ring.length; i += 2) {
        const x = ((ring[i] + 180) / 360) * W;
        const y = ((90 - ring[i + 1]) / 180) * H;
        if (i === 0) land.moveTo(x, y);
        else land.lineTo(x, y);
      }
      land.closePath();
    }
    g.fillStyle = c.land;
    g.fill(land, 'evenodd');
    g.strokeStyle = c.coast;
    g.lineWidth = W / 4096 * 1.6;
    g.stroke(land);
  }

  // 全球貼圖（D8）：先畫向量簡圖（衛星色調；±85.05° 以外就是它），再畫 z2 圖磚（已重投影成等距圓柱）。圖磚陸續到達時重畫
  function eoxBaseRect(W, H) {
    return (b) => ({ x: ((b.w + 180) / 360) * W, y: ((90 - b.n) / 180) * H, w: ((b.e - b.w) / 360) * W + 0.5, h: ((b.n - b.s) / 180) * H + 0.5 });
  }
  function buildEoxBase(now) {
    const W = phone ? 1024 : 2048;
    const H = W / 2;
    const cv = eoxBase?.canvas ?? document.createElement('canvas');
    if (cv.width !== W) {
      cv.width = W;
      cv.height = H;
    }
    const g = cv.getContext('2d');
    const dark = isDarkTheme();
    // 墊底的向量簡圖：同大小、同主題時沿用畫好的離屏 canvas（code review 2：不每次重畫 1:110m 陸地）
    if (!eoxUnder || eoxUnder.w !== W || eoxUnder.dark !== dark) {
      const under = eoxUnder?.canvas ?? document.createElement('canvas');
      under.width = W;
      under.height = H;
      const pal = vectorPalette('eox', dark);
      paintOutline(under.getContext('2d'), W, H, { sea: pal.sea, land: pal.land, coast: pal.coast });
      eoxUnder = { canvas: under, w: W, dark };
    }
    g.drawImage(eoxUnder.canvas, 0, 0);
    g.imageSmoothingQuality = 'high';
    const r = drawTileSet(g, EOX_BASE_TILES, eox, eoxBaseRect(W, H), EOX_BASE_Z);
    if (!eoxBase) {
      const tex = new THREE.CanvasTexture(cv);
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      eoxBase = { canvas: cv, tex };
    } else eoxBase.tex.needsUpdate = true;
    Object.assign(eoxBase, { at: now, drawn: r.drawn, dark, source: eox.sourceKey }); // source：換線上地圖來源時重建（add-map-tile-source S7）
    eoxInfo = { ...eoxInfo, baseBuilds: eoxInfo.baseBuilds + 1 };
    if (r.drawn === EOX_BASE_TILES.length) releaseEoxUnder(); // 畫齊了：之後只有換主題才重畫
  }
  /** 快取裡有幾張全球貼圖要的 z2（只看這個判斷要不要重畫：細節圖磚到達不重畫全球貼圖） */
  const eoxBaseHave = () => EOX_BASE_TILES.reduce((n, t) => n + (eox.has(`${t.z}/${t.x}/${t.y}`) ? 1 : 0), 0);
  // 每幀：全球貼圖沒畫齊而且有新的 z2 圖磚到就重畫（限流）；連不上時換回簡圖貼圖、恢復時換回來
  function syncEoxBase(now) {
    const want = eoxUp();
    if (want) {
      const stale = !eoxBase || eoxBase.dark !== isDarkTheme() || eoxBase.source !== eox.sourceKey || (eoxBase.drawn < EOX_BASE_TILES.length && eoxBaseHave() > eoxBase.drawn);
      if (stale && (!eoxBase || now - eoxBase.at >= DETAIL_BUSY_MS)) buildEoxBase(now);
      else if (stale) {
        clearTimeout(eoxBaseTimer);
        eoxBaseTimer = setTimeout(schedule, DETAIL_BUSY_MS);
      }
    }
    const tex = want ? eoxBase?.tex : null;
    if ((options.type === 'eox') && uniforms.tex.value !== (tex ?? outlineTex)) applyTexture();
  }

  function applyTexture() {
    const c = colorsCache ?? colors();
    uniforms.sea.value = rgb(c.sea);
    // 影像還在載入或載入失敗：先用簡圖貼圖（同 2D），色調也用簡圖的
    if (!outlineTex && outline.length && (options.type === 'outline' || !imageTex)) outlineTex = makeOutlineTexture(c);
    const eoxTex = options.type === 'eox' && eoxUp() ? eoxBase?.tex : null;
    const useImage = (options.type === 'satellite' || options.type === 'relief') && imageTex;
    const tone = useImage || eoxTex ? (TONE[options.type] ?? TONE.outline) : TONE.outline;
    uniforms.gamma.value = tone.gamma;
    uniforms.gain.value = tone.gain;
    uniforms.haze.value = tone.haze;
    uniforms.tex.value = eoxTex ?? (useImage ? imageTex : outlineTex);
    uniforms.hasMap.value = uniforms.tex.value ? 1 : 0;
  }

  function setImage(img) {
    imageTex?.dispose();
    imageTex = null;
    basemapImg = img;
    if (img) {
      imageTex = new THREE.Texture(img);
      imageTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      imageTex.needsUpdate = true;
    }
    applyTexture();
    schedule();
  }

  // 國界與圖層：經緯度 → 3D 點只算一次（帶經緯度範圍，放大時只投影看得到的）；只畫正面
  const to3d = (lines) => lines.map((it) => {
    const line = ArrayBuffer.isView(it) ? it : it.pts;
    const f = new Float32Array((line.length / 2) * 3);
    for (let i = 0, j = 0; i < line.length; i += 2, j += 3) f.set(latLonToVec3(line[i + 1], line[i]), j);
    const b = ArrayBuffer.isView(it) ? boxOf(it) : it;
    return { f3: f, w: b.w, s: b.s, e: b.e, n: b.n };
  });
  function rebuildBorders() {
    borders3d = to3d(borders);
  }
  // Grid 格線（3D）：2 碼畫全球；4 碼只畫相機中心附近（overlays.globeGridBounds：高緯度往東西放寬、中心取整），標籤一起快取（C3、C6）
  function gridFor(level, span) {
    const bounds = globeGridBounds(level, cam, span);
    if (gridCache.key !== bounds.key) {
      const g = gridLines(bounds, level, GRID_SAMPLE_DEG);
      gridCache = { key: bounds.key, bounds, coarse: to3d(g.coarse), fine: to3d(g.fine), labels: gridLabels(bounds, level) };
    }
    return gridCache;
  }
  // 圖層線畫進離屏 canvas（g）；州界在國界下面，Grid、Zone 在上面（同 2D）
  function drawLineLayers(g, camPos, c, bgType, dark, level, span, bounds, ppd) {
    const stTier = readyTier(ppd, readyOf('states'));
    const st = stTier === '10m' ? detail3d['10m'].states : states3d;
    if (options.states && st.length) strokeLines3d(g, st, overlayStyle('states', bgType, dark), camPos, bounds);
    const bTier = readyTier(ppd, readyOf('borders'));
    const bl = bTier ? detail3d[bTier].borders : borders3d;
    if (options.borders && bl.length) strokeLines3d(g, bl, borderStyle(bgType, dark).map((p) => ({ ...p, color: p.color ?? c.border })), camPos, bounds);
    if (options.grid) {
      const gr = gridFor(level, span);
      const passes = overlayStyle('grid', bgType, dark);
      if (gr.fine.length) {
        g.globalAlpha = FINE_GRID_ALPHA;
        strokeLines3d(g, gr.fine, passes, camPos, bounds);
        g.globalAlpha = 1;
      }
      strokeLines3d(g, gr.coarse, level === 4 ? passes.map((p) => ({ ...p, width: p.width + 0.7 })) : passes, camPos, bounds);
    }
    for (const layer of ['cqZones', 'ituZones']) if (options[layer] && zones3d[layer].length) strokeLines3d(g, zones3d[layer], overlayStyle(layer, bgType, dark), camPos, bounds);
  }
  // 區號與 Grid 標籤（同 2D：置中、放得下才寫、避開呼號與標點；只寫正面 facing 0.3 以上的）
  function overlayLabels(avoid, camPos, bgType, dark, level, span) {
    const { w, h } = size;
    const info = { gridLevel: options.grid ? level : 0, gridTexts: [], zoneTexts: { cqZones: [], ituZones: [] } };
    const write = (placed, layer, fontPx, weight, alpha) => {
      const st = overlayLabelStyle(layer, bgType, dark);
      octx.font = `${weight} ${fontPx}px system-ui, sans-serif`;
      octx.textBaseline = 'top';
      octx.lineJoin = 'round';
      octx.globalAlpha = alpha;
      for (const n of placed) {
        octx.lineWidth = 2.5;
        octx.strokeStyle = st.halo;
        octx.strokeText(n.text, n.x + 1, n.y + 1);
        octx.fillStyle = st.fill;
        octx.fillText(n.text, n.x + 1, n.y + 1);
      }
      octx.globalAlpha = 1;
    };
    const visible = (list) => {
      const out = [];
      for (const it of list) {
        const v = latLonToVec3(it.lat, it.lon);
        if (facing(v, camPos, 0.3)) out.push({ ...it, ...toScreen(v) });
      }
      return out;
    };
    for (const layer of ['cqZones', 'ituZones']) {
      if (!options[layer] || !zones[layer]?.labels.length) continue;
      const items = visible(zones[layer].labels.map((z) => ({ id: `${layer}${z.n}`, text: String(z.n), lat: z.lat, lon: z.lon })));
      octx.font = `700 ${ZONE_FONT_PX}px system-ui, sans-serif`;
      const placed = placeCountryNames(items, { width: w, height: h, measure: (t) => octx.measureText(t).width, fontPx: ZONE_FONT_PX, avoid, pad: 2, max: 120 });
      write(placed, layer, ZONE_FONT_PX, 700, 0.8);
      avoid.push(...placed);
      info.zoneTexts[layer] = placed.map((p) => p.text);
    }
    if (options.grid) {
      const g = gridFor(level, span);
      const items = visible(g.labels.map((x) => ({ id: x.text, ...x })));
      octx.font = `500 ${GRID_FONT_PX}px system-ui, sans-serif`;
      const placed = placeCountryNames(items, { width: w, height: h, measure: (t) => octx.measureText(t).width, fontPx: GRID_FONT_PX, avoid, pad: 2, max: 400 });
      write(placed, 'grid', GRID_FONT_PX, 500, 0.7);
      info.gridTexts = placed.map((p) => p.text);
    }
    overlayInfo = info;
  }
  // bounds（看得到的經緯度範圍，可為 null）：範圍外的線整條略過（放大時 1:10m 國界、州界十幾萬點，不必每次都投影）
  function strokeLines3d(g, lines3d, passes, camPos, bounds = null) {
    const path = new Path2D();
    const p = [0, 0, 0];
    const pad = bounds ? Math.max(1, (bounds.north - bounds.south) * 0.05) : 0;
    for (const it of lines3d) {
      if (bounds && (it.s > bounds.north + pad || it.n < bounds.south - pad)) continue;
      if (bounds && bounds.east - bounds.west < 360) {
        const off = 360 * Math.round(((bounds.west + bounds.east) / 2 - (it.w + it.e) / 2) / 360);
        if (it.w + off > bounds.east + pad || it.e + off < bounds.west - pad) continue;
      }
      const f = it.f3;
      let pen = false;
      for (let j = 0; j < f.length; j += 3) {
        p[0] = f[j];
        p[1] = f[j + 1];
        p[2] = f[j + 2];
        if (!facing(p, camPos, 0.12)) { // 地平線附近擠成一團：不畫
          pen = false;
          continue;
        }
        const s = toScreen(p);
        if (pen) path.lineTo(s.x, s.y);
        else path.moveTo(s.x, s.y);
        pen = true;
      }
    }
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const pass of passes) {
      g.setLineDash(pass.dash ?? []);
      g.strokeStyle = pass.color;
      g.lineWidth = pass.width;
      g.stroke(path);
    }
    g.setLineDash([]);
    g.lineCap = 'butt';
  }
  // 放大後的向量圖：放大到該級才下載（同 2D）；載入失敗 DETAIL_RETRY_MS（30 秒）後再試，時間到排一次重畫（D19 a）
  function ensureDetail(ppd) {
    for (const tier of tiersToLoad(ppd)) {
      const kinds = ['land'];
      if (options.borders) kinds.push('borders');
      if (options.states && tier === '10m') kinds.push('states');
      for (const kind of kinds) {
        const key = `${tier}:${kind}`;
        if (!canRequest(detailReq, key, performance.now())) continue;
        detailReq.set(key, { failedAt: null });
        loadDetail(tier, kind).then((d) => {
          if (destroyed) return;
          if (!(kind === 'land' ? d.rings.length : d.length)) {
            detailReq.set(key, { failedAt: performance.now() });
            clearTimeout(detailTimer);
            detailTimer = setTimeout(schedule, DETAIL_RETRY_MS + 50);
            return;
          }
          detail[tier][kind] = d;
          if (kind !== 'land') detail3d[tier][kind] = to3d(d);
          schedule();
        });
      }
    }
  }
  const readyOf = (kind) => new Set(Object.keys(detail).filter((t) => detail[t][kind]));
  // 細節貼圖（D16）：看得到的範圍外加一半當邊，畫成等距圓柱 canvas（每度像素約等於畫面），交給 shader 與底圖交叉淡化。
  // 看得到的範圍跑出貼圖、縮放差太多（解析度不夠或浪費）、換底圖、深淺色或像素比才重畫；
  // 移動中（飛行、慣性、手動拖曳／縮放）最多每 DETAIL_BUSY_MS 重畫一次，略過的那次停手後補畫（D19 b）。
  // 四角看得到太空時（寬畫面放大到一半）以相機中心估範圍（centerBounds3d）先建貼圖：shader 只在貼圖範圍內混合、太空本來不畫，
  // 淡化照樣隨縮放一路做，不會等到地球填滿畫面那一幀才同步建 4096² 貼圖、一次跳成向量圖（D19 #2）
  const maxTex = Math.min(phone ? 2048 : 4096, renderer.capabilities.maxTextureSize || 4096);
  const texSide = (v) => Math.min(maxTex, Math.max(512, Math.ceil(Math.max(1, v) / DETAIL_TEX_STEP) * DETAIL_TEX_STEP));
  function updateDetail(ppd, now) {
    const tier = readyTier(ppd, readyOf('land'));
    let target = tier ? vectorFade(ppd) : 0;
    let need = null;
    let partial = false;
    if (target > 0) {
      need = visibleBounds3d(cam, { fovDeg: FOV, aspect: size.w / size.h });
      if (!need) {
        need = centerBounds3d(cam, { pxPerDeg: ppd, width: size.w, height: size.h });
        partial = true;
      }
    }
    const dark = isDarkTheme();
    const key = `${tier}|${options.type}|${Boolean(imageTex)}|${dark}|${size.dpr}`; // 影像載好後配色會換（衛星／地形配色），要重畫
    const stale = target > 0 && (!detailTex || detailTex.key !== key || !regionCovers(detailTex.region, need) || detailTex.ppd < ppd * 0.7 || detailTex.ppd > ppd * 2.5);
    const moving = Boolean(flight || inertia) || now - lastManualAt < DETAIL_BUSY_MS;
    const busy = moving && detailTex && now - detailTex.at < DETAIL_BUSY_MS;
    if (stale && !busy) buildDetail(regionFor(need, 0.5), tier, ppd, key, dark, now);
    else if (stale) {
      clearTimeout(detailBuildTimer);
      detailBuildTimer = setTimeout(schedule, DETAIL_BUSY_MS);
    }
    if (!detailTex || detailTex.key !== key) target = 0;
    rampDetail(target, now, partial, ppd);
  }
  // 顯示的淡化比例往目標漸變（每幀最多算 50 ms：閒置很久後的第一幀也不會一次跳到底）；降到 0 一段時間後釋放
  function rampDetail(target, now, partial, ppd) {
    const step = Math.min(50, Math.max(0, now - detailMixAt)) / DETAIL_RAMP_MS;
    detailMixAt = now;
    const cur = uniforms.detailMix.value;
    const mix = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step;
    uniforms.detailMix.value = mix;
    // 不再需要細節貼圖：一段時間後釋放畫布與 GPU 貼圖（4096² 約 64 MB）
    if (target === 0 && mix === 0 && detailTex && !detailReleaseTimer) detailReleaseTimer = setTimeout(releaseDetail, DETAIL_RELEASE_MS);
    else if ((target > 0 || mix > 0) && detailReleaseTimer) {
      clearTimeout(detailReleaseTimer);
      detailReleaseTimer = 0;
    }
    detailInfo = { pxPerDeg: ppd, tier: mix > 0 ? detailTex.tier : null, fade: mix, target, partial, region: detailTex?.region ?? null,
      builds: detailInfo.builds, releases: detailInfo.releases, tex: detailTex ? [detailTex.w, detailTex.h] : null };
  }
  function releaseDetail() {
    detailReleaseTimer = 0;
    if (!detailTex || uniforms.detailMix.value > 0 || destroyed) return;
    detailTex.tex.dispose();
    detailTex.canvas.width = 0;
    detailTex.canvas.height = 0;
    detailTex = null;
    uniforms.detailTex.value = null;
    detailInfo = { ...detailInfo, region: null, tex: null, releases: detailInfo.releases + 1 };
  }
  function buildDetail(region, tier, ppd, key, dark, now) {
    const dLon = region.east - region.west;
    const dLat = region.north - region.south;
    const dpr = size.dpr;
    const midLat = (region.north + region.south) / 2;
    const W = texSide(ppd * dpr * dLon * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
    const H = texSide(ppd * dpr * dLat);
    const cv = detailTex?.canvas ?? document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    const c = colorsCache ?? colors();
    const pal = options.type !== 'outline' && imageTex ? vectorPalette(options.type, dark) : null;
    const ax = W / dLon, dy = -H / dLat;
    const lp = visibleLandPaths(detail[tier].land, region, [-360, 0, 360], 0.5, (off) => affine(ax, -region.west * ax, dy, region.north * H / dLat, off));
    g.fillStyle = pal?.sea ?? c.sea;
    g.fillRect(0, 0, W, H);
    g.fillStyle = pal?.land ?? c.land;
    g.fill(lp.fill, 'evenodd');
    g.strokeStyle = pal?.coast ?? c.coast;
    g.lineWidth = Math.min(3, Math.max(0.6, (0.9 * (H / dLat)) / ppd));
    g.lineJoin = 'round';
    g.stroke(lp.coast);
    commitDetail(cv, region, W, H, { tier, ppd, key, at: now });
  }
  // 細節貼圖畫好之後交給 GPU（向量圖與線上圖磚共用）
  function commitDetail(cv, region, W, H, meta) {
    if (!detailTex) {
      const tex = new THREE.CanvasTexture(cv);
      tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      detailTex = { tex, canvas: cv };
      uniforms.detailTex.value = tex;
    } else {
      // 尺寸變了要換一張貼圖（WebGL 不能就地改大小）
      if (detailTex.w !== W || detailTex.h !== H) {
        detailTex.tex.dispose();
        detailTex.tex = new THREE.CanvasTexture(cv);
        detailTex.tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        uniforms.detailTex.value = detailTex.tex;
      }
      detailTex.tex.needsUpdate = true;
    }
    Object.assign(detailTex, { region, ...meta, w: W, h: H });
    uniforms.detailRect.value.set(region.west, region.south, region.east - region.west, region.north - region.south);
    detailInfo.builds++;
  }

  // 線上圖磚的細節貼圖（D9）：看得到的範圍每邊加 1/4，先以全球貼圖墊底，再畫該層級的圖磚（缺的用快取裡的祖先）。
  // 只請求看得到範圍內的格（邊緣多的部分用快取裡有的）；新圖磚到達、範圍跑出貼圖、層級變了才重畫（移動中限流同 D16）。
  // 回傳要請求的格（排在全球貼圖的格前面）
  function updateEoxDetail(ppd, now) {
    let target = ppd * size.dpr > EOX_DETAIL_PPD ? 1 : 0;
    let need = null;
    let partial = false;
    let z = null;
    let tiles = [];
    if (target) {
      need = visibleBounds3d(cam, { fovDeg: FOV, aspect: size.w / size.h });
      if (!need) {
        need = centerBounds3d(cam, { pxPerDeg: ppd, width: size.w, height: size.h });
        partial = true;
      }
      const lonPpd = ppd * Math.max(0.2, Math.cos((((need.north + need.south) / 2) * Math.PI) / 180));
      ({ z, tiles } = tilesFor(need, lonPpd, size.dpr, { maxZ: eox?.maxZ }));
    }
    const dark = isDarkTheme();
    const key = `eox|${eox.sourceKey}|${z}|${dark}|${size.dpr}`; // 換來源（add-map-tile-source S7）就重畫
    const fresh = detailTex && detailTex.key === key;
    const stale = target > 0 && (!fresh || !regionCovers(detailTex.region, need) || detailTex.ppd < ppd * 0.7 || detailTex.ppd > ppd * 2.5
      || (detailTex.missing > 0 && detailTex.gen !== eox.generation));
    const moving = Boolean(flight || inertia) || now - lastManualAt < DETAIL_BUSY_MS;
    const busy = (moving || detailTex?.key === key) && detailTex && now - detailTex.at < DETAIL_BUSY_MS;
    if (stale && !busy) buildEoxDetail(regionFor(need, 0.25), z, ppd, key, now, tiles);
    else if (stale) {
      clearTimeout(detailBuildTimer);
      detailBuildTimer = setTimeout(schedule, DETAIL_BUSY_MS);
    }
    if (!detailTex || detailTex.key !== key) target = 0;
    rampDetail(target, now, partial, ppd);
    return tiles;
  }
  function buildEoxDetail(region, z, ppd, key, now, visible) {
    const dLon = region.east - region.west;
    const dLat = region.north - region.south;
    const midLat = (region.north + region.south) / 2;
    const W = texSide(ppd * size.dpr * dLon * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
    const H = texSide(ppd * size.dpr * dLat);
    const cv = detailTex?.canvas ?? document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    const ax = W / dLon, ay = H / dLat;
    g.imageSmoothingQuality = 'high';
    // 墊底：全球貼圖（含極區向量圖）依範圍裁切放大；經度 ±360° 副本（範圍是展開值）
    if (eoxBase) {
      for (const off of [-360, 0, 360]) {
        const x0 = (-180 + off - region.west) * ax;
        if (x0 > W || x0 + 360 * ax < 0) continue;
        g.drawImage(eoxBase.canvas, x0, (region.north - 90) * ay, 360 * ax, 180 * ay);
      }
    } else {
      g.fillStyle = vectorPalette('eox', isDarkTheme()).sea;
      g.fillRect(0, 0, W, H);
    }
    // 範圍內的格太多（邊緣）就只畫看得到的那些；缺的用祖先
    const list = tileCount(region, z) <= MAX_VIEW_TILES * 3 ? visibleTiles(region, z) : visible;
    const r = drawTileSet(g, list, eox, (b) => ({ x: (b.w - region.west) * ax, y: (region.north - b.n) * ay, w: (b.e - b.w) * ax + 0.5, h: (b.n - b.s) * ay + 0.5 }), EOX_BASE_Z);
    commitDetail(cv, region, W, H, { tier: `eox-z${z}`, ppd, key, at: now, gen: eox.generation, missing: r.missing });
    eoxInfo = { ...eoxInfo, z, drawn: r.drawn, fallback: r.fallback, missing: r.missing, detailBuilds: eoxInfo.detailBuilds + 1 };
  }
  function drawTerminator(camPos) {
    const path = new Path2D();
    let pen = false;
    for (const p of terminator3d) {
      if (!facing(p, camPos, 0.02)) {
        pen = false;
        continue;
      }
      const s = toScreen(p);
      if (pen) path.lineTo(s.x, s.y);
      else path.moveTo(s.x, s.y);
      pen = true;
    }
    octx.strokeStyle = TERMINATOR_COLOR;
    octx.lineWidth = 1.2;
    octx.stroke(path);
  }
  // 太陽直射點每分鐘更新一次（只在畫的時候算）
  function updateSun(nowMs) {
    uniforms.dayNight.value = options.daynight ? 1 : 0;
    if (!options.daynight) return;
    const minute = Math.floor(nowMs / SUN_MS);
    if (minute === sunMinute) return;
    sunMinute = minute;
    const sub = subsolarPoint(nowMs);
    uniforms.sunDir.value.set(...latLonToVec3(sub.lat, sub.lon));
    terminator3d = terminatorPoints(sub, 2).map((p) => latLonToVec3(p.lat, p.lon));
  }

  // ── 弧線與航線（TubeGeometry；動畫層用 drawRange 延伸） ──
  function tube(pts, radius) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    return new THREE.TubeGeometry(curve, ARC_SEGMENTS, radius, ARC_RADIAL, false);
  }
  function disposeObj(o) {
    scene3.remove(o);
    o.geometry?.dispose();
    o.material?.dispose();
  }
  function rebuildLinks() {
    linkRebuilds++;
    for (const l of linkObjs) {
      disposeObj(l.base);
      disposeObj(l.anim);
    }
    linkObjs = [];
    const c = colorsCache ?? colors();
    for (const l of links) {
      const approx = l.a.approx || l.b.approx;
      const geo = tube(arcPoints(l.a, l.b, ARC_SEGMENTS, { maxLift: liftCap }), approx ? 0.0032 : 0.0045);
      const color = new THREE.Color(l.toMe ? c.me : c.other);
      const base = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: reducedMotion?.matches ? 0.75 : LINK_BASE_ALPHA * (approx ? 0.7 : 1), depthWrite: false }));
      const animMesh = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }));
      animMesh.visible = false;
      scene3.add(base, animMesh);
      linkObjs.push({ base, anim: animMesh, born: births.get(linkKey(l)) ?? 0 });
    }
  }
  function rebuildRoutes() {
    for (const r of routeObjs) disposeObj(r.mesh);
    routeObjs = [];
    route1 = route2 = null;
    const c = colorsCache ?? colors();
    if (scene?.me && scene.them) {
      route1 = arcPoints(scene.me, scene.them, ARC_SEGMENTS, { maxLift: liftCap });
      const approx = scene.me.approx || scene.them.approx;
      const mesh = new THREE.Mesh(tube(route1, 0.0065), new THREE.MeshBasicMaterial({ color: new THREE.Color(c.ink3d), transparent: approx, opacity: approx ? 0.6 : 1 }));
      scene3.add(mesh);
      routeObjs.push({ mesh });
    }
    if (scene?.them && scene.third) {
      route2 = arcPoints(scene.them, scene.third, ARC_SEGMENTS, { maxLift: liftCap });
      const mesh = new THREE.Mesh(tube(route2, 0.004), new THREE.MeshBasicMaterial({ color: new THREE.Color(c.other), transparent: true, opacity: 0.8 }));
      scene3.add(mesh);
      routeObjs.push({ mesh });
    }
  }

  function applyTheme() {
    colorsCache = colors();
    const c = colorsCache;
    glowUniforms.glow.value = rgb(c.glow);
    glowUniforms.strength.value = c.glowStrength;
    outlineTex?.dispose();
    outlineTex = null;
    applyTexture();
    rebuildLinks();
    rebuildRoutes();
  }

  function located() {
    const out = [];
    for (const s of stations) {
      const pos = locate(s, approxLocate);
      if (pos) out.push({ ...s, ...pos, kind: kindOf(s, target) });
    }
    return out.sort(byPriority);
  }

  function fitTarget() {
    if (fitNext && !fitDirty) return fitNext;
    const pts = located().map((p) => ({ lat: p.lat, lon: p.lon }));
    const routes = [...links];
    if (scene?.me && scene.them) routes.push({ a: scene.me, b: scene.them });
    if (scene?.them && scene.third) routes.push({ a: scene.them, b: scene.third });
    // 弧線高高拱起：取樣點帶離地高度，弧頂也框進畫面
    for (const r of routes) if (r?.a && r?.b) pts.push(...arcFramePoints(r.a, r.b));
    if (me) pts.unshift(me);
    fitNext = fitGlobe(pts, { fovDeg: FOV, aspect: size.w / size.h });
    fitDirty = false;
    return fitNext;
  }
  const same = (a, b) => globeNearlySame(a, b, { fovDeg: FOV });

  function autoFit() {
    if (!size.w || !size.h) return;
    const next = fitTarget();
    const sizeKey = `${size.w}x${size.h}`;
    const now = performance.now();
    if (!cam || sizeKey !== fitSize || reducedMotion?.matches) {
      fitSize = sizeKey;
      flight = null;
      pending = null;
      cam = next;
      return;
    }
    // 新目標要穩定一下才飛（電台陸續進來時不會一直換方向）；飛行中目標仍差不多就不重飛
    const r = debounceGoal(pending, next, now, { goal: flight?.to ?? cam, same, ...(flyNow ? { delayMs: 0 } : {}) });
    flyNow = false;
    pending = r.pending;
    clearTimeout(pendingTimer);
    if (pending) pendingTimer = setTimeout(schedule, r.waitMs + 1); // 沒有動畫在跑時也要準時起飛
    if (r.fire) startFlight(r.fire, now);
    if (!flight) return;
    const t = (now - flight.start) / flight.path.durationMs;
    cam = flight.path.at(t);
    if (t >= 1) flight = null;
  }

  // 起飛（map-fly-overview）：兩段式飛行還在拉遠／停留中 → 只換第二段終點（不算起飛）；大幅移動 → 先拉到全世界、停一下、再轉過去拉近；
  // 其他（含兩段式的第二段中又換目標）→ 原本的單段飛行、延續目前的速度（不從靜止重來），這趟落地前不再拉回全世界
  function startFlight(to, now) {
    const aspect = size.w / size.h;
    const maxDist = maxDistFor(FOV, aspect);
    const fly = (a, b, o) => globeFly(a, b, { fovDeg: FOV, aspect, maxDist, ...o });
    let vel = null;
    let overviewed = false;
    if (flight) {
      const swapped = flight.path.overview ? flight.path.retarget(now - flight.start, to) : null;
      if (swapped) {
        flight = { ...flight, path: swapped, to };
        overviewRetargets++;
        lowerArcs(swapped);
        return;
      }
      const t = (now - flight.start) / flight.path.durationMs;
      cam = flight.path.at(t);
      vel = flight.path.velocity(t);
      overviewed = Boolean(flight.path.overview || flight.overviewed);
    }
    let path;
    if (!overviewed && bigMove3d(cam, to, { fovDeg: FOV, aspect, overviewDist: maxDist })) {
      path = overviewFlight(cam, worldCam3d(cam, maxDist), to, fly, { opts1: { vel } });
      overviews++;
    } else path = fly(cam, to, { vel });
    flight = path.durationMs > 0 ? { path, to, start: now, overviewed } : null;
    if (!flight) {
      cam = to;
      return;
    }
    flights++;
    lowerArcs(path);
  }

  // 往下飛得比弧頂低：起飛時就把弧線壓到整趟最低距離的級距（飛行中不重建；拉遠的那種等落地再升）
  function lowerArcs(path) {
    let minDist = Infinity;
    for (let i = 0; i <= 64; i++) minDist = Math.min(minDist, path.at(i / 64).dist);
    const cap = arcLiftCap(minDist);
    if (cap < liftCap) {
      liftCap = cap;
      rebuildLinks();
      rebuildRoutes();
    }
  }

  // 目前飛行的階段（自動化檢查用）：'out'、'hold'、'in'（兩段式），'fly'（單段），null（沒在飛）
  const flightStage = () => (!flight ? null : flight.path.stageAt?.(Math.min(1, (performance.now() - flight.start) / flight.path.durationMs)) ?? 'fly');

  // 3D → overlay 像素
  const v3 = new THREE.Vector3();
  function toScreen(p) {
    v3.set(p[0], p[1], p[2]).project(camera);
    return { x: (v3.x * 0.5 + 0.5) * size.w, y: (-v3.y * 0.5 + 0.5) * size.h };
  }

  function placeCamera() {
    const c = cameraPosition(cam);
    camera.position.set(c[0], c[1], c[2]);
    // 飛行中用路徑的上方向（整個姿態一起轉，過極區不扭）；平常北方朝上
    const up = flight && cam.up;
    if (up) camera.up.set(up[0], up[1], up[2]);
    else camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return c;
  }

  // ── 繪製：WebGL 一幀＋overlay ──
  function render(now = performance.now()) {
    const { w, h } = size;
    if (!w || !h || document.hidden || destroyed) {
      if (!w || !h) eox?.setVisible(false); // 地圖收起（大小 0）：線上圖磚暫停發請求（code review 9）
      return;
    }
    eox?.setVisible(onScreen);
    if (inertia) coast(now);
    if (!cam || !userMoved) autoFit();
    updateSun(Date.now());
    // 弧線抬高上限依相機距離分級；飛行中跨級不重建（每次重建都掉幀），落地後一次更新。
    // 往下飛的在起飛時已經壓低（autoFit）；保險：弧頂真的快碰到相機時仍立刻重建（flightRebuilds 記次數，應為 0）
    const cap = arcLiftCap(cam.dist);
    if (cap !== liftCap && (!flight || ARC_BASE + liftCap > cam.dist - 0.05)) {
      if (flight) flightRebuilds++;
      liftCap = cap;
      rebuildLinks();
      rebuildRoutes();
    }
    const camPos = placeCamera();
    const c = colorsCache ?? (colorsCache = colors());
    const reduce = reducedMotion?.matches;
    // 放大後的向量圖（D14、D16）：每度像素超過門檻時底圖淡出、細節貼圖淡入
    const ppd = globePxPerDeg(cam.dist, FOV, h);
    ensureDetail(ppd);
    if (eox) {
      // 線上圖磚（D8、D9）：全球貼圖＋細節貼圖；連不上（down）時同簡圖（向量細節）
      syncEoxBase(now);
      const up = eoxUp();
      const near = up ? updateEoxDetail(ppd, now) : (updateDetail(ppd, now), []);
      // 相機停住 EOX_IDLE_MS 才換請求清單（飛行、慣性、等待新目標穩定、手動移動中都不換；一開始只有我方時的近距離視野也不會先抓一批）
      const ck = `${cam.lat.toFixed(3)},${cam.lon.toFixed(3)},${cam.dist.toFixed(3)},${w}x${h}`;
      if (ck !== eoxCamKey) [eoxCamKey, eoxCamAt] = [ck, now];
      const idle = !flight && !inertia && !pending && now - lastManualAt >= EOX_IDLE_MS && now - eoxCamAt >= EOX_IDLE_MS;
      // 全球貼圖畫齊、主題也沒變：不必再要 z2（code review 7；之後被擠出快取也不影響已畫好的貼圖）
      const baseDone = eoxBase && eoxBase.drawn === EOX_BASE_TILES.length && eoxBase.dark === isDarkTheme() && eoxBase.source === eox.sourceKey;
      if (idle) eox.want(baseDone ? near : [...near, ...EOX_BASE_TILES]);
      else {
        clearTimeout(eoxIdleTimer);
        eoxIdleTimer = setTimeout(schedule, EOX_IDLE_MS + 20);
      }
      eoxInfo = { ...eoxInfo, on: true, status: eox.status, baseDrawn: eoxBase?.drawn ?? 0, tiles: near.length, moving: !idle, ...(up ? {} : { z: null }) };
    } else updateDetail(ppd, now);

    // 連線循環動畫（同 2D linkCycle）：drawRange 只畫到 f 的位置
    for (const l of linkObjs) {
      const cyc = reduce ? null : linkCycle(now, l.born);
      if (cyc && cyc.f > 0) {
        l.anim.visible = true;
        l.anim.material.opacity = cyc.alpha;
        l.anim.geometry.setDrawRange(0, Math.max(1, Math.floor(cyc.f * ARC_SEGMENTS)) * ARC_RADIAL * 6);
      } else l.anim.visible = false;
    }
    renderer.render(scene3, camera);
    renders++;

    // overlay
    octx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    octx.clearRect(0, 0, w, h);
    const list = located();
    points = [];
    for (const p of list) {
      const v = latLonToVec3(p.lat, p.lon);
      if (!facing(v, camPos)) continue;
      const s = toScreen(v);
      points.push({ call: p.call, x: s.x, y: s.y, kind: p.kind, approx: p.approx, lastUtc: p.lastUtc });
    }
    // 喊 CQ 的電台：同心圓擴散
    if (!reduce && ripples.size) {
      for (const p of points) if (ripples.has(p.call)) drawRipple(p.x, p.y, now, c.cq);
    }
    octx.font = `${FONT_PX}px system-ui, sans-serif`;
    const items = labelItems(selectedFirst(points, selected));
    const isSelText = (t) => Boolean(selected) && (t === selected || t.startsWith(`${selected} `));
    const measure = (t) => {
      if (!isSelText(t)) return octx.measureText(t).width;
      octx.font = `700 ${FONT_PX}px system-ui, sans-serif`;
      const wd = octx.measureText(t).width;
      octx.font = `${FONT_PX}px system-ui, sans-serif`;
      return wd;
    };
    const labels = placeLabels(items, { width: w, height: h, measure, fontPx: FONT_PX });
    let mePt = null;
    if (me) {
      const v = latLonToVec3(me.lat, me.lon);
      if (facing(v, camPos)) mePt = toScreen(v);
    }
    // 晨昏線、國界（在國名、標點下面）
    if (options.daynight && terminator3d.length) drawTerminator(camPos);
    // 圖層（add-map-overlays）：州界在國界下面，Grid、Zone 在上面（同 2D）；畫進離屏 canvas，相機與設定沒變就直接貼（C3）
    const dark = isDarkTheme();
    const bgType = (options.type === 'satellite' || options.type === 'relief') && imageTex ? options.type : eox && eoxUp() ? 'satellite' : 'outline';
    const span = globeLonSpan(cam.dist, FOV, w, h);
    const level = gridLevel(span);
    const lk = [cam.lat, cam.lon, cam.dist, cam.up?.join(','), w, h, size.dpr, options.type, options.borders, options.states, options.grid, options.cqZones, options.ituZones, dark, bgType,
      [...readyOf('borders')].join(), [...readyOf('states')].join(), borders3d.length, states3d.length, zones3d.cqZones.length, zones3d.ituZones.length].join('|');
    if (lk !== linesKey) {
      linesKey = lk;
      linesCanvas ??= document.createElement('canvas');
      if (linesCanvas.width !== overlay.width || linesCanvas.height !== overlay.height) {
        linesCanvas.width = overlay.width;
        linesCanvas.height = overlay.height;
      }
      const lg = linesCanvas.getContext('2d');
      lg.setTransform(1, 0, 0, 1, 0, 0);
      lg.clearRect(0, 0, linesCanvas.width, linesCanvas.height);
      lg.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      // 只投影看得到範圍內的線；飛行中相機會滾轉（cam.up），範圍改成任何滾轉角都包得住的外接範圍（D19 e）
      const vb = visibleBounds3d(cam, { fovDeg: FOV, aspect: w / h });
      drawLineLayers(lg, camPos, c, bgType, dark, level, span, flight && cam.up ? rollSafeBounds(vb, cam) : vb, ppd);
      linesDraws++;
    }
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.drawImage(linesCanvas, 0, 0);
    octx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    // 國名（依等效跨度與碰撞，不蓋呼號）
    namesShown = 0;
    namesText = [];
    const dotBoxes = points.map((p) => ({ x: p.x - 7, y: p.y - 7, w: 14, h: 14 }));
    if (mePt) dotBoxes.push({ x: mePt.x - 8, y: mePt.y - 8, w: 16, h: 16 });
    let placedNames = [];
    if (options.names && countries.length) {
      const avoid = [...labels, ...dotBoxes];
      const nameSpan = Math.min(360, span * 2); // 球面往邊緣彎：中心的等效跨度低估看到的範圍，少寫一級
      const named = [];
      for (const n of countryLabels(countries, { lonSpan: nameSpan, locale: options.locale })) {
        const v = latLonToVec3(n.lat, n.lon);
        if (!facing(v, camPos, 0.3)) continue;
        named.push({ ...n, ...toScreen(v) });
      }
      octx.font = `600 ${NAME_FONT_PX}px system-ui, sans-serif`;
      const names = placeCountryNames(named, { width: w, height: h, measure: (t) => octx.measureText(t).width, fontPx: NAME_FONT_PX, avoid });
      const onImage = bgType !== 'outline';
      octx.textBaseline = 'top';
      octx.lineJoin = 'round';
      for (const n of names) {
        octx.lineWidth = 3;
        octx.strokeStyle = onImage ? c.nameHaloOnImage : c.nameHalo;
        octx.strokeText(n.text, n.x + 1, n.y + 1);
        octx.fillStyle = onImage ? c.nameOnImage : c.name;
        octx.fillText(n.text, n.x + 1, n.y + 1);
      }
      namesShown = names.length;
      namesText = names.map((n) => n.text);
      placedNames = names;
    }
    overlayLabels([...labels, ...dotBoxes, ...placedNames], camPos, bgType, dark, level, span);
    // 標點（同 2D 形狀：目前對象粗外圈、叫我實心＋外圈、概略位置虛線圈）
    const fill = { target: c.ink, me: c.me, cq: c.cq, other: c.other };
    const radius = { target: 5, me: 5.5, cq: 4.5, other: 3.5 };
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i]; // 選取的電台照常畫標點與外圈（B2），選取光環最後疊上去
      const r = radius[p.kind];
      circle(p.x, p.y, r + 1.5, c.halo);
      circle(p.x, p.y, r, p.kind === 'target' ? c.halo : fill[p.kind]);
      if (p.kind === 'target' || p.kind === 'me') ring(p.x, p.y, p.kind === 'target' ? 7 : r + 3, p.kind === 'target' ? c.ink : c.me, p.kind === 'target' ? 2.5 : 1.5);
      if (p.approx) {
        octx.setLineDash([3, 3]);
        ring(p.x, p.y, r + 5, c.other, 1.5);
        octx.setLineDash([]);
      }
    }
    if (mePt) {
      circle(mePt.x, mePt.y, 7, c.halo);
      circle(mePt.x, mePt.y, 5, c.ink);
    }
    const sp = selected ? points.find((p) => p.call === selected) : null;
    if (sp) {
      const pulsing = !reduce && pulseActive(now, selectedAt); // 閃 SELECT_PULSE_LIMIT_MS 後改靜態粗環（C3）
      if (pulsing) drawSelectedPulse(octx, sp.x, sp.y, now, { r: selectedRadii(sp.kind, radius[sp.kind], sp.approx).select, color: c.selected });
      drawSelectedMark(octx, sp.x, sp.y, {
        kind: sp.kind, r: radius[sp.kind], approx: Boolean(sp.approx), fill: fill[sp.kind], halo: c.halo, ink: c.ink, callme: c.me, other: c.other, color: c.selected, reduced: !pulsing,
      });
    }
    selectedShown = sp?.call ?? null;
    octx.font = `${FONT_PX}px system-ui, sans-serif`;
    octx.textBaseline = 'top';
    const byCall = new Map(points.map((p) => [p.call, p]));
    const textOf = new Map(items.map((it) => [it.id, it.text]));
    const selLabel = labels.find((l) => l.id === selected);
    for (const l of labels) {
      if (l === selLabel) continue;
      const p = byCall.get(l.id);
      octx.fillStyle = c.halo;
      octx.globalAlpha = 0.8;
      octx.fillRect(l.x, l.y, l.w, l.h);
      octx.globalAlpha = 1;
      octx.fillStyle = p.kind === 'other' ? c.other : fill[p.kind];
      octx.fillText(textOf.get(l.id), l.x + 1, l.y + 1);
    }
    if (selLabel) {
      octx.fillStyle = c.halo;
      octx.fillRect(selLabel.x, selLabel.y, selLabel.w, selLabel.h);
      octx.strokeStyle = c.selected;
      octx.lineWidth = 1.5;
      octx.strokeRect(selLabel.x, selLabel.y, selLabel.w, selLabel.h);
      octx.font = `700 ${FONT_PX}px system-ui, sans-serif`;
      octx.fillStyle = c.ink;
      octx.fillText(textOf.get(selLabel.id), selLabel.x + 1, selLabel.y + 1);
    }
    overlay.dataset.labels = String(labels.length);

    // 呼叫場景的光點與漣漪（同 2D）
    if (scene?.animated && !reduce) {
      const line1 = route1 ? screenLine(route1, camPos) : null;
      const line2 = route2 ? screenLine(route2, camPos) : null;
      if (scene.state === 'cq' && scene.them) {
        const v = latLonToVec3(scene.them.lat, scene.them.lon);
        if (facing(v, camPos)) {
          const s = toScreen(v);
          drawRipple(s.x, s.y, now, c.cq, 6, 28);
        }
      }
      if (scene.myTx && line1) dot(line1, now, true, true, c);
      if (scene.state === 'toMe' && line1) dot(line1, now, false, false, c);
      if (scene.state === 'toOther' && line2) dot(line2, now, false, true, c);
    }
  }
  // 航線的畫面折線；被地球擋住的點設成 null（光點跑到背面就不畫）
  function screenLine(pts, camPos) {
    const line = polyline(pts.map((p) => toScreen(p)));
    line.hidden = pts.map((p) => occluded(p, camPos));
    return line;
  }
  function circle(x, y, r, color) {
    octx.beginPath();
    octx.arc(x, y, r, 0, Math.PI * 2);
    octx.fillStyle = color;
    octx.fill();
  }
  function ring(x, y, r, color, width) {
    octx.beginPath();
    octx.arc(x, y, r, 0, Math.PI * 2);
    octx.strokeStyle = color;
    octx.lineWidth = width;
    octx.stroke();
  }
  function drawRipple(x, y, now, color, r0 = 5, r1 = 24) {
    for (let i = 0; i < RIPPLE_RINGS; i++) {
      const f = ((now / RIPPLE_PERIOD_MS) + i / RIPPLE_RINGS) % 1;
      octx.globalAlpha = 0.8 * (1 - f);
      ring(x, y, r0 + (r1 - r0) * f, color, 1.8);
    }
    octx.globalAlpha = 1;
  }
  function dot(line, now, filled, forward, c) {
    const f = dotPhase(now, DOT_PERIOD_MS, forward);
    const idx = Math.round(Math.min(1, Math.max(0, f)) * (line.hidden.length - 1));
    if (line.hidden[idx]) return;
    for (let k = TAIL_STEPS; k >= 0; k--) {
      const back = (k * 0.018) * (forward ? 1 : -1);
      const p = pointAlong(line, f - back);
      if (!p) return;
      const r = k === 0 ? 5 : Math.max(1.2, 4 - k * 0.4);
      octx.globalAlpha = k === 0 ? 1 : 0.55 - k * 0.06;
      if (k === 0 && !filled) {
        circle(p.x, p.y, r, c.halo);
        ring(p.x, p.y, r, c.ink, 2);
      } else circle(p.x, p.y, r, c.ink);
    }
    octx.globalAlpha = 1;
  }

  // 選取光環只在閃的那幾秒、而且選取點在畫布內才需要動畫（C3）
  const selectPulsing = () => Boolean(selected) && pulseActive(performance.now(), selectedAt)
    && points.some((p) => p.call === selected && p.x >= 0 && p.y >= 0 && p.x <= size.w && p.y <= size.h);
  const needsAnim = () => Boolean(flight) || Boolean(inertia) || uniforms.detailMix.value !== detailInfo.target || (!reducedMotion?.matches && (linkObjs.length > 0 || Boolean(scene?.animated)
    || (ripples.size > 0 && points.some((p) => ripples.has(p.call))) || selectPulsing()));
  function schedule() {
    if (destroyed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
      startAnim();
    });
  }
  function loop(t) {
    anim = 0;
    if (destroyed || !needsAnim()) return;
    if (flight || inertia || t - lastFrame >= FRAME_MS - FRAME_SLACK_MS) {
      lastFrame = t;
      render();
    }
    if (!document.hidden && size.w && size.h && onScreen) anim = requestAnimationFrame(loop);
  }
  function startAnim() {
    if (!anim && needsAnim() && !destroyed && onScreen && !document.hidden) anim = requestAnimationFrame(loop);
  }
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    onScreen = entries.at(-1)?.isIntersecting ?? true;
    eox?.setVisible(onScreen); // 捲出畫面或收起：暫停發請求
    if (onScreen) schedule();
  }) : null;
  io?.observe(canvas);
  const sunTimer = setInterval(() => { if (options.daynight) schedule(); }, SUN_MS);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    fitDirty = true;
    if (w && h) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      overlay.width = Math.round(w * dpr);
      overlay.height = Math.round(h * dpr);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    schedule();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ── 手勢：拖曳旋轉、滾輪／雙指縮放、點選、右鍵／長按開設定 ──
  const pointers = new Map();
  let tap = null;
  let pinchDist = 0;
  let press = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  // 停手 resumeMs 後恢復自動框住（飛回去）；慣性滑行中不算停手
  const armResume = () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      userMoved = false;
      flyNow = true;
      schedule();
    }, resumeMs);
  };
  const moved = (next) => {
    flight = null;
    pending = null;
    inertia = null;
    const { up, q, ...plain } = next; // 飛行中被拖：回到北方朝上的相機
    cam = plain;
    userMoved = true;
    lastManualAt = performance.now(); // 細節貼圖重畫限流（D19 b）
    armResume();
    schedule();
  };
  // 慣性滑行一步（render 每幀呼叫）；停下來才開始算「停手」
  const rotateTo = (c, dLon, dLat) => ({ ...c, lon: wrapLon(c.lon + dLon), lat: Math.max(-MAX_CAM_LAT, Math.min(MAX_CAM_LAT, c.lat + dLat)) });
  function coast(now) {
    const r = inertiaStep(inertia.state, now - inertia.last);
    inertia = r.done ? null : { state: r.state, last: now };
    cam = rotateTo(cam, r.dLon, r.dLat);
    if (!inertia) armResume();
  }
  function startFling(now) {
    const v = flingVelocity(dragSamples, now);
    dragSamples = [];
    if (reducedMotion?.matches || !cam) return;
    const dpp = degPerPx(cam.dist, size.h, FOV);
    const st = startInertia(v, cam.lat, { minSpeed: FLING_MIN_PX_S * dpp, maxSpeed: FLING_MAX_PX_S * dpp, stopSpeed: FLING_STOP_PX_S * dpp });
    if (!st) return;
    inertia = { state: st, last: now };
    clearTimeout(resumeTimer);
    schedule();
  }
  // 縮放上限：整顆地球；自動框住為了弧頂拉得更遠時，不要一縮放就跳近
  const zoomMax = () => Math.max(maxDistFor(FOV, size.w / size.h), cam?.dist ?? 0);
  const cancelPress = () => {
    clearTimeout(press?.timer);
    press = null;
  };
  function openSettings() {
    cancelPress();
    tap = null;
    pointers.clear();
    pinchDist = 0;
    onSettings?.();
  }
  function onContext(e) {
    if (!onSettings) return;
    e.preventDefault();
    openSettings();
  }
  function onWheel(e) {
    if (!cam) return;
    e.preventDefault();
    moved(zoomBy(cam, Math.exp(-e.deltaY * WHEEL_ZOOM), zoomMax()));
  }
  function onDown(e) {
    // 滑鼠右鍵、中鍵：不算點選、不拖曳（Windows Chrome 的 pointerup 比 contextmenu 先到，右鍵會順便選到電台）
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (inertia) {
      inertia = null; // 按下就停住
      armResume();
    }
    dragSamples = [];
    canvas.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    tap = pointers.size === 1 ? { ...p, moved: false } : null;
    cancelPress();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    if (onSettings && e.pointerType === 'touch' && pointers.size === 1) {
      press = { id: e.pointerId, timer: setTimeout(() => {
        openSettings();
        const swallow = (ev) => {
          ev.stopImmediatePropagation();
          ev.preventDefault();
        };
        document.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 1500);
      }, LONG_PRESS_MS) };
    }
  }
  function onMove(e) {
    const prev = pointers.get(e.pointerId);
    if (!prev || !cam) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP_PX) {
      tap.moved = true;
      cancelPress();
    }
    if (pointers.size === 1) {
      if (tap?.moved) {
        moved(rotateBy(cam, p.x - prev.x, p.y - prev.y, size.h, FOV));
        dragSamples.push({ t: performance.now(), lat: cam.lat, lon: cam.lon });
        if (dragSamples.length > 30) dragSamples.shift();
      }
    } else if (pointers.size === 2) {
      dragSamples = [];
      cancelPress();
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) moved(zoomBy(cam, d / pinchDist, zoomMax()));
      pinchDist = d;
    }
  }
  function onUp(e) {
    if (press?.id === e.pointerId) cancelPress();
    const had = pointers.delete(e.pointerId);
    if (had && e.type === 'pointerup' && tap && !tap.moved && pointers.size === 0) {
      const { x, y } = local(e);
      const hit = pickAt(points, x, y, PICK_RADIUS_PX);
      if (hit) {
        picked = hit.call;
        onPick(hit.call);
      }
    }
    // 拖快放開：多滑一段慢慢停（慣性）；慢慢拖放開就停
    if (had && e.type === 'pointerup' && tap?.moved && pointers.size === 0) startFling(performance.now());
    if (pointers.size === 0) tap = null;
    pinchDist = 0;
  }
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', onContext);

  const onTheme = () => {
    applyTheme();
    schedule();
  };
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', onTheme);
  const themeObserver = new MutationObserver(onTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', schedule);

  applyTheme();
  resize();

  return {
    setMe(grid) {
      const next = grid ? gridToLatLon(grid) : null;
      if (next?.lat === me?.lat && next?.lon === me?.lon) return;
      me = next;
      fitDirty = true;
      schedule();
    },
    update(next) {
      stations = next ?? [];
      fitDirty = true;
      schedule();
    },
    setRipples(calls) {
      ripples = new Set(calls ?? []);
      schedule();
    },
    setLinks(next) {
      links = next ?? [];
      const now = performance.now();
      const keep = new Set(links.map(linkKey));
      for (const k of births.keys()) if (!keep.has(k)) births.delete(k);
      let n = 0;
      for (const l of links) {
        const k = linkKey(l);
        if (!births.has(k)) births.set(k, now + ((LINK_STAGGER_MS * n++) % LINK_CYCLE.period));
      }
      fitDirty = true;
      rebuildLinks();
      schedule();
    },
    setTarget(call) {
      const next = call || null;
      if (next === target) return;
      target = next;
      schedule();
    },
    setSelected(call) {
      const next = call || null;
      if (next === selected) return;
      selected = next;
      selectedAt = next ? performance.now() : null;
      clearTimeout(pulseTimer);
      if (next) pulseTimer = setTimeout(schedule, SELECT_PULSE_LIMIT_MS + 50); // 閃完重畫一次（靜態粗環）
      schedule();
    },
    setScene(next) {
      const geometry = !sameGeometry(scene, next) && (scene || next);
      scene = next;
      fitDirty = true;
      if (geometry) rebuildRoutes();
      schedule();
    },
    setOptions(next) {
      const prev = options;
      options = { ...options, ...next };
      useEox(options.type === 'eox');
      if (!eox) eoxInfo = { ...eoxInfo, on: false, status: 'off' };
      if (options.type !== prev.type || !basemapImg) {
        if (options.type === 'outline' || options.type === 'eox') setImage(null);
        else {
          const want = options.type;
          if (prev.type !== want) setImage(null);
          loadBasemap(want).then((img) => {
            if (destroyed || options.type !== want) return;
            setImage(img);
          });
        }
      }
      applyTexture();
      if (options.borders && !borders.length) {
        loadBorders().then((b) => {
          if (destroyed) return;
          borders = b;
          rebuildBorders();
          schedule();
        });
      }
      for (const layer of ['cqZones', 'ituZones']) {
        if (options[layer] && !zones[layer]?.lines.length) {
          loadZones(layer).then((z) => {
            if (destroyed) return;
            zones[layer] = z;
            zones3d[layer] = to3d(z.lines);
            schedule();
          });
        }
      }
      if (options.states && !states.length) {
        loadStates().then((st) => {
          if (destroyed) return;
          states = st;
          states3d = to3d(st);
          schedule();
        });
      }
      if (options.names && !countries.length) {
        loadCountries().then((c) => {
          if (destroyed) return;
          countries = c;
          schedule();
        });
      }
      schedule();
    },
    resize,
    fit() {
      clearTimeout(resumeTimer);
      inertia = null;
      userMoved = false;
      flyNow = true;
      schedule();
    },
    setResumeMs(ms) { resumeMs = ms; }, // 測試用：縮短恢復自動框住的時間
    // 測試用：相機移到 { lat, lon, dist }（同使用者手動移動：暫停自動框住）
    lookAt({ lat, lon, dist }) {
      moved({ lat, lon: wrapLon(lon), dist });
    },
    destroy() {
      destroyed = true;
      clearTimeout(resumeTimer);
      clearTimeout(pendingTimer);
      clearTimeout(pulseTimer);
      clearTimeout(detailTimer);
      clearTimeout(detailBuildTimer);
      clearTimeout(detailReleaseTimer);
      clearTimeout(eoxIdleTimer);
      eoxUnsub?.();
      // 取消請求（code review 9）：排隊丟掉、進行中中止；切換 2D／3D 時新的繪製層停住 150 ms 後重新要（中止時已解好的圖照樣進快取）
      peekEoxSource()?.cancel();
      releaseEoxBase();
      clearInterval(sunTimer);
      inertia = null;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(anim);
      cancelPress();
      io?.disconnect();
      ro.disconnect();
      themeObserver.disconnect();
      media?.removeEventListener?.('change', onTheme);
      document.removeEventListener('visibilitychange', schedule);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('contextmenu', onContext);
      for (const l of linkObjs) {
        disposeObj(l.base);
        disposeObj(l.anim);
      }
      for (const r of routeObjs) disposeObj(r.mesh);
      outlineTex?.dispose();
      imageTex?.dispose();
      detailTex?.tex.dispose();
      if (detailTex) detailTex.canvas.width = 0;
      globe.geometry.dispose();
      globeMat.dispose();
      glow.geometry.dispose();
      glow.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
    },
    // 自動化檢查用：相機、標點、弧線數；pixels() 同步畫一幀再讀 WebGL 像素（preserveDrawingBuffer 關著，事後讀是空白）
    debug: () => ({
      renderer: '3d', options: { ...options }, basemapReady: Boolean(basemapImg), borders: borders.length, names: namesShown,
      overlays: { states: states.length, cqZones: zones.cqZones?.lines.length ?? 0, ituZones: zones.ituZones?.lines.length ?? 0 },
      gridLevel: overlayInfo.gridLevel, gridTexts: [...overlayInfo.gridTexts], zoneTexts: { cqZones: [...overlayInfo.zoneTexts.cqZones], ituZones: [...overlayInfo.zoneTexts.ituZones] },
      cam: cam && { ...cam }, flying: Boolean(flight), flyStage: flightStage(), overviews, overviewRetargets, overviewDist: size.w && size.h ? maxDistFor(FOV, size.w / size.h) : null, userMoved, size: { w: size.w, h: size.h }, points: points.map((p) => ({ ...p })),
      links: links.map((l) => `${l.from}>${l.to}`), linkMeshes: linkObjs.length, routes: { line1: route1?.length ?? 0, line2: route2?.length ?? 0 },
      me, target, scene, ripples: [...ripples], animating: anim !== 0, renders, rings: outline.length, picked, selected: selectedShown,
      selectPulsing: selectPulsing(), linesDraws, detail: { ...detailInfo, loaded: [...detailReq.keys()].filter((k) => detail[k.split(':')[0]][k.split(':')[1]]),
        failed: [...detailReq].filter(([, r]) => r.failedAt !== null).map(([k]) => k) },
      eox: { ...eoxInfo, stats: peekEoxSource()?.stats() ?? null, baseTex: Boolean(eoxBase) && uniforms.tex.value === eoxBase?.tex },
      coasting: Boolean(inertia), liftCap, pending: Boolean(pending), flights, linkRebuilds, flightRebuilds, nameTexts: [...namesText], dark: isDarkTheme(), sunDir: uniforms.dayNight.value ? uniforms.sunDir.value.toArray() : null,
      // 畫面像素取樣（WebGL＋overlay 合成）：[{ lat, lon, dx, dy }] → [{ x, y, rgb }]（背面或畫面外 null）
      probe(list) {
        render();
        const gl = renderer.getContext();
        const camPos = cameraPosition(cam);
        return list.map(({ lat, lon, dx = 0, dy = 0 }) => {
          const v = latLonToVec3(lat, lon);
          if (!facing(v, camPos)) return null;
          const s = toScreen(v);
          const x = s.x + dx, y = s.y + dy;
          if (!(x >= 0 && y >= 0 && x < size.w && y < size.h)) return null;
          const buf = new Uint8Array(4);
          gl.readPixels(Math.floor(x * size.dpr), gl.drawingBufferHeight - 1 - Math.floor(y * size.dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          const o = octx.getImageData(Math.floor(x * size.dpr), Math.floor(y * size.dpr), 1, 1).data;
          const a = o[3] / 255;
          return { x, y, rgb: [0, 1, 2].map((i) => Math.round(o[i] * a + buf[i] * (1 - a))) };
        });
      },
      pixels() {
        render();
        const gl = renderer.getContext();
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const buf = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let n = 0;
        let sum = 0;
        for (let i = 0; i < buf.length; i += 4) {
          if (buf[i + 3] > 0) {
            n++;
            sum += buf[i] + buf[i + 1] + buf[i + 2];
          }
        }
        return { total: W * H, opaque: n, meanRgb: n ? sum / n / 3 : 0 };
      },
    }),
  };
}
