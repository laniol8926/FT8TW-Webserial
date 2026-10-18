// 地圖投影：等距圓柱投影（equirectangular），同 FT8TW MapGeometry／StationMapView。
// 東西向用視野中心緯度的 cos 修正（中緯度不被拉長），k 在 fitView 時決定、平移時固定，
// 免得上下拖曳時整張地圖一直變形。全部是純函式，有單元測試。
//
// 視野 view = { cLon, cLat, lonSpan, k }：中心經緯度、畫面寬度涵蓋的經度跨度、東西向修正係數。
// 經度一律「以參考點為基準展開」：跨過 ±180° 時不從地圖右緣跳到左緣（同 FT8TW unwrapLon）。

/** 等距圓柱投影在極區會把面積拉得很誇張，視野緯度夾在這個範圍內（同 FT8TW）。 */
export const MAX_LAT = 85;
export const MIN_LON_SPAN = 1; // 最大放大：畫面寬約 1 度（4 碼網格是 2×1 度）
export const MAX_LON_SPAN = 400; // 最小縮小：略大於一圈，看得到整個世界
// 自動框住的經度跨度上限（add-map-overlays D10）：又矮又寬的地圖（拖曳分隔線壓扁）要框住南北，經度只好超過一圈（左右重複世界）
export const MAX_FIT_LON_SPAN = 1800;
const OFFSET_SLACK = 30; // Zone 資料的經度最多超出 ±180° 約 25°
const K_FLOOR = 0.2;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 把 lon 平移整數個 360°，讓它與 refLon 的差距落在 [-180, 180)。 */
export function unwrapLon(lon, refLon) {
  let d = lon - refLon;
  d -= 360 * Math.round(d / 360); // Math.round(0.5)=1、Math.round(-0.5)=-0：差距正好 ±180 都變成 -180
  return refLon + d;
}

/** 經度正規化到 [-180, 180)。 */
export function wrapLon(lon) {
  return unwrapLon(lon, 0);
}

export function kFor(lat) {
  return Math.max(K_FLOOR, Math.cos(toRad(lat)));
}

/**
 * 展開經度的基準：把畫面接縫（基準 ±180°）放在所有點經度之間最大的空隙中間（add-map-overlays D10）。
 * 原本以第一點（我方）為基準，接縫固定在我方對面；台灣看歐美時接縫在大西洋上，歐美之間的連線就畫到畫面外。
 */
export function seamRef(points) {
  const lons = points.map((p) => wrapLon(p.lon)).sort((a, b) => a - b);
  let gap = lons[0] + 360 - lons.at(-1); // 繞過 ±180° 的那一段
  let start = lons[0];
  for (let i = 1; i < lons.length; i++) {
    if (lons[i] - lons[i - 1] > gap + 1e-9) [gap, start] = [lons[i] - lons[i - 1], lons[i]];
  }
  return start - gap / 2 + 180; // 接縫在空隙中間：start − gap/2 ＝ ref − 180
}

/**
 * 框住所有點（{lat, lon}）的視野，再擴大成畫面的長寬比（只放大不縮小）。同 FT8TW frame()＋fitAspect()。
 * 沒有點時回整個世界（緯度 -60～85，同 FT8TW）。
 * @param marginFraction 每一邊加上跨度的這個比例
 * @param minSpanDeg 經緯度跨度的下限；只有一點或很近時才看得出在哪裡
 */
export function fitView(points, width, height, { marginFraction = 0.15, minSpanDeg = 20 } = {}) {
  let minLon, maxLon, minLat, maxLat;
  if (!points.length) {
    [minLon, maxLon, minLat, maxLat] = [-180, 180, -60, MAX_LAT];
  } else {
    const ref = seamRef(points);
    minLat = minLon = Infinity;
    maxLat = maxLon = -Infinity;
    for (const p of points) {
      const lon = unwrapLon(p.lon, ref);
      minLat = Math.min(minLat, p.lat);
      maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
    const lonSpan = Math.max(maxLon - minLon, minSpanDeg) * (1 + 2 * marginFraction);
    const latSpan = Math.max(maxLat - minLat, minSpanDeg) * (1 + 2 * marginFraction);
    const cLon = (minLon + maxLon) / 2;
    const cLat = (minLat + maxLat) / 2;
    [minLon, maxLon] = [cLon - lonSpan / 2, cLon + lonSpan / 2];
    [minLat, maxLat] = [Math.max(-MAX_LAT, cLat - latSpan / 2), Math.min(MAX_LAT, cLat + latSpan / 2)];
  }
  // fitAspect：擴大到畫面長寬比
  const aspect = width > 0 && height > 0 ? width / height : 1;
  let cLat = (minLat + maxLat) / 2;
  const k = kFor(cLat);
  let lonSpan = maxLon - minLon;
  let latSpan = maxLat - minLat;
  if ((lonSpan * k) / latSpan < aspect) lonSpan = (latSpan * aspect) / k;
  else latSpan = (lonSpan * k) / aspect;
  let lo = cLat - latSpan / 2;
  let hi = cLat + latSpan / 2;
  if (hi > MAX_LAT) [lo, hi] = [lo - (hi - MAX_LAT), MAX_LAT];
  if (lo < -MAX_LAT) [lo, hi] = [-MAX_LAT, Math.min(MAX_LAT, hi + (-MAX_LAT - lo))];
  cLat = (lo + hi) / 2;
  // 經度不必看到比一圈多（MAX_LON_SPAN），但為了框住南北可以放寬到 MAX_FIT_LON_SPAN
  const lonMax = Math.max(MAX_LON_SPAN, Math.min(MAX_FIT_LON_SPAN, (latSpan * aspect) / k));
  return { cLon: wrapLon((minLon + maxLon) / 2), cLat, lonSpan: clamp(lonSpan, MIN_LON_SPAN, lonMax), k };
}

/** 畫面看得到的世界副本：360° 的倍數 [o, …]（畫陸地、國界、底圖、圖層用；跨度超過一圈時不只 ±360） */
export function worldOffsets(view) {
  const lo = view.cLon - view.lonSpan / 2;
  const hi = view.cLon + view.lonSpan / 2;
  const out = [];
  for (let k = Math.ceil((lo - 180 - OFFSET_SLACK) / 360); k <= Math.floor((hi + 180 + OFFSET_SLACK) / 360); k++) out.push(k * 360 || 0);
  return out;
}

/**
 * 自動框住要不要重新起飛（D10、B1）：目標差不多時，只有新目標的出界量（overflowPx）比目前目標少 1 px 以上才飛。
 * 原本「框不住就飛」在畫面小到誰都框不住時每一幀都從頭起飛，地圖凍在舊視野（電台畫到畫面外）；
 * 改成「新目標框得住才飛」後，地圖高 150～226 px 時新目標本身也留不出 26 px 的邊（fitView 南北邊只有約 11.5%），
 * 新電台在畫面外也不飛。比出界量：新目標比較好就飛；飛到之後 goal＝next，同樣的點出界量相同、不會再飛。
 */
export function refly(goal, next, width, height, points, marginPx) {
  if (!goal) return true;
  if (!viewNearlySame(goal, next)) return true;
  return overflowPx(next, width, height, points, marginPx) < overflowPx(goal, width, height, points, marginPx) - 1;
}

/** 所有點（{lat, lon}）超出「畫布內縮 marginPx」的框最多幾 px（都在框內為 0） */
export function overflowPx(view, width, height, points, marginPx = 12) {
  let worst = 0;
  for (const p of points) {
    const [x, y] = project(view, width, height, p.lat, p.lon);
    worst = Math.max(worst, marginPx - x, x - (width - marginPx), marginPx - y, y - (height - marginPx));
  }
  return worst;
}

/**
 * 經度跨度超過一圈（壓矮地圖，左右重複世界）時，畫面上 x 的所有副本位置（C4：標點也畫在副本上，連線兩端才有電台）
 * @param worldPx 360° 的像素寬；pad 畫面外多留
 */
export function copyXs(x, width, worldPx, pad = 20) {
  if (!(worldPx > 0) || !Number.isFinite(x)) return [x];
  const out = [];
  for (let k = Math.ceil((-pad - x) / worldPx); k <= Math.floor((width + pad - x) / worldPx); k++) out.push(x + k * worldPx);
  return out.length ? out : [x];
}

/** 每緯度幾個像素。 */
export function scaleOf(view, width) {
  return width / (view.lonSpan * view.k);
}

/** 經緯度 → 像素 [x, y]。經度以視野中心展開（換日線另一側的電台畫在靠近中心的那一側）。 */
export function project(view, width, height, lat, lon) {
  const s = scaleOf(view, width);
  return [width / 2 + (unwrapLon(lon, view.cLon) - view.cLon) * view.k * s, height / 2 - (lat - view.cLat) * s];
}

/** 不展開經度的投影（畫陸地輪廓用：呼叫端自己平移 ±360°）。 */
export function projectRaw(view, width, height, lat, lon) {
  const s = scaleOf(view, width);
  return [width / 2 + (lon - view.cLon) * view.k * s, height / 2 - (lat - view.cLat) * s];
}

/** 像素 → 經緯度 { lat, lon }（經度未正規化）。 */
export function unproject(view, width, height, x, y) {
  const s = scaleOf(view, width);
  return { lat: view.cLat - (y - height / 2) / s, lon: view.cLon + (x - width / 2) / (view.k * s) };
}

/** 以像素 (x, y) 為中心縮放：factor > 1 放大。游標下的經緯度不動（緯度夾住時例外）。 */
export function zoomAt(view, width, height, x, y, factor) {
  if (!(factor > 0)) return view;
  const at = unproject(view, width, height, x, y);
  const lonSpan = clamp(view.lonSpan / factor, MIN_LON_SPAN, Math.max(MAX_LON_SPAN, view.lonSpan)); // 壓矮地圖的寬視野：可以放大，不會一滾就跳回 400°
  const next = { ...view, lonSpan };
  const s = scaleOf(next, width);
  return {
    ...next,
    cLon: wrapLon(at.lon - (x - width / 2) / (view.k * s)),
    cLat: clamp(at.lat + (y - height / 2) / s, -MAX_LAT, MAX_LAT),
  };
}

/** 拖曳平移：地圖跟著手指移動 (dx, dy) 像素。 */
export function panBy(view, width, dx, dy) {
  const s = scaleOf(view, width);
  return { ...view, cLon: wrapLon(view.cLon - dx / (view.k * s)), cLat: clamp(view.cLat + dy / s, -MAX_LAT, MAX_LAT) };
}

/**
 * 兩點之間的大圓航線，共 segments + 1 點 [{lat, lon}]（同 FT8TW MapGeometry.greatCircle）。
 * 中間各點經度相對前一點展開，畫出來是連續的一條。
 */
export function greatCircle(lat1, lon1, lat2, lon2, segments = 48) {
  const n = Math.max(1, Math.floor(segments));
  const p1 = toRad(lat1), l1 = toRad(lon1), p2 = toRad(lat2), l2 = toRad(lon2);
  const a1 = [Math.cos(p1) * Math.cos(l1), Math.cos(p1) * Math.sin(l1), Math.sin(p1)];
  const a2 = [Math.cos(p2) * Math.cos(l2), Math.cos(p2) * Math.sin(l2), Math.sin(p2)];
  const d = Math.acos(clamp(a1[0] * a2[0] + a1[1] * a2[1] + a1[2] * a2[2], -1, 1));
  const sinD = Math.sin(d);
  const out = [{ lat: lat1, lon: lon1 }];
  let prev = lon1;
  for (let i = 1; i < n; i++) {
    const f = i / n;
    let lat, lon;
    if (d < 1e-12) {
      [lat, lon] = [lat1, lon1];
    } else if (sinD < 1e-12) {
      // 對蹠點：大圓不唯一，退回經緯度線性內插，至少不會除以零
      lat = lat1 + (lat2 - lat1) * f;
      lon = lon1 + (unwrapLon(lon2, lon1) - lon1) * f;
    } else {
      const a = Math.sin((1 - f) * d) / sinD;
      const b = Math.sin(f * d) / sinD;
      const [x, y, z] = [0, 1, 2].map((j) => a * a1[j] + b * a2[j]);
      lat = toDeg(Math.atan2(z, Math.hypot(x, y)));
      lon = toDeg(Math.atan2(y, x));
    }
    lon = unwrapLon(lon, prev);
    out.push({ lat, lon });
    prev = lon;
  }
  out.push({ lat: lat2, lon: unwrapLon(lon2, prev) });
  return out;
}

/**
 * 自動移動地圖的「飛行」路徑（使用者 2026-10-08：略有戲劇張力，不要直接切換）。
 * van Wijk & Nuij 平滑縮放（同 d3.interpolateZoom、Google 地圖 flyTo）：先拉遠到看得見起點與終點、滑過去、再拉近；
 * 時間軸再套緩入緩出。經度走近的那一邊（跨換日線不繞地球一圈）。
 * @returns {{ durationMs: number, at: (t: number) => view }}（t 為 0～1 的時間比例；durationMs 0＝幾乎沒變，直接切）
 */
export function flyPath(from, to, { rho = 1.6, minMs = 1100, maxMs = 2600 } = {}) {
  const x0 = from.cLon;
  const y0 = from.cLat;
  const x1 = unwrapLon(to.cLon, x0);
  const y1 = to.cLat;
  const w0 = from.lonSpan;
  const w1 = to.lonSpan;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d2 = dx * dx + dy * dy;
  const d1 = Math.sqrt(d2);
  const r2 = rho * rho;
  let S;
  let path;
  if (d1 < 1e-6) {
    S = Math.abs(Math.log(w1 / w0)) / rho;
    path = (s) => [x0, y0, w0 * Math.exp(rho * s * Math.sign(Math.log(w1 / w0) || 1))];
  } else {
    const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d2) / (2 * w0 * r2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d2) / (2 * w1 * r2 * d1);
    const q0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const q1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (q1 - q0) / rho;
    const c0 = Math.cosh(q0);
    path = (s) => {
      const u = (w0 / (r2 * d1)) * (c0 * Math.tanh(rho * s + q0) - Math.sinh(q0));
      return [x0 + u * dx, y0 + u * dy, (w0 * c0) / Math.cosh(rho * s + q0)];
    };
  }
  // 變化很小（中心移不到跨度的 2%、跨度變不到 5%）：不值得飛，直接切
  const tiny = d1 < 0.02 * Math.min(w0, w1) && Math.abs(w1 / w0 - 1) < 0.05;
  const durationMs = tiny ? 0 : clamp((S * 1000 * rho) / Math.SQRT2, minMs, maxMs);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const at = (t) => {
    if (t <= 0) return { ...from };
    if (t >= 1 || durationMs === 0) return { ...to };
    const e = ease(t);
    const [x, y, w] = path(e * S);
    return {
      cLon: wrapLon(x), cLat: clamp(y, -MAX_LAT, MAX_LAT), lonSpan: clamp(w, MIN_LON_SPAN, Math.max(MAX_LON_SPAN, from.lonSpan, to.lonSpan)), k: from.k + (to.k - from.k) * e,
    };
  };
  return { durationMs, at };
}

/** 兩個視野差不多（中心差不到跨度的 8%、跨度比 0.85～1.18）：自動框住時不必移動，免得連線一出現一消失地圖就抖 */
export function viewNearlySame(a, b) {
  if (!a || !b) return false;
  const span = Math.min(a.lonSpan, b.lonSpan);
  const dLon = Math.abs(unwrapLon(b.cLon, a.cLon) - a.cLon) * Math.min(a.k, b.k);
  const dLat = Math.abs(b.cLat - a.cLat);
  const ratio = b.lonSpan / a.lonSpan;
  return Math.hypot(dLon, dLat) < 0.08 * span && ratio > 0.85 && ratio < 1.18;
}

/** 所有點（{lat, lon}）都在畫面內、離邊緣至少 marginPx：自動框住時「差不多」也要先確認沒有站台跑出去 */
export function viewContains(view, width, height, points, marginPx = 12) {
  for (const p of points) {
    const [x, y] = project(view, width, height, p.lat, p.lon);
    if (x < marginPx || x > width - marginPx || y < marginPx || y > height - marginPx) return false;
  }
  return true;
}
