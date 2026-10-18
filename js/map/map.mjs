// 電台地圖（canvas）：海、陸地輪廓、我的位置、最近聽到的電台、我方→目前對象的大圓航線。
// 投影與配色同 FT8TW 呼叫面板小地圖（StationMapView）；判斷邏輯都在 projection／stations／labels 這幾個純模組，
// 這裡只負責畫與手勢。只在資料、尺寸、視野、深淺色改變時重繪；容器不顯示（0×0）或分頁在背景時不畫。
//
// 呼叫場景（scene.mjs，同 FT8TW 呼叫面板 D32）：我方↔對方航線、對方→第三台航線、光點、CQ 漣漪。
// 靜態層（海、陸地、航線、標點、標籤）畫在離屏 canvas，只在資料／視野改變時重畫；動畫的每一幀只貼上靜態層再畫光點。
//
// 地圖設定（add-map-settings-globe、add-map-overlays）：setOptions({ type, borders, names, daynight, grid, cqZones, ituZones, states, locale })＝底圖（簡圖／衛星／地形影像，依視野裁切）、
// 國界線（依底圖兩道線，countrylayer.borderStyle）、國名（依縮放與碰撞）、日夜分界（黑夜區稍暗，sun.mjs 遮罩每分鐘更新）；
// 右鍵或觸控長按呼叫 onSettings()（開設定框，不選取電台）；滑鼠右鍵、中鍵按下不算點選。
//
// createMap({ canvas, onPick, onSettings, outlineUrl, approxLocate }) →
//   { setMe(grid), update(stations), setTarget(call), setScene(scene), setLinks(links), setOptions(o), resize(), fit(), destroy(), debug() }
//   links：links.mjs linksFromRows 的結果（誰呼叫誰，細線；叫我的用洋紅）
//   setRipples(calls)：喊 CQ 的電台畫向外擴散的同心圓（同 S20 摩登電台卡地圖）
//   stations：[{ call, grid, snr, isCq, callsMe, lastUtc }]；onPick(call)：點選標點
import { loadOutline, EMPTY_OUTLINE } from './outline.mjs';
import { copyXs, fitView, flyPath, refly, greatCircle, kFor, panBy, project, projectRaw, scaleOf, unproject, worldOffsets, wrapLon, zoomAt } from './projection.mjs';
import { bigMove2d, overviewFlight, worldView2d } from './flyplan.mjs';
import { byPriority, kindOf, labelItems, pickAt, placeLabels } from './labels.mjs';
import { locate } from './stations.mjs';
import { linkFramePoints } from './links.mjs';
import { gridToLatLon } from '../maidenhead.mjs';
import { LINK_CYCLE, dotPhase, linkCycle, partialPoints, pointAlong, polyline, sameGeometry } from './scene.mjs';
import { basemapCrop } from './basemap.mjs';
import { borderStyle, countryLabels, placeCountryNames } from './countrylayer.mjs';
import { TERMINATOR_COLOR, nightMask, subsolarPoint, terminatorPoints } from './sun.mjs';
import { edgeColors, isDarkTheme, loadBasemap, loadBorders, loadCountries, loadDetail, loadStates, loadZones } from './layers.mjs';
import { DETAIL_RETRY_MS, canRequest, readyTier, tiersToLoad, vectorFade, vectorPalette } from './detail.mjs';
import { affine, visibleLandPaths, visibleLinesPath } from './vectorpaint.mjs';
import { gridLabels, gridLevel, gridLines, overlayLabelStyle, overlayStyle } from './overlays.mjs';
import { MERC_MAX_LAT, drawTileSet, tileKey, tilesFor } from './tiles.mjs';
import { eoxSource, peekEoxSource } from './eoxsource.mjs';
import { LONG_PRESS_MS } from '../qso/contextmenu.mjs';
import { SELECT_PULSE_LIMIT_MS, drawSelectedMark, drawSelectedPulse, pulseActive, selectedFirst, selectedRadii } from './selection.mjs';

const DOT_PERIOD_MS = 2200; // 光點跑完一條航線（同 FT8TW：太快看不清方向，太慢像沒在動）
const RIPPLE_PERIOD_MS = 1600;
const RIPPLE_RINGS = 3;
const TAIL_STEPS = 7; // 拖尾在後方，方向就看得出來
const ROUTE_SEGMENTS = 64;
const LINK_STAGGER_MS = 370; // 誰呼叫誰的循環動畫：各條線起點錯開，不同時閃（使用者 2026-10-07）
const LINK_BASE_ALPHA = 0.35; // 底層淡色完整線：任何時候都看得到誰在呼叫誰

const FONT_PX = 11;
const TAP_SLOP_PX = 6;
// 長按後放開手指的 click 會落在設定框的背景上（點背景＝關閉）：吞掉這一次（同 spectrum/panel.mjs）
function swallowClick() {
  const swallow = (ev) => {
    ev.stopImmediatePropagation();
    ev.preventDefault();
  };
  document.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 1500);
}
const PICK_RADIUS_PX = 14;
const FIT_MARGIN_PX = 26;
const RADIUS = Object.freeze({ target: 5, me: 5.5, cq: 4.5, other: 3.5 });
const WHEEL_ZOOM = 0.0015;
const NAME_FONT_PX = 10;
const ZONE_FONT_PX = 10; // 區號（add-map-overlays：小字、半透明、不蓋呼號）
const GRID_FONT_PX = 9;
const FINE_GRID_ALPHA = 0.6;
const OVERLAY_LABEL_ALPHA = 0.8;
const SUN_MS = 60_000; // 日夜分界每分鐘更新
const MASK_W = 360; // 黑夜遮罩：1° 一格（放大時平滑內插）
const MASK_H = 180;
const EOX_IDLE_MS = 150; // 線上圖磚（add-map-eox-imagery D4）：拖曳、縮放、飛行停下這麼久才換請求清單

export function createMap({ canvas, onPick = () => {}, onSettings = null, outlineUrl = new URL('../../data/world_110m.bin', import.meta.url), approxLocate = null }) {
  const out = canvas.getContext('2d');
  const base = document.createElement('canvas'); // 靜態層
  const ctx = base.getContext('2d');
  let outline = EMPTY_OUTLINE;
  let scene = null; // scene.mjs buildScene 的結果
  let line1 = null; // 我方→對方（畫面座標折線）
  let line2 = null; // 對方→第三台
  let anim = 0;
  let lastColors = null; // draw() 讀的配色，動畫每幀沿用（不必每幀 getComputedStyle）
  let onScreen = true; // 捲到畫面外時不跑動畫（IntersectionObserver）
  let lastFrame = 0;
  const FRAME_MS = 33; // 動畫約 30 fps 就夠看出方向
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let me = null; // { lat, lon }
  let stations = [];
  let links = []; // 誰呼叫誰（使用者 2026-10-07）
  const births = new Map(); // 連線 key（含 slot）→ 開始畫的時間（performance.now）；同一對在新 slot 又叫一次會再畫一次
  let linkGeoms = []; // 最後一次繪製的連線（畫面座標）：[{ line, color, dashed, born }]
  let ripples = new Set(); // 喊 CQ 的電台（使用者 2026-10-07）
  const linkKey = (l) => `${l.from}>${l.to}@${l.utc}`;
  let target = null;
  let selected = null; // 清單左鍵選取的電台（add-map-overlays E）：加大、光環、呼號粗體最上層
  let view = null;
  let userMoved = false; // 使用者縮放／平移過：暫停自動框住，按「全覽」或停手 resumeMs 後回來
  let resumeMs = 30_000; // 使用者 2026-10-08：仍有站台畫到地圖外（滾輪捲頁面時誤縮放地圖，自動框住就一直停著）
  let resumeTimer = 0;
  let flight = null; // 自動移動中的飛行：{ path, to, start, overviewed }（使用者 2026-10-08：略有戲劇張力，不直接切換）
  let overviews = 0; // 兩段式飛行（先看全世界，map-fly-overview）次數；第一段／停留中換終點的次數（自動化檢查用）
  let overviewRetargets = 0;
  let fitSize = ''; // 上次框住時的畫面大小：大小變了（旋轉、拖曳分隔線）直接切，不飛
  let size = { w: 0, h: 0, dpr: 1 };
  let frame = 0;
  let points = []; // 最後一次繪製的標點（點選用）：[{ call, x, y, kind }]
  let destroyed = false;
  let options = { type: 'outline', borders: false, names: false, daynight: false, grid: false, cqZones: false, ituZones: false, states: false, locale: 'en' };
  let nightCanvas = null; // 黑夜遮罩（等距圓柱 360×180）
  let nightMinute = -1;
  let namesText = []; // 最後一次寫出的國名（自動化檢查用）
  let picked = null; // 最後一次點選的呼號（自動化檢查用）
  let basemap = null; // 目前底圖種類載好的影像（簡圖時 null）
  let borders = []; // countrylayer.parseBorders
  let countries = []; // countrylayer.parseCountries
  let namesShown = 0;
  let labelBoxes = []; // 最後一次放好的呼號標籤（自動化檢查用：都在畫布內）
  // 圖層（add-map-overlays）：Zone { lines, labels }、州界 [Float32Array]；第一次打開才載入
  const zones = { cqZones: null, ituZones: null };
  let states = [];
  let overlayInfo = { gridLevel: 0, gridTexts: [], zoneTexts: { cqZones: [], ituZones: [] } };
  // 放大後的向量圖（D14）：各級的陸地、國界、州界；放大到該級（detail.tiersToLoad）才下載
  const detail = { '50m': { land: null, borders: null, states: null }, '10m': { land: null, borders: null, states: null } };
  const detailReq = new Map(); // '50m:land' → { failedAt }（detail.canRequest：失敗 30 秒後再試）
  let detailTimer = 0;
  let fadeCanvas = null; // 交叉淡化的離屏畫布（向量層先畫在這裡，再一次以 fade 合成）
  let detailInfo = { pxPerDeg: 0, tier: null, fade: 0 };
  let selectedAt = null; // 選取的時間：閃 SELECT_PULSE_LIMIT_MS 後改靜態粗環（C3）
  let pulseTimer = 0;
  // 線上衛星圖磚（add-map-eox-imagery）：選了 eox 才建立來源、訂閱（圖磚到達或狀態改變就重畫）
  let eox = null;
  let eoxUnsub = null;
  let eoxInfo = { on: false, status: 'off', z: null, tiles: 0, drawn: 0, fallback: 0, missing: 0, vectorSkipped: false };
  let eoxPlan = null; // 本幀的圖磚清單 { z, tiles, moving }（畫向量墊底前先算：判斷能不能跳過）
  let lastMoveAt = -Infinity;
  let eoxTimer = 0;
  let eoxViewKey = '';
  let eoxViewAt = 0;
  function useEox(on) {
    if (on && !eox) {
      eox = eoxSource();
      eoxUnsub = eox.subscribe(() => schedule());
    } else if (!on && eox) {
      eoxUnsub?.();
      eoxUnsub = null;
      eox.cancel(); // 切到其他底圖：排隊的丟掉、進行中的中止，不再請求
      eox = null;
    }
  }

  loadOutline(outlineUrl).then((rings) => {
    if (destroyed) return;
    outline = rings;
    schedule();
  });
  // 日夜分界：每分鐘重畫一次（只在開著、畫面有顯示時才真的畫）
  const sunTimer = setInterval(() => { if (options.daynight) schedule(); }, SUN_MS);

  function nightLayer(nowMs) {
    const minute = Math.floor(nowMs / SUN_MS);
    if (nightCanvas && minute === nightMinute) return nightCanvas;
    nightMinute = minute;
    const a = nightMask(subsolarPoint(nowMs), MASK_W, MASK_H);
    nightCanvas ??= document.createElement('canvas');
    nightCanvas.width = MASK_W;
    nightCanvas.height = MASK_H;
    const g = nightCanvas.getContext('2d');
    const img = g.createImageData(MASK_W, MASK_H);
    for (let i = 0; i < a.length; i++) img.data[i * 4 + 3] = a[i]; // 黑色、透明度＝黑夜程度
    g.putImageData(img, 0, 0);
    return nightCanvas;
  }

  function located() {
    const out = [];
    for (const s of stations) {
      const pos = locate(s, approxLocate);
      if (pos) out.push({ ...s, ...pos, kind: kindOf(s, target) });
    }
    return out.sort(byPriority);
  }

  function autoFit() {
    if (!size.w || !size.h) return;
    const pts = located().map((p) => ({ lat: p.lat, lon: p.lon }));
    // 連線與呼叫航線也要框住（使用者 2026-10-08）：端點可能不在目前清單裡，大圓航線會往極區凸出
    const routes = [...links];
    if (scene?.me && scene.them) routes.push({ a: scene.me, b: scene.them });
    if (scene?.them && scene.third) routes.push({ a: scene.them, b: scene.third });
    pts.push(...linkFramePoints(routes));
    if (me) pts.unshift(me); // 接縫放在所有點（含連線取樣點）最大的經度空隙（projection.seamRef）
    const next = fitView(pts, size.w, size.h, { minSpanDeg: pts.length > 1 ? 10 : 30 });
    const sizeKey = `${size.w}x${size.h}`;
    const now = performance.now();
    // 第一次、畫面大小變了、減少動態效果：直接切
    if (!view || sizeKey !== fitSize || reducedMotion?.matches) {
      fitSize = sizeKey;
      flight = null;
      view = next;
      return;
    }
    // 目標變了（飛行中又來新電台也一樣）：從目前位置重新起飛
    // 差不多就不動（hysteresis）：連線每個時槽出現／消失、場景定時重設，不要讓地圖一直抖
    const goal = flight?.to ?? view;
    // 只有「差不多」而且所有站台、連線都還在目前（或飛行目標）畫面內才不動（使用者 2026-10-08：仍有站台畫到地圖外）；
    // 邊距 26 px（標點外圈與 CQ 漣漪）。新目標也框不住（畫面太小）時不重飛：原本每幀從頭起飛，地圖凍在舊視野（add-map-overlays D10）
    if (refly(goal, next, size.w, size.h, pts, FIT_MARGIN_PX)) startFlight(next, now);
    if (!flight) return;
    const t = (now - flight.start) / flight.path.durationMs;
    view = flight.path.at(t);
    if (t >= 1) flight = null;
  }

  // 起飛（map-fly-overview）：兩段式飛行還在縮小／停留中 → 只換第二段終點；大幅移動 → 先縮到全世界、停一下、再放大；
  // 其他（含兩段式的第二段中又換目標）→ 原本的單段飛行，而且這趟落地前不再拉回全世界
  function startFlight(next, now) {
    const swapped = flight?.path.overview ? flight.path.retarget(now - flight.start, next) : null;
    if (swapped) {
      flight = { ...flight, path: swapped, to: next };
      overviewRetargets++;
      return;
    }
    const overviewed = Boolean(flight?.path.overview || flight?.overviewed);
    const world = fitView([], size.w, size.h);
    if (!overviewed && bigMove2d(view, next, size.w, size.h, world)) {
      flight = { path: overviewFlight(view, worldView2d(view, world), next, flyPath), to: next, start: now };
      overviews++;
      return;
    }
    const path = flyPath(view, next);
    flight = path.durationMs > 0 ? { path, to: next, start: now, overviewed } : null;
    if (!flight) view = next;
  }

  // 目前飛行的階段（自動化檢查用）：'out'、'hold'、'in'（兩段式），'fly'（單段），null（沒在飛）
  const flightStage = () => (!flight ? null : flight.path.stageAt?.(Math.min(1, (performance.now() - flight.start) / flight.path.durationMs)) ?? 'fly');

  function schedule() {
    if (destroyed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
      compose();
      startAnim(); // 回到前景、從隱藏變顯示時動畫接著跑
    });
  }

  // 大圓航線的畫面座標（起點展開後的平移量整條沿用，不在換日線斷開）
  function routePoints(a, b, w, h) {
    const route = greatCircle(a.lat, a.lon, b.lat, b.lon, ROUTE_SEGMENTS);
    const [x0, y0] = project(view, w, h, route[0].lat, route[0].lon);
    const shift = x0 - projectRaw(view, w, h, route[0].lat, route[0].lon)[0];
    return route.map((p, i) => {
      if (i === 0) return { x: x0, y: y0 };
      const [x, y] = projectRaw(view, w, h, p.lat, p.lon);
      return { x: x + shift, y };
    });
  }
  // 連線、航線跨過畫面接縫（視野中心 ±180°）時，另一段畫在 ±360° 副本上（add-map-overlays D10：
  // 原本只畫起點那一份，跨過接縫的那段與終點小圓畫到畫面外，看起來像電台畫到左側外）。回傳與畫面重疊的位移（像素）
  function copiesOf(line) {
    const { w } = size;
    const world = (360 * w) / view.lonSpan;
    if (line.minX === undefined) {
      line.minX = Math.min(...line.points.map((p) => p.x));
      line.maxX = Math.max(...line.points.map((p) => p.x));
    }
    // 畫面 0×0（手機其他分頁）或折線是空的：沒有副本可畫（不可以讓迴圈跑到無限）
    if (!(world > 0) || !Number.isFinite(line.minX) || !Number.isFinite(line.maxX)) return [];
    const out = [];
    for (let k = Math.ceil((-8 - line.maxX) / world); k <= Math.floor((w + 8 - line.minX) / world); k++) out.push(k * world || 0);
    return out;
  }
  function withCopies(g2, line, fn) {
    for (const dx of copiesOf(line)) {
      if (dx === 0) fn();
      else {
        g2.save();
        g2.translate(dx, 0);
        fn();
        g2.restore();
      }
    }
  }
  function strokeRoute(pts, { dashed, thin, color }) {
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = thin ? 1.4 : 2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 連線：細線＋接收方那端小點。底層（base）淡色完整線；動畫層的線頭是較大的亮點
  function strokeLink(g2, pts, g, { alpha = 1, base = false } = {}) {
    if (pts.length < 2) return;
    g2.globalAlpha = alpha;
    g2.beginPath();
    pts.forEach((p, i) => (i === 0 ? g2.moveTo(p.x, p.y) : g2.lineTo(p.x, p.y)));
    g2.setLineDash(g.dashed ? [5, 4] : []);
    g2.strokeStyle = g.color;
    g2.lineWidth = 1.4;
    g2.lineCap = 'round';
    g2.stroke();
    g2.setLineDash([]);
    const end = pts.at(-1);
    g2.beginPath();
    g2.arc(end.x, end.y, base ? 2.5 : 3.5, 0, Math.PI * 2);
    g2.fillStyle = g.color;
    g2.fill();
    g2.globalAlpha = 1;
  }
  const linksAnimating = () => linkGeoms.length > 0 && !reducedMotion?.matches;
  const ripplesAnimating = () => ripples.size > 0 && !reducedMotion?.matches && points.some((p) => ripples.has(p.call));
  const selectedPoint = () => (selected ? points.find((p) => p.call === selected) ?? null : null);
  // 閃 SELECT_PULSE_LIMIT_MS 就停；選取點不在畫布內也不跑動畫（C3）
  const selectAnimating = () => {
    if (reducedMotion?.matches || !pulseActive(performance.now(), selectedAt)) return false;
    const p = selectedPoint();
    return Boolean(p) && p.x >= 0 && p.y >= 0 && p.x <= size.w && p.y <= size.h;
  };
  const needsAnim = () => Boolean(scene?.animated) || linksAnimating() || ripplesAnimating() || selectAnimating();
  // 同心圓環從標點向外擴散、愈外圈愈淡（同 FT8TW StationMapView.drawRipple：1.6 s、3 圈）
  function drawRipple(x, y, now, color, r0 = 5, r1 = 24) {
    for (let i = 0; i < RIPPLE_RINGS; i++) {
      const f = ((now / RIPPLE_PERIOD_MS) + i / RIPPLE_RINGS) % 1;
      out.beginPath();
      out.arc(x, y, r0 + (r1 - r0) * f, 0, Math.PI * 2);
      out.strokeStyle = color;
      out.globalAlpha = 0.8 * (1 - f);
      out.lineWidth = 1.8;
      out.stroke();
    }
    out.globalAlpha = 1;
  }

  // 每一幀：貼上靜態層，再畫正在出現的連線、CQ 漣漪與光點（形狀區分方向與敵我，不靠顏色：FT8TW 維護者是色盲）
  function compose() {
    const { w, h, dpr } = size;
    if (!w || !h || document.hidden) return;
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.drawImage(base, 0, 0);
    if (!view) return;
    out.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = performance.now();
    // 喊 CQ 的電台：從標點向外擴散的同心圓（減少動態效果時不畫）
    if (!reducedMotion?.matches && ripples.size) {
      const cq = (lastColors ?? colors()).cq;
      for (const p of points) if (ripples.has(p.call)) drawRipple(p.x, p.y, now, cq);
    }
    // 選取的電台：閃動光環（減少動態效果時只有靜態層的粗光環）
    const sel = selectAnimating() ? selectedPoint() : null;
    if (sel) drawSelectedPulse(out, sel.x, sel.y, now, { r: selectedRadii(sel.kind, RADIUS[sel.kind], sel.approx).select, color: (lastColors ?? colors()).selected });
    // 誰呼叫誰：亮線每輪從發射端延伸到接收端、停一下、淡出，然後重來（減少動態效果時只留底層淡線）
    if (!reducedMotion?.matches) {
      for (const g of linkGeoms) {
        const cyc = linkCycle(now, g.born);
        if (cyc && cyc.f > 0) withCopies(out, g.line, () => strokeLink(out, partialPoints(g.line, cyc.f), g, { alpha: cyc.alpha }));
      }
    }
    if (!scene?.animated || reducedMotion?.matches) return; // 減少動態效果：只留靜態航線
    const c = lastColors ?? colors();
    if (scene.state === 'cq' && scene.them) {
      // 漣漪畫在航線終點（與航線同一個 ±360° 副本）；沒有航線時才用對方標點的位置
      const end = line1?.points.at(-1);
      const [x, y] = end ? [end.x, end.y] : project(view, w, h, scene.them.lat, scene.them.lon);
      const rings = () => {
        for (let i = 0; i < RIPPLE_RINGS; i++) {
          const f = ((now / RIPPLE_PERIOD_MS) + i / RIPPLE_RINGS) % 1;
          out.beginPath();
          out.arc(x, y, 6 + f * 22, 0, Math.PI * 2);
          out.strokeStyle = c.cq;
          out.globalAlpha = 1 - f;
          out.lineWidth = 2;
          out.stroke();
        }
        out.globalAlpha = 1;
      };
      if (line1) withCopies(out, polyline([end]), rings);
      else rings();
    }
    if (scene.myTx && line1) withCopies(out, line1, () => dot(line1, now, true, true, c));
    if (scene.state === 'toMe' && line1) withCopies(out, line1, () => dot(line1, now, false, false, c));
    if (scene.state === 'toOther' && line2) withCopies(out, line2, () => dot(line2, now, false, true, c));
  }
  // 光點＋拖尾：filled＝我方發出（實心），空心＝對方發出；forward＝沿折線起點往終點
  function dot(line, now, filled, forward, c) {
    const f = dotPhase(now, DOT_PERIOD_MS, forward);
    for (let k = TAIL_STEPS; k >= 0; k--) {
      const back = (k * 0.018) * (forward ? 1 : -1);
      const p = pointAlong(line, f - back);
      if (!p) return;
      const r = k === 0 ? 5 : Math.max(1.2, 4 - k * 0.4);
      out.beginPath();
      out.arc(p.x, p.y, r, 0, Math.PI * 2);
      out.globalAlpha = k === 0 ? 1 : 0.55 - k * 0.06;
      if (k === 0 && !filled) {
        out.fillStyle = c.halo;
        out.fill();
        out.strokeStyle = c.ink;
        out.lineWidth = 2;
        out.stroke();
      } else {
        out.fillStyle = c.ink;
        out.fill();
      }
    }
    out.globalAlpha = 1;
  }
  function loop(t) {
    anim = 0;
    if (destroyed || !needsAnim()) return;
    if (t - lastFrame >= FRAME_MS) {
      lastFrame = t;
      compose();
    }
    if (!document.hidden && size.w && size.h && onScreen && !reducedMotion?.matches) anim = requestAnimationFrame(loop);
  }
  function startAnim() {
    if (!anim && needsAnim() && !destroyed && onScreen) anim = requestAnimationFrame(loop);
  }
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    onScreen = entries.at(-1)?.isIntersecting ?? true;
    eox?.setVisible(onScreen); // 地圖收起或捲出畫面：線上圖磚暫停發請求（code review 9）
    if (onScreen) startAnim();
  }) : null;
  io?.observe(canvas);

  function colors() {
    const cs = getComputedStyle(canvas);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
      sea: v('--map-sea', '#B9D9F0'), land: v('--map-land', '#F2F1EA'), coast: v('--map-coast', '#8A96A3'),
      ink: v('--map-ink', '#141D28'), halo: v('--map-halo', '#FFFFFF'), other: v('--map-other', '#556170'),
      cq: v('--map-cq', '#137A3A'), me: v('--map-callme', '#C0247D'), selected: v('--map-selected', '#1F5FD6'),
      border: v('--map-border', '#8F7F96'), borderOnImage: v('--map-border-img', 'rgba(255,255,255,0.75)'),
      name: v('--map-name', '#4A5563'), nameHalo: v('--map-name-halo', 'rgba(255,255,255,0.85)'),
      nameOnImage: v('--map-name-img', '#FFFFFF'), nameHaloOnImage: v('--map-name-halo-img', 'rgba(0,0,0,0.55)'),
      satLift: v('--map-sat-lift', 'rgb(60 78 104)'),
    };
  }

  // 經緯度 → 畫面的仿射矩陣（等距圓柱投影；off＝經度位移）
  function matrixFor(off) {
    const { w, h } = size;
    const s = scaleOf(view, w);
    return affine(view.k * s, w / 2 - view.cLon * view.k * s, -s, h / 2 + view.cLat * s, off);
  }
  function strokePasses(path, passes) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const pass of passes) {
      ctx.setLineDash(pass.dash ?? []);
      ctx.strokeStyle = pass.color;
      ctx.lineWidth = pass.width;
      ctx.stroke(path);
    }
    ctx.setLineDash([]);
    ctx.lineCap = 'butt';
  }
  // 折線圖層（Float32Array 或 { pts, w, s, e, n }）：只挑看得到的格與 ±360° 副本，度數空間 Path2D 快取後一次換到畫面座標
  // （C2：原本每次重畫把全部圖層每一點都投影、每個副本各一次），多道線由下往上（add-map-overlays D4）
  function strokeLines(lines, passes) {
    const { w, h } = size;
    strokePasses(visibleLinesPath(lines, viewBounds(w, h), worldOffsets(view), 4 / scaleOf(view, w), matrixFor), passes);
  }
  // Grid 格線：每次依視野算出來的少量線，直接投影（不快取）
  function strokeGrid(lines, passes) {
    const { w, h } = size;
    const path = new Path2D();
    for (const line of lines) {
      for (let i = 0; i < line.length; i += 2) {
        const [x, y] = projectRaw(view, w, h, line[i + 1], line[i]);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
    }
    strokePasses(path, passes);
  }
  // 放大後的向量圖：放大到該級才下載（D14）；載入失敗記下時間，DETAIL_RETRY_MS（30 秒）後才再試（飛行中不每幀發請求），
  // 時間到排一次重畫，停在原地的使用者也會再試（code review D19 a）
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
          schedule();
        });
      }
    }
  }
  const readyOf = (kind) => new Set(Object.keys(detail).filter((t) => detail[t][kind]));
  // 視野的經緯度範圍（經度不正規化：以視野中心展開，跨換日線連續）
  function viewBounds(w, h) {
    const tl = unproject(view, w, h, 0, 0);
    const br = unproject(view, w, h, w, h);
    return { west: tl.lon, east: br.lon, south: br.lat, north: tl.lat };
  }
  // 區號與 Grid 標籤（add-map-overlays D6）：置中、放得下才寫、避開 avoid（呼號標籤、標點、國名、先放的標籤）
  function overlayLabels(avoid, bgType, dark, level, bounds) {
    const { w, h } = size;
    const info = { gridLevel: options.grid ? level : 0, gridTexts: [], zoneTexts: { cqZones: [], ituZones: [] } };
    const write = (placed, layer, fontPx, weight, alpha = OVERLAY_LABEL_ALPHA) => {
      const st = overlayLabelStyle(layer, bgType, dark);
      ctx.font = `${weight} ${fontPx}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = alpha;
      for (const n of placed) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = st.halo;
        ctx.strokeText(n.text, n.x + 1, n.y + 1);
        ctx.fillStyle = st.fill;
        ctx.fillText(n.text, n.x + 1, n.y + 1);
      }
      ctx.globalAlpha = 1;
    };
    for (const layer of ['cqZones', 'ituZones']) {
      if (!options[layer] || !zones[layer]?.labels.length) continue;
      const items = zones[layer].labels.map((z) => {
        const [x, y] = project(view, w, h, z.lat, z.lon);
        return { id: `${layer}${z.n}`, text: String(z.n), x, y };
      });
      ctx.font = `700 ${ZONE_FONT_PX}px system-ui, sans-serif`;
      const placed = placeCountryNames(items, { width: w, height: h, measure: (t) => ctx.measureText(t).width, fontPx: ZONE_FONT_PX, avoid, pad: 2, max: 120 });
      write(placed, layer, ZONE_FONT_PX, 700);
      avoid.push(...placed);
      info.zoneTexts[layer] = placed.map((p) => p.text);
    }
    if (options.grid) {
      const items = gridLabels(bounds, level).map((g) => {
        const [x, y] = projectRaw(view, w, h, g.lat, g.lon);
        return { id: g.text, text: g.text, x, y };
      });
      ctx.font = `500 ${GRID_FONT_PX}px system-ui, sans-serif`;
      const placed = placeCountryNames(items, { width: w, height: h, measure: (t) => ctx.measureText(t).width, fontPx: GRID_FONT_PX, avoid, pad: 2, max: 400 });
      write(placed, 'grid', GRID_FONT_PX, 500, 0.7);
      info.gridTexts = placed.map((p) => p.text);
    }
    overlayInfo = info;
  }

  // 線上圖磚（add-map-eox-imagery D3～D6）：依每度（經度方向）像素選層級（0～14），只列看得到的格；
  // 拖曳、縮放、飛行中不換請求清單（舊的照常載完），停下 EOX_IDLE_MS 才換；缺的格先畫快取裡最近的祖先（拉伸頂著）
  // 分兩半：planEox 在畫向量墊底之前（決定要不要畫墊底），drawEox 在墊底之後畫圖磚
  function planEox(w, h, dpr) {
    const bounds = viewBounds(w, h);
    const { z, tiles } = tilesFor(bounds, scaleOf(view, w) * view.k, dpr, { maxZ: eox?.maxZ });
    const now = performance.now();
    // 視野停住 EOX_IDLE_MS 才換請求清單（飛行、拖曳、縮放中不換）
    const vk = `${view.cLon.toFixed(4)},${view.cLat.toFixed(4)},${view.lonSpan.toFixed(4)},${w}x${h}`;
    if (vk !== eoxViewKey) [eoxViewKey, eoxViewAt] = [vk, now];
    const moving = Boolean(flight) || now - lastMoveAt < EOX_IDLE_MS || now - eoxViewAt < EOX_IDLE_MS;
    if (!moving) eox.want(tiles);
    else {
      clearTimeout(eoxTimer);
      eoxTimer = setTimeout(schedule, EOX_IDLE_MS + 20);
    }
    // 畫面整個被目前層級的圖磚蓋住（停住、每格都在快取、上下沒超出圖磚的緯度範圍）：底下的向量陸地不必畫（code review 11）
    const covered = !moving && tiles.length > 0 && bounds.north <= MERC_MAX_LAT && bounds.south >= -MERC_MAX_LAT
      && tiles.every((t) => eox.has(tileKey(t.z, t.x, t.y)));
    return { z, tiles, moving, covered };
  }
  function drawEox(plan, up, w, h, vectorSkipped) {
    const { z, tiles, moving } = plan;
    let counts = { drawn: 0, fallback: 0, missing: tiles.length };
    if (up) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = moving ? 'low' : 'high'; // 移動中每幀重畫：先求快
      // 每格往右下多畫半個像素，格與格之間不透出底色
      counts = drawTileSet(ctx, tiles, eox, (b) => {
        const [x0, y0] = projectRaw(view, w, h, b.n, b.w);
        const [x1, y1] = projectRaw(view, w, h, b.s, b.e);
        return { x: x0, y: y0, w: x1 - x0 + 0.5, h: y1 - y0 + 0.5 };
      });
    }
    eoxInfo = { on: true, status: eox.status, z, tiles: tiles.length, moving, ...counts, vectorSkipped };
  }

  function draw() {
    const { w, h, dpr } = size;
    if (!w || !h || document.hidden) { // 不顯示時不畫；顯示時 ResizeObserver／visibilitychange 會再排
      if (!w || !h) eox?.setVisible(false); // 地圖收起（大小 0）：線上圖磚暫停發請求
      return;
    }
    eox?.setVisible(onScreen);
    if (!view || !userMoved) autoFit();
    if (flight) requestAnimationFrame(() => schedule()); // 飛行中每幀重畫（schedule 會在本幀結束後才接受下一次）
    const c = colors();
    lastColors = c;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.sea;
    ctx.fillRect(0, 0, w, h);
    const dark = isDarkTheme();

    // 放大後改畫向量圖（D14～D16）：每度像素超過門檻時影像淡出、Natural Earth 1:50m／1:10m 陸地淡入（資料還沒到就照舊畫影像）
    const ppd = scaleOf(view, w);
    ensureDetail(ppd);
    const tier = readyTier(ppd, readyOf('land'));
    const img = options.type === 'satellite' || options.type === 'relief' ? basemap : null;
    // 線上圖磚（add-map-eox-imagery D6、D7）：底下照畫向量圖（衛星色調）墊底，上面畫圖磚，不淡出；連不上（down）時整個當簡圖
    const eoxUp = Boolean(eox) && eox.status !== 'down';
    eoxPlan = eox ? planEox(w, h, dpr) : null;
    const skipVector = Boolean(eoxUp && eoxPlan?.covered); // 圖磚整個蓋住：向量墊底不畫
    const fade = !tier ? 0 : img ? vectorFade(ppd) : 1; // 簡圖（或影像還沒載入）：到該級就直接換更細的輪廓
    detailInfo = { pxPerDeg: ppd, tier: fade > 0 ? tier : null, fade: skipVector ? 0 : fade }; // fade：向量圖實際畫的比例
    const palType = img ? options.type : eoxUp ? 'eox' : null;

    // 影像底圖（衛星／地形）：只裁切看得到的部分；影像外（極區、載入前）留海洋色。完全換成向量圖時不畫
    if (img && fade < 1) {
      const crops = basemapCrop(view, w, h, img.naturalWidth, img.naturalHeight);
      // 南北極以外（手機直向看全世界時上下會空很多）：填影像最上／最下一條的平均色
      const edge = edgeColors(img);
      if (edge && crops.length) {
        ctx.fillStyle = edge.top;
        ctx.fillRect(0, 0, w, crops[0].dy + 1);
        ctx.fillStyle = edge.bottom;
        ctx.fillRect(0, crops[0].dy + crops[0].dh - 1, w, h);
      }
      ctx.imageSmoothingQuality = 'high';
      // 換日線兩側的副本各往外多畫半個像素，接縫才不會透出一條細線
      for (const r of crops) ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, r.dx - 0.5, r.dy, r.dw + 1, r.dh);
      // 衛星影像的深海很暗（使用者 2026-10-08：顏色不要那麼深）：以 screen 疊一層淡色，暗部提亮多、亮部提亮少
      if (options.type === 'satellite' && crops.length) {
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = c.satLift;
        ctx.fillRect(0, 0, w, h); // 整片一次（接縫處分開疊會亮一條線）；極區外的填色一起提亮
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    if (fadeCanvas && !(fade > 0 && fade < 1)) {
      fadeCanvas.width = 0; // 不在淡化中：不留整個畫面大小的離屏畫布
      fadeCanvas = null;
    }
    if (skipVector) {
      // 線上圖磚整個蓋住畫面：不畫向量墊底（省一次整個畫面的陸地填色與海岸線）
    } else if (fade > 0) {
      // 向量圖：只取看得到的格（parseLand 已切格），海岸線不含切格的邊。交叉淡化時先完整畫在離屏畫布、再一次以 fade 疊上去
      // （直接在主畫布上海、陸各乘 fade，陸地會帶一層海色：code review D19 d）；fade＝1 直接畫
      const pal = palType ? vectorPalette(palType, dark) : null; // 簡圖用主題色
      const lp = visibleLandPaths(detail[tier].land, viewBounds(w, h), worldOffsets(view), 2 / ppd, matrixFor);
      let g = ctx;
      if (fade < 1) {
        fadeCanvas ??= document.createElement('canvas');
        if (fadeCanvas.width !== base.width || fadeCanvas.height !== base.height) {
          fadeCanvas.width = base.width;
          fadeCanvas.height = base.height;
        }
        g = fadeCanvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      g.fillStyle = pal?.sea ?? c.sea;
      g.fillRect(0, 0, w, h);
      g.fillStyle = pal?.land ?? c.land;
      g.fill(lp.fill, 'evenodd');
      g.strokeStyle = pal?.coast ?? c.coast;
      g.lineWidth = 0.8;
      g.lineJoin = 'round';
      g.stroke(lp.coast);
      if (g !== ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = fade;
        ctx.drawImage(fadeCanvas, 0, 0);
        ctx.globalAlpha = 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    } else if (!img) {
      // 陸地（1:110m）：外環與內環（湖、內海）一起 even-odd 填色；平移 ±360° 補滿視野（同 FT8TW）
      const land = new Path2D();
      for (const off of worldOffsets(view)) {
        for (const ring of outline) {
          for (let i = 0; i < ring.length; i += 2) {
            const [x, y] = projectRaw(view, w, h, ring[i + 1], ring[i] + off);
            if (i === 0) land.moveTo(x, y);
            else land.lineTo(x, y);
          }
          land.closePath();
        }
      }
      const pal = palType ? vectorPalette(palType, dark) : null;
      if (pal) {
        ctx.fillStyle = pal.sea;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.fillStyle = pal?.land ?? c.land;
      ctx.fill(land, 'evenodd');
      ctx.strokeStyle = pal?.coast ?? c.coast;
      ctx.lineWidth = 0.8;
      ctx.stroke(land);
    }
    if (eoxPlan) drawEox(eoxPlan, eoxUp, w, h, skipVector);

    // 日夜分界：黑夜區疊一層淡淡的黑（亮度約 −30%），晨昏帶漸變；同底圖影像依視野裁切
    if (options.daynight) {
      const mask = nightLayer(Date.now());
      ctx.imageSmoothingEnabled = true;
      for (const r of basemapCrop(view, w, h, MASK_W, MASK_H)) ctx.drawImage(mask, r.sx, r.sy, r.sw, r.sh, r.dx - 0.5, r.dy, r.dw + 1, r.dh);
      // 晨昏線：淡淡的暖色細線
      const term = terminatorPoints(subsolarPoint(Date.now()));
      const tp = new Path2D();
      for (const off of worldOffsets(view)) {
        term.forEach((p, i) => {
          const [x, y] = projectRaw(view, w, h, p.lat, p.lon + off);
          if (i === 0) tp.moveTo(x, y);
          else tp.lineTo(x, y);
        });
      }
      ctx.strokeStyle = TERMINATOR_COLOR;
      ctx.lineWidth = 1.2;
      ctx.stroke(tp);
    }

    // 圖層與國界（add-map-overlays D4）：州界在國界下面，Grid、CQ、ITU 在國界上面；都是 ±360° 補滿、依底圖一或兩道線
    const bgType = img ? options.type : eoxUp ? 'satellite' : 'outline'; // 線上圖磚的國界、圖層、標籤同衛星影像的樣式
    // 州界、國界也跟著放大換細的一級（1:10m 州界另外下載；1:50m 州界就是 admin1.json）
    const stTier = readyTier(ppd, readyOf('states'));
    const stLines = stTier === '10m' ? detail['10m'].states : states;
    if (options.states && stLines.length) strokeLines(stLines, overlayStyle('states', bgType, dark));
    // 國界（Natural Earth 1:110m／50m／10m）：影像上兩道線（深色外框＋淺色細線等，countrylayer.borderStyle）
    const bTier = readyTier(ppd, readyOf('borders'));
    const bLines = bTier ? detail[bTier].borders : borders;
    if (options.borders && bLines.length) strokeLines(bLines, borderStyle(bgType, dark).map((p) => ({ ...p, color: p.color ?? c.border })));
    const bounds = viewBounds(w, h);
    const level = gridLevel(view.lonSpan);
    if (options.grid) {
      const g = gridLines(bounds, level);
      const passes = overlayStyle('grid', bgType, dark);
      if (g.fine.length) {
        ctx.globalAlpha = FINE_GRID_ALPHA; // 4 碼格線淡一點，2 碼格線（較粗）看得出大格
        strokeGrid(g.fine, passes);
        ctx.globalAlpha = 1;
      }
      strokeGrid(g.coarse, level === 4 ? passes.map((p) => ({ ...p, width: p.width + 0.7 })) : passes);
    }
    for (const layer of ['cqZones', 'ituZones']) if (options[layer] && zones[layer]?.lines.length) strokeLines(zones[layer].lines, overlayStyle(layer, bgType, dark));

    const list = located();

    // 誰呼叫誰（同 FT8TW 網格追蹤地圖）：細線、接收方端一個小點標方向；概略位置畫虛線。畫在航線與標點下面。
    // 靜態層畫淡色完整線；亮線的循環動畫由 compose() 每幀畫
    linkGeoms = links.map((l) => ({
      line: polyline(routePoints(l.a, l.b, w, h)), color: l.toMe ? c.me : c.other, dashed: l.a.approx || l.b.approx, born: births.get(linkKey(l)) ?? 0,
    }));
    for (const g of linkGeoms) withCopies(ctx, g.line, () => strokeLink(ctx, g.line.points, g, { alpha: reducedMotion?.matches ? 0.75 : LINK_BASE_ALPHA, base: true }));

    // 我方 → 目前對象的大圓航線、對方 → 第三台（細線）；任一端是概略位置（國家中心點）時畫虛線（同 FT8TW）
    line1 = null;
    line2 = null;
    if (scene?.me && scene.them) {
      const pts = routePoints(scene.me, scene.them, w, h);
      line1 = polyline(pts);
      withCopies(ctx, line1, () => strokeRoute(pts, { dashed: scene.me.approx || scene.them.approx, thin: false, color: c.ink }));
    }
    if (scene?.them && scene.third) {
      let pts = routePoints(scene.them, scene.third, w, h);
      // 起點接在第一條航線的終點（同一個 ±360° 副本），平移到視野邊緣時兩條線才接得上
      const join = line1?.points.at(-1);
      if (join) pts = pts.map((p) => ({ x: p.x + join.x - pts[0].x, y: p.y }));
      line2 = polyline(pts);
      withCopies(ctx, line2, () => {
        strokeRoute(pts, { dashed: true, thin: true, color: c.other });
        const end = pts.at(-1);
        ctx.beginPath();
        ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = c.halo;
        ctx.fill();
        ctx.strokeStyle = c.other;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    // 標點：優先順序低的先畫，高的蓋在上面
    points = list.map((p) => {
      const [x, y] = project(view, w, h, p.lat, p.lon);
      return { call: p.call, x, y, kind: p.kind, approx: p.approx, lastUtc: p.lastUtc };
    });
    // 呼號標籤先決定位置（高優先先放，放不下就省略）；國名放在剩下的空間，不蓋呼號與標點
    ctx.font = `${FONT_PX}px system-ui, sans-serif`;
    // 選取的電台排第一（最先放），文字粗體（量寬度也用粗體）
    const items = labelItems(selectedFirst(points, selected));
    const isSelText = (t) => Boolean(selected) && (t === selected || t.startsWith(`${selected} `));
    const measure = (t) => {
      if (!isSelText(t)) return ctx.measureText(t).width;
      ctx.font = `700 ${FONT_PX}px system-ui, sans-serif`;
      const wd = ctx.measureText(t).width;
      ctx.font = `${FONT_PX}px system-ui, sans-serif`;
      return wd;
    };
    const labels = placeLabels(items, { width: w, height: h, measure, fontPx: FONT_PX });
    namesShown = 0;
    let placedNames = [];
    const dotBoxes = () => {
      const boxes = points.map((p) => ({ x: p.x - 7, y: p.y - 7, w: 14, h: 14 }));
      if (me) {
        const [x, y] = project(view, w, h, me.lat, me.lon);
        boxes.push({ x: x - 8, y: y - 8, w: 16, h: 16 });
      }
      return boxes;
    };
    if (options.names && countries.length) {
      const avoid = [...labels, ...dotBoxes()];
      const named = countryLabels(countries, { lonSpan: view.lonSpan, locale: options.locale }).map((n) => {
        const [x, y] = project(view, w, h, n.lat, n.lon);
        return { ...n, x, y };
      });
      ctx.font = `600 ${NAME_FONT_PX}px system-ui, sans-serif`;
      const names = placeCountryNames(named, { width: w, height: h, measure: (t) => ctx.measureText(t).width, fontPx: NAME_FONT_PX, avoid });
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      for (const n of names) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = img || eoxUp ? c.nameHaloOnImage : c.nameHalo;
        ctx.strokeText(n.text, n.x + 1, n.y + 1);
        ctx.fillStyle = img || eoxUp ? c.nameOnImage : c.name;
        ctx.fillText(n.text, n.x + 1, n.y + 1);
      }
      namesShown = names.length;
      namesText = names.map((n) => n.text);
      placedNames = names;
    } else namesText = [];
    overlayLabels([...labels, ...dotBoxes(), ...placedNames], bgType, dark, level, bounds);
    const fill = { target: c.ink, me: c.me, cq: c.cq, other: c.other };
    const radius = RADIUS;
    // 經度跨度超過一圈（壓矮地圖，左右重複世界）：標點也畫在副本上，副本上的連線兩端才有電台（C4）；標籤、點選只在中間那份
    const worldPx = (360 * w) / view.lonSpan;
    const xsOf = (x) => (view.lonSpan > 360 ? copyXs(x, w, worldPx) : [x]);
    // 不只靠顏色（FT8TW 維護者是紅綠色盲）：目前對象粗外圈、叫我實心＋外圈、概略位置虛線圈
    const marker = (p) => {
      const r = radius[p.kind];
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = c.halo;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = p.kind === 'target' ? c.halo : fill[p.kind];
      ctx.fill();
      if (p.kind === 'target' || p.kind === 'me') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.kind === 'target' ? 7 : r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = p.kind === 'target' ? c.ink : c.me;
        ctx.lineWidth = p.kind === 'target' ? 2.5 : 1.5;
        ctx.stroke();
      }
      if (p.approx) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = c.other;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    // 選取的電台照常畫標點與外圈（目前對象、叫我、概略位置不被蓋掉，B2），選取光環最後疊上去
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      if (p.y < -20 || p.y > h + 20) continue;
      for (const x of xsOf(p.x)) if (x >= -20 && x <= w + 20) marker({ ...p, x });
    }

    // 我的位置：白色光暈＋實心墨色點（同 FT8TW drawMe）
    if (me) {
      const [x0, y] = project(view, w, h, me.lat, me.lon);
      for (const x of xsOf(x0)) {
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = c.halo;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = c.ink;
        ctx.fill();
      }
    }
    const sp = selectedPoint();
    if (sp) {
      drawSelectedMark(ctx, sp.x, sp.y, {
        kind: sp.kind, r: radius[sp.kind], approx: Boolean(sp.approx), fill: fill[sp.kind], halo: c.halo, ink: c.ink, callme: c.me, other: c.other, color: c.selected,
        reduced: Boolean(reducedMotion?.matches) || !pulseActive(performance.now(), selectedAt), // 閃完改靜態粗環
      });
    }

    // 呼號標籤（位置在上面已決定）
    ctx.font = `${FONT_PX}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const byCall = new Map(points.map((p) => [p.call, p]));
    const textOf = new Map(items.map((it) => [it.id, it.text]));
    const selLabel = labels.find((l) => l.id === selected);
    for (const l of labels) {
      if (l === selLabel) continue;
      const p = byCall.get(l.id);
      ctx.fillStyle = c.halo;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(l.x, l.y, l.w, l.h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.kind === 'other' ? c.other : fill[p.kind];
      ctx.fillText(textOf.get(l.id), l.x + 1, l.y + 1);
    }
    // 選取的電台的呼號：不透明底、選取色細框、粗體，畫在最上層
    if (selLabel) {
      ctx.fillStyle = c.halo;
      ctx.fillRect(selLabel.x, selLabel.y, selLabel.w, selLabel.h);
      ctx.strokeStyle = c.selected;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(selLabel.x, selLabel.y, selLabel.w, selLabel.h);
      ctx.font = `700 ${FONT_PX}px system-ui, sans-serif`;
      ctx.fillStyle = c.ink;
      ctx.fillText(textOf.get(selLabel.id), selLabel.x + 1, selLabel.y + 1);
    }
    labelBoxes = labels.map((l) => ({ ...l }));
    canvas.dataset.labels = String(labels.length);
  }

  // ── 尺寸：跟著容器；0×0（被隱藏）時不畫 ──
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    if (w && h) {
      canvas.width = base.width = Math.round(w * dpr);
      canvas.height = base.height = Math.round(h * dpr);
    }
    schedule();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ── 手勢：滾輪縮放、拖曳平移、雙指縮放、點選 ──
  const pointers = new Map(); // pointerId → { x, y }
  let tap = null; // { x, y, moved }
  let pinchDist = 0;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const moved = (next) => {
    flight = null; // 使用者一動手就停止自動飛行
    lastMoveAt = performance.now();
    view = next;
    userMoved = true;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { userMoved = false; schedule(); }, resumeMs); // 停手一段時間後恢復自動框住（飛回去）
    schedule();
  };

  function onWheel(e) {
    if (!view) return;
    e.preventDefault();
    const { x, y } = local(e);
    moved(zoomAt(view, size.w, size.h, x, y, Math.exp(-e.deltaY * WHEEL_ZOOM)));
  }
  // 右鍵、觸控長按：開地圖設定（add-map-settings-globe D2）；不選取電台
  let press = null; // { id, timer }
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
  function onDown(e) {
    // 滑鼠右鍵、中鍵：不算點選、不拖曳（Windows Chrome 的 pointerup 比 contextmenu 先到，右鍵會順便選到電台）
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    tap = pointers.size === 1 ? { ...p, moved: false } : null;
    cancelPress();
    if (onSettings && e.pointerType === 'touch' && pointers.size === 1) {
      press = { id: e.pointerId, timer: setTimeout(() => {
        openSettings();
        swallowClick(); // 放開手指產生的 click 落在對話框背景上：吞掉，不關閉
      }, LONG_PRESS_MS) };
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }
  function onMove(e) {
    const prev = pointers.get(e.pointerId);
    if (!prev || !view) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP_PX) {
      tap.moved = true;
      cancelPress();
    }
    if (pointers.size > 1) cancelPress();
    if (pointers.size === 1) {
      if (tap?.moved) moved(panBy(view, size.w, p.x - prev.x, p.y - prev.y));
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) moved(zoomAt(view, size.w, size.h, (a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist));
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
    if (pointers.size === 0) tap = null;
    pinchDist = 0;
  }
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', onContext);

  // ── 深淺色切換、分頁回到前景 ──
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', schedule);
  const themeObserver = new MutationObserver(schedule);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', schedule);

  resize();

  return {
    setMe(grid) {
      const next = grid ? gridToLatLon(grid) : null;
      if (next?.lat === me?.lat && next?.lon === me?.lon) return;
      me = next;
      schedule();
    },
    update(next) {
      stations = next ?? [];
      schedule();
    },
    setRipples(calls) {
      const next = new Set(calls ?? []);
      if (next.size === ripples.size && [...next].every((c) => ripples.has(c))) return;
      ripples = next;
      if (!ripples.size) compose(); // 漣漪都停了：貼回靜態層，不留最後一幀的圓圈
      startAnim();
    },
    setLinks(next) {
      links = next ?? [];
      // 新出現的連線記下動畫起點（依序錯開）；同一對在新 slot 又叫一次會從頭畫
      const now = performance.now();
      const keep = new Set(links.map(linkKey));
      for (const k of births.keys()) if (!keep.has(k)) births.delete(k);
      let n = 0;
      for (const l of links) {
        const k = linkKey(l);
        if (!births.has(k)) births.set(k, now + ((LINK_STAGGER_MS * n++) % LINK_CYCLE.period));
      }
      schedule();
    },
    setTarget(call) {
      const next = call || null;
      if (next === target) return;
      target = next;
      schedule();
    },
    // 清單左鍵選取的電台（add-map-overlays E）；null＝取消
    setSelected(call) {
      const next = call || null;
      if (next === selected) return;
      selected = next;
      selectedAt = next ? performance.now() : null;
      clearTimeout(pulseTimer);
      if (next) pulseTimer = setTimeout(schedule, SELECT_PULSE_LIMIT_MS + 50); // 閃完重畫一次（靜態粗環）
      schedule();
    },
    // 呼叫場景（scene.mjs buildScene）：位置變了重畫靜態層；只有狀態變了只換動畫
    setScene(next) {
      const prev = scene;
      const geometry = !sameGeometry(prev, next) && (prev || next);
      scene = next;
      if (geometry) schedule();
      else if (prev?.animated && !next?.animated) compose(); // 動畫停了：貼回靜態層，不留最後一幀的光點
      startAnim();
    },
    // 地圖設定（add-map-settings-globe）：底圖種類、國界、國名、語系；素材第一次用到才下載
    setOptions(next) {
      options = { ...options, ...next };
      basemap = null;
      useEox(options.type === 'eox');
      if (!eox) eoxInfo = { ...eoxInfo, on: false, status: 'off' };
      if (options.type === 'satellite' || options.type === 'relief') {
        const want = options.type;
        loadBasemap(want).then((img) => {
          if (destroyed || options.type !== want) return;
          basemap = img;
          schedule();
        });
      }
      if (options.borders && !borders.length) loadBorders().then((b) => { if (destroyed) return; borders = b; schedule(); });
      if (options.names && !countries.length) loadCountries().then((c) => { if (destroyed) return; countries = c; schedule(); });
      for (const layer of ['cqZones', 'ituZones']) {
        if (options[layer] && !zones[layer]?.lines.length) loadZones(layer).then((z) => { if (destroyed) return; zones[layer] = z; schedule(); });
      }
      if (options.states && !states.length) loadStates().then((st) => { if (destroyed) return; states = st; schedule(); });
      schedule();
    },
    resize,
    // 回到自動框住全部電台（使用者縮放／平移過之後）
    fit() {
      clearTimeout(resumeTimer);
      userMoved = false;
      schedule();
    },
    destroy() {
      destroyed = true;
      clearTimeout(resumeTimer);
      clearTimeout(pulseTimer);
      clearTimeout(detailTimer);
      clearTimeout(eoxTimer);
      eoxUnsub?.();
      // 取消請求（code review 9）：排隊丟掉、進行中中止；切換 2D／3D 時新的繪製層停住 150 ms 後重新要（中止時已解好的圖照樣進快取）
      peekEoxSource()?.cancel();
      clearInterval(sunTimer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(anim);
      io?.disconnect();
      ro.disconnect();
      themeObserver.disconnect();
      media?.removeEventListener?.('change', schedule);
      document.removeEventListener('visibilitychange', schedule);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('contextmenu', onContext);
      cancelPress();
    },
    // 自動化檢查用：目前視野、尺寸、標點像素位置、陸地 ring 數
    setResumeMs(ms) { resumeMs = ms; }, // 測試用：縮短恢復自動框住的時間
    // 測試用：把視野移到 { lat, lon, lonSpan }（同使用者手動移動：暫停自動框住）
    lookAt({ lat, lon, lonSpan }) {
      moved({ cLon: wrapLon(lon), cLat: lat, lonSpan, k: kFor(lat) });
    },
    debug: () => ({ renderer: '2d', options: { ...options }, basemapReady: Boolean(basemap), borders: borders.length, names: namesShown, view, flying: Boolean(flight), flyStage: flightStage(), overviews, overviewRetargets,
      // 每條連線兩端畫在畫布內的位置（±360° 副本中落在畫布內的那些）：瀏覽器檢查的「電台都在畫面內」不變式
      linkEnds: linkGeoms.map((g, i) => {
        const ends = (p) => copiesOf(g.line).map((dx) => [p.x + dx, p.y]).filter(([x, y]) => x >= 0 && x <= size.w && y >= 0 && y <= size.h);
        return { link: links[i] ? `${links[i].from}>${links[i].to}` : '', a: ends(g.line.points[0]), b: ends(g.line.points.at(-1)) };
      }),
      linkExtent: linkGeoms.length ? linkGeoms.flatMap((g) => g.line.points).reduce((e, p) => ({ minX: Math.min(e.minX, p.x), maxX: Math.max(e.maxX, p.x), minY: Math.min(e.minY, p.y), maxY: Math.max(e.maxY, p.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }) : null, size: { w: size.w, h: size.h }, points: points.map((p) => ({ ...p })), rings: outline.length, me, target, userMoved,
      scene, routes: { line1: line1?.length ?? 0, line2: line2?.length ?? 0 }, links: links.map((l) => `${l.from}>${l.to}`), linksAnimating: linksAnimating(), ripples: [...ripples], animating: anim !== 0,
      picked, nameTexts: [...namesText], dark: isDarkTheme(), selected: selectedPoint()?.call ?? null, labelBoxes: labelBoxes.map((l) => ({ ...l })),
      selectPulsing: selectAnimating(), detail: { ...detailInfo, loaded: [...detailReq.keys()].filter((k) => detail[k.split(':')[0]][k.split(':')[1]]),
        failed: [...detailReq].filter(([, r]) => r.failedAt !== null).map(([k]) => k) },
      eox: { ...eoxInfo, stats: peekEoxSource()?.stats() ?? null },
      overlays: { states: states.length, cqZones: zones.cqZones?.lines.length ?? 0, ituZones: zones.ituZones?.lines.length ?? 0 },
      gridLevel: overlayInfo.gridLevel, gridTexts: [...overlayInfo.gridTexts], zoneTexts: { cqZones: [...overlayInfo.zoneTexts.cqZones], ituZones: [...overlayInfo.zoneTexts.ituZones] },
      // 畫面像素取樣：[{ lat, lon, dx, dy }]（dx、dy 為 CSS 像素位移）→ [{ x, y, rgb }]（畫面外 null）
      probe(list) {
        return list.map(({ lat, lon, dx = 0, dy = 0 }) => {
          const [px, py] = project(view, size.w, size.h, lat, lon);
          const x = px + dx, y = py + dy;
          if (!(x >= 0 && y >= 0 && x < size.w && y < size.h)) return null;
          const d = out.getImageData(Math.floor(x * size.dpr), Math.floor(y * size.dpr), 1, 1).data;
          return { x, y, rgb: [d[0], d[1], d[2]] };
        });
      },
    }),
  };
}
