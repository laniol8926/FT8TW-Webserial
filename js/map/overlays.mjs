// 地圖圖層（add-map-overlays D2、D5～D7）：CQ／ITU Zone、州界的資料解析，Maidenhead Grid 的線與標籤，各圖層的線條樣式。
// 純函式，有單元測試；畫在 map.mjs（2D）與 globe.mjs（3D overlay），載入在 layers.mjs。
//   cqzones.json／ituzones.json：{ v:1, scale:100, lines:[[lon×100, lat×100, …], …], labels:[{ n, lat, lon }] }
//   admin1.json：{ v:1, scale:100, lines }（同 borders.json）
// Grid：視野跨度 > 40° 畫 2 碼（20°×10°），以內畫 4 碼（2°×1°）；經度用展開值（跨換日線連續），標籤文字先把經度正規化。
import { latLonToGrid } from '../maidenhead.mjs';
import { wrapLon } from './projection.mjs';

export const MAX_OVERLAY_LINES = 5000;
export const MAX_OVERLAY_POINTS = 200_000;
export const MAX_ZONE_LABELS = 200;
export const GRID_FINE_SPAN = 40;
export const MAX_GRID_LINES = 300;
export const MAX_GRID_CELLS = 2000;
// 畫的順序（下→上）：州界在國界下面（map.mjs 先畫州界再畫國界），其餘在國界上面
export const OVERLAY_LAYERS = Object.freeze(['states', 'grid', 'cqZones', 'ituZones']);

const EMPTY_ZONES = Object.freeze({ lines: Object.freeze([]), labels: Object.freeze([]) });

// 折線：整數 → 度（Float32Array lon, lat, …）；壞的那條略過，總數超過上限整個回空（同 countrylayer.parseBorders）
function parseLines(json, lonMax) {
  if (!json || json.v !== 1 || !Array.isArray(json.lines) || !(json.scale > 0)) return null;
  if (json.lines.length > MAX_OVERLAY_LINES) return null;
  const out = [];
  let total = 0;
  for (const line of json.lines) {
    if (!Array.isArray(line) || line.length < 4 || line.length % 2) continue;
    total += line.length / 2;
    if (total > MAX_OVERLAY_POINTS) return null;
    const f = new Float32Array(line.length);
    let ok = true;
    for (let i = 0; i < line.length; i++) {
      const v = line[i] / json.scale;
      if (!Number.isFinite(v) || Math.abs(v) > (i % 2 ? 90 : lonMax)) {
        ok = false;
        break;
      }
      f[i] = v;
    }
    if (ok) out.push(f);
  }
  return out;
}

/** CQ／ITU Zone：{ lines: [Float32Array], labels: [{ n, lat, lon }] }。Zone 的經度允許 ±360°（資料把跨換日線的區寫成展開經度） */
export function parseZones(json, { maxNumber }) {
  const lines = parseLines(json, 360);
  if (!lines) return { lines: [], labels: [] };
  const labels = [];
  const raw = Array.isArray(json.labels) && json.labels.length <= MAX_ZONE_LABELS ? json.labels : [];
  const seen = new Set();
  for (const l of raw) {
    const n = l?.n;
    if (!Number.isInteger(n) || n < 1 || n > maxNumber || seen.has(n)) continue;
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lon) || Math.abs(l.lat) > 90 || Math.abs(l.lon) > 360) continue;
    seen.add(n);
    labels.push({ n, lat: l.lat, lon: l.lon });
  }
  return lines.length || labels.length ? { lines, labels } : { ...EMPTY_ZONES };
}

/** 州界（一級行政區界線）：[Float32Array] */
export function parseStates(json) {
  return parseLines(json, 180) ?? [];
}

/** 2 或 4（碼） */
export function gridLevel(lonSpan) {
  return lonSpan > GRID_FINE_SPAN ? 2 : 4;
}

const STEP = { 2: [20, 10], 4: [2, 1] };
// lo～hi 之間 step 的整數倍（含兩端）
function multiples(lo, hi, step) {
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
// a → b 的直線，sampleDeg 有限時每 sampleDeg 取一點（3D：經緯線在球面上是弧）
function segment(lon1, lat1, lon2, lat2, sampleDeg) {
  const len = Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1));
  const n = Number.isFinite(sampleDeg) && sampleDeg > 0 ? Math.max(1, Math.ceil(len / sampleDeg - 1e-9)) : 1;
  const f = new Float32Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    f[2 * i] = lon1 + ((lon2 - lon1) * i) / n;
    f[2 * i + 1] = lat1 + ((lat2 - lat1) * i) / n;
  }
  return f;
}
function linesAt(b, [dLon, dLat], sampleDeg) {
  const south = Math.max(-90, b.south);
  const north = Math.min(90, b.north);
  const out = [];
  for (const lon of multiples(b.west, b.east, dLon)) out.push(segment(lon, south, lon, north, sampleDeg));
  for (const lat of multiples(south, north, dLat)) if (Math.abs(lat) < 90) out.push(segment(b.west, lat, b.east, lat, sampleDeg));
  return out;
}

/**
 * Grid 格線（bounds 的經度可超出 ±180°，跨換日線時連續）
 * @returns {{ coarse: Float32Array[], fine: Float32Array[] }}（coarse＝2 碼格線；fine＝4 碼格線，level 2 時空；太多時也空）
 */
export function gridLines(bounds, level, sampleDeg = Infinity) {
  const coarse = linesAt(bounds, STEP[2], sampleDeg);
  if (level !== 4) return { coarse, fine: [] };
  const fine = linesAt(bounds, STEP[4], sampleDeg);
  return { coarse, fine: fine.length > MAX_GRID_LINES ? [] : fine };
}

/**
 * 3D 的 Grid 範圍（D7、C6）：2 碼畫全球（east 取 180° 前一點，±180° 經線在球面上是同一條，只畫一次）；
 * 4 碼只畫相機中心附近：緯度 ±0.75 等效跨度、經度再除以 cos(緯度)（高緯度經線收攏，同樣寬的畫面涵蓋更多經度），
 * 中心取整到 2°×1°（移動一點點不必重算）。key 給快取用
 */
export function globeGridBounds(level, cam, span) {
  if (level === 2) return { west: -180, east: 180 - 1e-6, south: -90, north: 90, key: '2' };
  const cLon = Math.round(cam.lon / 2) * 2;
  const cLat = Math.round(cam.lat);
  const latHalf = Math.min(90, span * 0.75);
  const lonHalf = Math.min(180 - 1e-6, latHalf / Math.max(0.1, Math.cos((cLat * Math.PI) / 180)));
  return { west: cLon - lonHalf, east: cLon + lonHalf, south: cLat - latHalf, north: cLat + latHalf, key: `4:${cLon},${cLat},${Math.round(latHalf)}` };
}

/** Grid 標籤：格子中心在 bounds 內的 [{ text, lat, lon }]（lon 為展開值，畫的時候直接用）；格子太多回空 */
export function gridLabels(bounds, level) {
  const [dLon, dLat] = STEP[level] ?? STEP[2];
  const south = Math.max(-90, bounds.south);
  const north = Math.min(90, bounds.north);
  const lons = multiples(bounds.west - dLon / 2, bounds.east - dLon / 2, dLon).map((v) => v + dLon / 2);
  const lats = multiples(south - dLat / 2, north - dLat / 2, dLat).map((v) => v + dLat / 2).filter((v) => Math.abs(v) < 90);
  if (lons.length * lats.length > MAX_GRID_CELLS) return [];
  const out = [];
  for (const lat of lats) for (const lon of lons) out.push({ text: latLonToGrid(lat, wrapLon(lon)).slice(0, level), lat, lon });
  return out;
}

// ── 樣式（D5）：Grid 灰、CQ 橘、ITU 藍綠、州界淡紫。簡圖一道線（深淺色各一組）；影像（衛星、地形淡色）先畫深色外框再畫亮色線 ──
const line = (color, width, dash) => Object.freeze(dash ? { color, width, dash: Object.freeze(dash) } : { color, width });
// 州界（使用者 2026-10-09：州界看起來比國界顯眼）：一道 0.6 px 半透明虛線、不加外框，國界（countrylayer.borderStyle）至少粗一倍
const STATE_DASH = [4, 3];
const PLAIN = {
  light: { grid: ['rgba(70,82,96,0.5)', 0.8], cqZones: ['#D9731A', 1.3], ituZones: ['#0F8C8C', 1.3], states: ['rgba(130,100,150,0.55)', 0.6] },
  dark: { grid: ['rgba(205,215,225,0.38)', 0.8], cqZones: ['#F2A65A', 1.3], ituZones: ['#4FD1C5', 1.3], states: ['rgba(190,170,205,0.5)', 0.6] },
};
const ON_IMAGE = { grid: ['rgba(255,255,255,0.65)', 0.8], cqZones: ['#FFA94D', 1.3], ituZones: ['#5CE1D6', 1.3] };
// 州界在影像上：衛星（暗底）淡白、地形淡色（亮底）淡深紫（同國界色系、淡很多）
const STATES_ON = { satellite: ['rgba(255,255,255,0.5)', 0.7], relief: ['rgba(58,36,74,0.45)', 0.7] };
const CASING = 'rgba(0,0,0,0.4)';
const LABEL = {
  light: { grid: '#4E5A68', cqZones: '#B4560A', ituZones: '#0A6E6E', states: '#7D5F8E' },
  dark: { grid: '#C3CDD8', cqZones: '#F7B26E', ituZones: '#6FE0D5', states: '#C3AED0' },
};

/** 圖層線條：[{ color, width, dash? }]（先畫的在下面）；不認得的圖層回空、不認得的底圖當簡圖 */
export function overlayStyle(layer, type, dark = false) {
  const plain = PLAIN[dark ? 'dark' : 'light'][layer];
  if (!plain) return [];
  const onImage = type === 'satellite' || type === 'relief';
  if (layer === 'states') {
    const [color, width] = onImage ? STATES_ON[type] : plain;
    return [line(color, width, STATE_DASH)];
  }
  if (!onImage) return [line(plain[0], plain[1])];
  const [color, width] = ON_IMAGE[layer];
  return [line(CASING, width + 1.4), line(color, width)];
}

/** 區號、Grid 標籤的文字色與光暈（小字、半透明由呼叫端 globalAlpha 控制） */
// 衛星影像是暗底：亮字深光暈；地形淡色是亮底（深淺色主題都一樣）：深字淺光暈，同簡圖淺色
export function overlayLabelStyle(layer, type, dark = false) {
  if (type === 'satellite') return { fill: ON_IMAGE[layer]?.[0] ?? STATES_ON.satellite[0], halo: 'rgba(0,0,0,0.6)' };
  const light = type === 'relief' || !dark;
  return { fill: LABEL[light ? 'light' : 'dark'][layer] ?? '#555555', halo: light ? 'rgba(255,255,255,0.85)' : 'rgba(22,29,38,0.85)' };
}
