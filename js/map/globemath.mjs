// 3D 地球的幾何（add-map-settings-globe D10、D11、D15）：經緯度 ↔ 3D 向量、離地抬高的大圓弧、背面判斷、
// 自動框住（相機中心與距離）、飛行路徑、差不多就不動。純函式，有單元測試；globe.mjs 只負責畫。
//
// 座標：地球半徑 1、y 朝北極；經度 0 在 +x、東經 90° 在 −z（與 three.js SphereGeometry 的 UV 對齊，等距圓柱影像直接貼）。
// 相機狀態 cam = { lat, lon, dist }：相機在 latLonToVec3(lat, lon, dist) 看向球心、y 朝上。
import { greatCircle, unwrapLon, wrapLon } from './projection.mjs';

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

// 弧線離地：最高（對蹠附近）與最低（近距離）；相機拉近時另有上限 arcLiftCap，弧頂不會碰到相機
export const ARC_MAX_LIFT = 0.85;
export const ARC_MIN_LIFT = 0.06;
export const ARC_BASE = 1.003;
export const MIN_DIST = 1.35; // 自動框住最近：畫面約涵蓋 12° 的地表（600 px 高時）
// 使用者縮放最近（add-map-overlays D16，使用者 2026-10-09：放大到台灣的程度要清楚）：左欄小地圖（約 250 px 高）也能拉到約 7° 寬、
// 每度 50 px 以上，向量圖做得完淡入、用得到 1:10m。只限手動縮放；自動框住、飛行仍以 MIN_DIST 為下限
export const MIN_ZOOM_DIST = 1.12;
export const MAX_DIST = 4.2; // 最遠：整顆地球在畫面裡
export const MAX_CAM_LAT = 85;
export const DEFAULT_CAM = Object.freeze({ lat: 23.5, lon: 121, dist: 3.2 }); // 沒有任何點：看全球（台灣在中間）

export function latLonToVec3(lat, lon, r = 1) {
  const p = toRad(lat), l = toRad(lon);
  return [r * Math.cos(p) * Math.cos(l), r * Math.sin(p), -r * Math.cos(p) * Math.sin(l)];
}

export function vec3ToLatLon(v) {
  const r = len(v) || 1;
  return { lat: toDeg(Math.asin(clamp(v[1] / r, -1, 1))), lon: toDeg(Math.atan2(-v[2], v[0])) };
}

// 球面上兩點（經緯度）的角距（弧度）
export function angleBetween(a, b) {
  return Math.acos(clamp(dot(latLonToVec3(a.lat, a.lon), latLonToVec3(b.lat, b.lon)), -1, 1));
}

// 弧線離地最高點（使用者 2026-10-08：要像參考圖那樣高高拱起再落下，再高一倍）：與角距成正比（每弧度 0.32 R），
// 近的至少 ARC_MIN_LIFT、封頂 ARC_MAX_LIFT；90° 約 0.5 R、約 150° 起封頂 0.85 R
export function arcLift(angle) {
  return clamp(0.32 * clamp(angle, 0, Math.PI), ARC_MIN_LIFT, ARC_MAX_LIFT);
}

/**
 * 相機距離 dist 時弧線抬高的上限：弧頂至少比相機低 0.15（拉近時弧線壓低，不會穿過相機、被近平面裁掉、整片糊在畫面上）；
 * 以 0.05 為一級（縮放時不必每幀重建弧線），遠的時候就是 ARC_MAX_LIFT
 */
export function arcLiftCap(dist) {
  const far = clamp(Math.floor((dist - ARC_BASE - 0.15) / 0.05) * 0.05, ARC_MIN_LIFT, ARC_MAX_LIFT);
  if (dist >= MIN_DIST) return far;
  // 手動拉得比 MIN_DIST 更近（MIN_ZOOM_DIST）：再加一道「弧頂至少比相機低 0.1」（0.01 一級，最低 0.01）。
  // 取兩者較小的：1.35 前後接得起來（code review D19 #3：原本 1.35→0.15、1.349→0.06，跨過去弧線會跳）
  return Math.max(0.01, Math.min(far, Math.floor((dist - ARC_BASE - 0.1) / 0.01) * 0.01));
}

/** a → b 的大圓弧，n + 1 點 [x, y, z]；中間抬高 lift·sin(πt)（lift 不超過 maxLift），兩端貼在半徑 base */
export function arcPoints(a, b, n = 48, { base = ARC_BASE, maxLift = Infinity } = {}) {
  const lift = Math.min(arcLift(angleBetween(a, b)), maxLift);
  return greatCircle(a.lat, a.lon, b.lat, b.lon, n).map((p, i, all) => {
    const t = i / (all.length - 1);
    return latLonToVec3(p.lat, p.lon, base + lift * Math.sin(Math.PI * t));
  });
}

/** 自動框住用的弧線取樣點 { lat, lon, r }（r＝離球心距離）：抬高的弧頂點也要在畫面內 */
export function arcFramePoints(a, b, n = 16) {
  return arcPoints(a, b, n).map((v) => ({ ...vec3ToLatLon(v), r: len(v) }));
}

export function cameraPosition(cam) {
  return latLonToVec3(cam.lat, cam.lon, cam.dist);
}

/** 地表上的點 p（單位向量）從相機位置 c 看得到：表面法向與「往相機」方向的夾角餘弦 > eps（地平線附近也不畫） */
export function facing(p, c, eps = 0.08) {
  const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
  const l = len(d);
  return l > 0 && dot(p, d) / (len(p) * l) > eps;
}

// 較窄方向的半視角（弧度）
function narrowHalfFov(fovDeg, aspect) {
  const v = toRad(fovDeg) / 2;
  const h = Math.atan(Math.tan(v) * (aspect > 0 ? aspect : 1));
  return Math.min(v, h);
}

export const GLOBE_RIM = 1.12; // 地球＋光暈

/** 最遠距離：半徑 rim 的球（預設地球＋光暈；有抬高的弧線時用弧頂高度）放得進較窄的方向；手機直向畫面窄，要比 MAX_DIST 更遠 */
export function maxDistFor(fovDeg = 35, aspect = 1, rim = GLOBE_RIM) {
  return Math.max(MAX_DIST, rim / Math.sin(narrowHalfFov(fovDeg, aspect)));
}

/**
 * 框住所有點：中心＝單位向量平均（互相抵消時用第一點）；每點（離球心 r，預設 1；弧線取樣點離地抬高）與中心角距 θ，
 * 距離讓它落在較窄方向半視角的 80% 內：D = r·cosθ + r·sinθ / tan(α)，取最大；地表點跨到地球側面（θ 近 90°）至少要看到整顆地球。
 * 夾在 MIN_DIST～最遠（rim＝最高點 ×1.04，弧頂在地球邊緣也不出畫面）。
 */
export function fitGlobe(points, { fovDeg = 35, aspect = 1, minAngleDeg = 8 } = {}) {
  if (!points?.length) {
    const maxDist = maxDistFor(fovDeg, aspect);
    return { ...DEFAULT_CAM, dist: Math.max(DEFAULT_CAM.dist, Math.min(maxDist, DEFAULT_CAM.dist * (maxDist / MAX_DIST))) };
  }
  const rs = points.map((p) => (p.r > 0 ? p.r : 1));
  const globeDist = maxDistFor(fovDeg, aspect); // 整顆地球
  const maxDist = maxDistFor(fovDeg, aspect, Math.max(GLOBE_RIM, Math.max(...rs) * 1.04));
  const vs = points.map((p) => latLonToVec3(p.lat, p.lon));
  const sum = vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]);
  const center = len(sum) > 1e-6 * vs.length ? sum : vs[0];
  const c = vec3ToLatLon(center);
  const cv = latLonToVec3(c.lat, c.lon);
  const alpha = narrowHalfFov(fovDeg, aspect) * 0.8;
  const alphaArc = narrowHalfFov(fovDeg, aspect) * 0.92;
  const minTheta = toRad(minAngleDeg);
  let dist = Math.cos(minTheta) + Math.sin(minTheta) / Math.tan(alpha);
  vs.forEach((v, i) => {
    const theta = Math.acos(clamp(dot(v, cv), -1, 1));
    const r = rs[i];
    if (r <= 1.01 && theta >= Math.PI / 2 - 0.05) dist = Math.max(dist, globeDist);
    // 抬高的點（弧線）只要在 92% 內：弧頂本來就細，留太多邊地球會太小
    else dist = Math.max(dist, r * Math.cos(theta) + (r * Math.sin(theta)) / Math.tan(r > 1.01 ? alphaArc : alpha));
  });
  return { lat: clamp(c.lat, -MAX_CAM_LAT, MAX_CAM_LAT), lon: wrapLon(c.lon), dist: clamp(dist, MIN_DIST, maxDist) };
}

// 視野寬度涵蓋的「等效經度跨度」（畫面中心附近），給國名依縮放篩選用（countrylayer.zoomOf）
export function globeLonSpan(dist, fovDeg, width, height) {
  const pxPerRad = height / 2 / Math.tan(toRad(fovDeg) / 2) / Math.max(dist - 1, 1e-3);
  return clamp(toDeg(width / pxPerRad), 1, 360);
}

/** 畫面中心每度幾個 CSS 像素（放大後的向量圖分級用，detail.mjs）：同 globeLonSpan 的換算，但不夾跨度 */
export function globePxPerDeg(dist, fovDeg, height) {
  return (height / 2 / Math.tan(toRad(fovDeg) / 2) / Math.max(dist - 1, 1e-6)) * (Math.PI / 180);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * 看得到的經緯度範圍 { west, east, south, north }（經度以相機中心展開）：畫面上取 (samples+1)² 個點往地球打射線；
 * 有任何一點打不到地球（看得到太空）回 null（細節貼圖只在地球填滿畫面時用）。極點在畫面內時經度整圈、緯度到 ±90。
 * 相機北方朝上（飛行中的滾轉不算，呼叫端另外留邊）
 */
export function visibleBounds3d(cam, { fovDeg = 35, aspect = 1, samples = 6 } = {}) {
  const c = cameraPosition(cam);
  const z = norm(c);
  let x = cross([0, 1, 0], z);
  x = len(x) < 1e-9 ? [1, 0, 0] : norm(x);
  const y = cross(z, x);
  const ty = Math.tan(toRad(fovDeg) / 2);
  const tx = ty * aspect;
  const cc = dot(c, c) - 1;
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (let i = 0; i <= samples; i++) {
    for (let j = 0; j <= samples; j++) {
      const nx = -1 + (2 * i) / samples, ny = -1 + (2 * j) / samples;
      const d = norm([-z[0] + x[0] * nx * tx + y[0] * ny * ty, -z[1] + x[1] * nx * tx + y[1] * ny * ty, -z[2] + x[2] * nx * tx + y[2] * ny * ty]);
      const b = dot(c, d);
      const disc = b * b - cc;
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      const ll = vec3ToLatLon([c[0] + t * d[0], c[1] + t * d[1], c[2] + t * d[2]]);
      const lon = unwrapLon(ll.lon, cam.lon);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, ll.lat);
      north = Math.max(north, ll.lat);
    }
  }
  // 極點：在正面而且投影在畫面內
  for (const sgn of [1, -1]) {
    const v = sub([0, sgn, 0], c);
    const depth = -dot(v, z);
    if (!facing([0, sgn, 0], c, 0) || depth <= 0) continue;
    if (Math.abs(dot(v, x) / depth / tx) <= 1 && Math.abs(dot(v, y) / depth / ty) <= 1) {
      if (sgn > 0) north = 90;
      else south = -90;
      [west, east] = [cam.lon - 180, cam.lon + 180];
    }
  }
  return { west, east, south, north };
}

const fullLon = (lon, south, north) => ({ west: lon - 180, east: lon + 180, south, north });

/**
 * 四角看得到太空（visibleBounds3d 回 null）時估看得到的範圍（code review D19 #2）：以相機中心與畫面中心每度像素換算
 * 半個畫面的經緯度（經度 ÷ cos 緯度）。細節貼圖先依這個建好，寬畫面放大時淡化照樣一路做，不會等到四角都是地球才一次跳成向量圖。
 * 地球曲面讓畫面邊緣涵蓋的度數比線性估計多，呼叫端再用 regionFor 每邊加一半；碰到極點、或比一圈寬時經度整圈
 */
export function centerBounds3d(cam, { pxPerDeg, width, height }) {
  const hLat = height / 2 / pxPerDeg;
  const south = Math.max(-90, cam.lat - hLat), north = Math.min(90, cam.lat + hLat);
  const hLon = width / 2 / pxPerDeg / Math.max(0.2, Math.cos(toRad(cam.lat)));
  if (north >= 90 || south <= -90 || hLon >= 180) return fullLon(cam.lon, south, north);
  return { west: cam.lon - hLon, east: cam.lon + hLon, south, north };
}

/**
 * 飛行中相機會滾轉（cam.up），visibleBounds3d 算的是北方朝上的畫面：以相機中心為圓心、到範圍最遠一角的地面距離為半徑，
 * 取圓的外接經緯度範圍（任何滾轉角都包得住；code review D19 e）。b 為 null 照舊回 null（不裁切）
 */
export function rollSafeBounds(b, cam) {
  if (!b) return null;
  const hLat = Math.max(b.north - cam.lat, cam.lat - b.south);
  const hLon = Math.max(b.east - cam.lon, cam.lon - b.west) * Math.max(0.05, Math.cos(toRad(cam.lat)));
  const r = Math.hypot(hLat, hLon);
  const south = Math.max(-90, cam.lat - r), north = Math.min(90, cam.lat + r);
  const k = Math.cos(toRad(Math.max(Math.abs(south), Math.abs(north))));
  const half = k > 1e-6 ? r / k : Infinity;
  if (north >= 90 || south <= -90 || half >= 180) return fullLon(cam.lon, south, north);
  return { west: cam.lon - half, east: cam.lon + half, south, north };
}

// ── 相機姿態（四元數 [x, y, z, w]）：飛行時轉整個相機姿態，不是分開內插中心與「上」（過極區時上方向退化、單幀暴衝） ──
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];
function qRotate(q, v) {
  const r = qMul(qMul(q, [v[0], v[1], v[2], 0]), qInv(q));
  return [r[0], r[1], r[2]];
}
// 單位四元數 → 旋轉向量（軸×角，取短的那邊）；旋轉向量 → 單位四元數
function qLog(q) {
  const s = q[3] < 0 ? -1 : 1;
  const v = [q[0] * s, q[1] * s, q[2] * s];
  const n = len(v);
  if (n < 1e-12) return [0, 0, 0];
  const k = (2 * Math.atan2(n, q[3] * s)) / n;
  return [v[0] * k, v[1] * k, v[2] * k];
}
function qExp(r) {
  const a = len(r);
  if (a < 1e-12) return [0, 0, 0, 1];
  const k = Math.sin(a / 2) / a;
  return [r[0] * k, r[1] * k, r[2] * k, Math.cos(a / 2)];
}
// 正交基底（相機的右、上、後；後＝球心往相機）→ 四元數
function qFromBasis(x, y, z) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const n = Math.hypot(...q);
  return q.map((v) => v / n);
}

/** 相機姿態：飛行中帶 q 就用 q；否則看向球心、北方朝上（同 three.js lookAt、up＝y） */
export function camQuat(cam) {
  if (cam.q) return cam.q;
  const z = latLonToVec3(cam.lat, cam.lon);
  const l = toRad(cam.lon);
  const x = [-Math.sin(l), 0, -Math.cos(l)]; // 東
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]; // z × x
  return qFromBasis(x, y, z);
}

/** a → b 的旋轉（世界座標的旋轉向量，長度＝弧度）：b ＝ exp(r)·a */
export function relRotation(a, b) {
  return qLog(qMul(b, qInv(a)));
}

// 時間軸：smoothstep（緩入緩出、起訖速度 0）；h10＝Hermite 的「起點速度」基底（起點斜率 1、終點值與斜率 0）
const smooth = (t) => t * t * (3 - 2 * t);
const h10 = (t) => t * (1 - t) * (1 - t);

// 距離隆起：L(s) = L0 + Δ·s + B·sin(πs) 的最高點恰好是 peak（二分搜尋 B；起訖本身較高時 B＝0）
function bumpFor(L0, L1, peak) {
  const d = L1 - L0;
  const top = (B) => {
    if (B * Math.PI <= Math.abs(d)) return Math.max(L0, L1);
    const s = Math.acos(-d / (B * Math.PI)) / Math.PI;
    return L0 + d * s + B * Math.sin(Math.PI * s);
  };
  if (peak <= Math.max(L0, L1)) return 0;
  let lo = 0, hi = peak - Math.min(L0, L1) + Math.abs(d) + 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (top(mid) > peak) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * 自動轉動的「飛行」（使用者 2026-10-08 要有戲劇張力；2026-10-09 要平順）：
 * - 姿態：整個相機姿態（四元數）從起點轉到「終點、北方朝上」，繞固定軸等比例轉，不會過極區時單幀暴衝、扭轉。
 * - 換目標：vel＝舊路徑當下的速度（velocity()），新路徑以它為初速（Hermite），不從靜止重來。
 * - 距離：對數內插；中途只拉到「看得到兩端」（fitGlobe 兩端），不超過 max(maxDist, 起訖距離)。
 * 時間軸緩入緩出（smoothstep）。
 * @returns {{ durationMs, at(t), velocity(t) }}（t＝0～1；durationMs 0＝變化很小，直接切；
 *   at 中途回 { lat, lon, dist, up, q }（up＝相機上方向）；velocity 回 { w：角速度向量（弧度／毫秒）、dL：ln(距離) 每毫秒 }）
 */
export function globeFly(from, to, { minMs = 1100, maxMs = 2600, vel = null, fovDeg = 35, aspect = 1, maxDist = MAX_DIST } = {}) {
  const omega = angleBetween(from, to);
  const q0 = camQuat(from);
  const r1 = relRotation(q0, camQuat({ lat: to.lat, lon: to.lon, dist: to.dist }));
  const L0 = Math.log(from.dist), L1 = Math.log(to.dist);
  const zoom = Math.abs(L1 - L0);
  const w0 = vel?.w ?? [0, 0, 0];
  const dL0 = vel?.dL ?? 0;
  const moving = len(w0) > 1e-9 || Math.abs(dL0) > 1e-9;
  const tiny = len(r1) < 0.01 && zoom < 0.05 && !moving;
  // 時間依轉角（姿態轉角 ≥ 中心角距；過極區時北方要轉半圈，時間也要長一點，每幀轉角才不會太大）
  const T = tiny ? 0 : clamp(700 + 1900 * (Math.max(omega, len(r1)) / Math.PI) + 900 * zoom, minMs, maxMs);
  const hiDist = Math.max(maxDist, from.dist, to.dist);
  const loDist = Math.min(MIN_DIST, from.dist, to.dist); // 從手動拉近（MIN_ZOOM_DIST）起飛時不跳
  const need = Math.min(hiDist, fitGlobe([from, to], { fovDeg, aspect }).dist);
  const B = bumpFor(L0, L1, Math.log(need));
  const rotAt = (t) => {
    const s = smooth(t), h = h10(t) * T;
    return qMul(qExp([r1[0] * s + w0[0] * h, r1[1] * s + w0[1] * h, r1[2] * s + w0[2] * h]), q0);
  };
  const logDist = (t) => {
    const s = smooth(t);
    return L0 + (L1 - L0) * s + dL0 * T * h10(t) + B * Math.sin(Math.PI * s);
  };
  const at = (t) => {
    if (t <= 0) return { ...from };
    if (t >= 1 || T === 0) return { ...to };
    const q = rotAt(t);
    const c = vec3ToLatLon(qRotate(q, [0, 0, 1]));
    return { lat: c.lat, lon: wrapLon(c.lon), dist: clamp(Math.exp(logDist(t)), loDist, hiDist), up: qRotate(q, [0, 1, 0]), q };
  };
  const velocity = (t) => {
    if (!T) return { w: [0, 0, 0], dL: 0 };
    const h = 1e-5;
    const t0 = clamp(t, 0, 1 - h);
    const k = 1 / (h * T);
    const r = relRotation(rotAt(t0), rotAt(t0 + h));
    return { w: [r[0] * k, r[1] * k, r[2] * k], dL: (logDist(t0 + h) - logDist(t0)) * k };
  };
  return { durationMs: T, at, velocity };
}

/** 兩個相機差不多（中心角差 < 畫面半寬地表角度的 16%、距離比 0.88～1.14）：自動框住時不動，免得連線一出現一消失地球就抖 */
export function globeNearlySame(a, b, { fovDeg = 35 } = {}) {
  if (!a || !b) return false;
  const ang = angleBetween(a, b);
  // 畫面半寬在地表上約涵蓋的角度（小角度近似）；同 2D 的「跨度 8%」＝半寬 16%
  const half = Math.tan(toRad(fovDeg) / 2) * Math.max(Math.min(a.dist, b.dist) - 1, 0.05);
  const ratio = b.dist / a.dist;
  return ang < 0.16 * half && ratio > 0.88 && ratio < 1.14;
}

export const RETARGET_MS = 500;

/**
 * 自動框住換目標的 debounce（使用者 2026-10-09：電台一個個進來時地球不要一直換方向）：新目標要穩定 delayMs 才起飛。
 * pending＝{ to, since }（等待中的目標與開始等的時間）；goal＝目前飛往（或停在）的位置；same＝「差不多」判斷。
 * 新目標跟 goal 差不多：不飛、清掉等待；跟等待中的差不多：沿用開始時間（換成最新的）；否則重新計時。
 * @returns {{ pending, fire, waitMs? }}（fire＝該起飛的目標；waitMs＝還要等多久）
 */
export function debounceGoal(pending, next, now, { goal, same, delayMs = RETARGET_MS }) {
  if (same(goal, next)) return { pending: null, fire: null };
  const since = pending && same(pending.to, next) ? pending.since : now;
  if (now - since >= delayMs) return { pending: null, fire: next };
  return { pending: { to: next, since }, fire: null, waitMs: since + delayMs - now };
}

/** 拖曳旋轉：地表跟著手指走；每像素角度隨距離縮放（越近轉越慢），緯度夾住 */
export function rotateBy(cam, dx, dy, height, fovDeg = 35) {
  const radPerPx = (2 * Math.tan(toRad(fovDeg) / 2) * Math.max(cam.dist - 1, 0.05)) / Math.max(height, 1);
  return { ...cam, lon: wrapLon(cam.lon - toDeg(dx * radPerPx)), lat: clamp(cam.lat + toDeg(dy * radPerPx), -MAX_CAM_LAT, MAX_CAM_LAT) };
}

/** 縮放：factor > 1 拉近；maxDist 見 maxDistFor */
export function zoomBy(cam, factor, maxDist = MAX_DIST) {
  if (!(factor > 0)) return cam;
  // 以「離地高度」縮放，靠近地表時變化不會太猛
  return { ...cam, dist: clamp(1 + (cam.dist - 1) / factor, MIN_ZOOM_DIST, maxDist) };
}

/** 離地的點 p（弧線、光點）從相機 c 看會不會被地球（半徑 r）擋住：c→p 線段在 p 之前穿過球面 */
export function occluded(p, c, r = 1) {
  const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const a = dot(d, d);
  const b = 2 * dot(c, d);
  const k = dot(c, c) - r * r;
  const disc = b * b - 4 * a * k;
  if (a === 0 || disc <= 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 && t < 1 - 1e-6;
}

// ── 拖曳慣性（使用者 2026-10-08：拖快一點放開時地球多滑一點、慢慢停下來；慢慢拖放開就停） ──
export const FLING_WINDOW_MS = 100; // 只看放開前這段時間的移動
export const FLING_IDLE_MS = 60; // 放開前停住超過這麼久：不滑
export const INERTIA_TAU_MS = 250; // 速度每 τ 衰減到 1/e：約 1 秒停下、多滑 v·τ

/**
 * 放開時的轉動速度（度／秒）：samples＝拖曳中相機中心 [{ t, lat, lon }]（t 毫秒），取最後 windowMs 內的位移／時間；
 * 放開前停住超過 idleMs、或取樣太短（< 8 ms）回 0。經度跨 ±180° 走近的一邊。
 */
export function flingVelocity(samples, nowMs, { windowMs = FLING_WINDOW_MS, idleMs = FLING_IDLE_MS } = {}) {
  const zero = { lon: 0, lat: 0 };
  const last = samples?.at(-1);
  if (!last || nowMs - last.t > idleMs) return zero;
  const first = samples.find((s) => s.t >= last.t - windowMs);
  const dt = (last.t - first.t) / 1000;
  if (!(dt >= 0.008)) return zero;
  return { lon: (unwrapLon(last.lon, first.lon) - first.lon) / dt, lat: (last.lat - first.lat) / dt };
}

// 地表上的角速度（度／秒）：經度方向乘 cos(緯度)
const angSpeed = (vLon, vLat, lat) => Math.hypot(vLon * Math.cos(toRad(lat)), vLat);

/**
 * 開始慣性：速度（地表角速度）低於 minSpeed（慢慢拖）不滑；高於 maxSpeed 等比縮小（不會轉個不停）。
 * stopSpeed 以下就停。回 null 或 { vLon, vLat, lat, tauMs, stopSpeed }
 */
export function startInertia(v, lat, { minSpeed, maxSpeed = Infinity, stopSpeed = minSpeed * 0.05, tauMs = INERTIA_TAU_MS }) {
  const s = angSpeed(v.lon, v.lat, lat);
  if (!(s >= minSpeed) || !Number.isFinite(s)) return null;
  const k = s > maxSpeed ? maxSpeed / s : 1;
  return { vLon: v.lon * k, vLat: v.lat * k, lat, tauMs, stopSpeed };
}

/** 慣性往前 dtMs：速度指數衰減，位移＝速度的精確積分 v·τ·(1 − e^(−dt/τ))；done＝慢到該停 */
export function inertiaStep(state, dtMs) {
  const k = Math.exp(-Math.max(0, dtMs) / state.tauMs);
  const f = (state.tauMs / 1000) * (1 - k);
  const next = { ...state, vLon: state.vLon * k, vLat: state.vLat * k };
  return { state: next, dLon: state.vLon * f, dLat: state.vLat * f, done: angSpeed(next.vLon, next.vLat, state.lat) < state.stopSpeed };
}

/** 每像素對應的地表角度（度）：給慣性門檻換算「每秒幾像素」 */
export function degPerPx(dist, height, fovDeg = 35) {
  return toDeg((2 * Math.tan(toRad(fovDeg) / 2) * Math.max(dist - 1, 0.05)) / Math.max(height, 1));
}
