// 大幅移動先看全世界（map-fly-overview，使用者 2026-10-09）：自動框住的新目標與目前畫面幾乎沒有重疊、而且中心移很遠時，
// 飛行改成兩段：先原地縮到全世界視野、停一下，再放大到新目標；小幅調整照原本的單段飛行（2D flyPath、3D globeFly）。
// 這裡只有純函式：2D／3D 的「大幅移動」判定、全世界視野、兩段式路徑（含中途換目標）。map.mjs、globe.mjs 只負責接上。
import { unwrapLon } from './projection.mjs';
import { angleBetween } from './globemath.mjs';

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// 同形狀的零（3D 速度 { w: [x, y, z], dL }）：停留時靜止
const zeroLike = (v) => (Array.isArray(v) ? v.map(zeroLike) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, zeroLike(x)])) : 0);

/** 新目標在目前畫面裡看得到的比例低於這個值，才算「幾乎沒有重疊」 */
export const OVERVIEW_MAX_COVER = 0.15;
/** 新舊視野中心的大圓角距至少這麼遠（度），才算「大幅移動」（台灣→澳洲約 35°，不算；台灣→歐洲約 44～62°，算） */
export const OVERVIEW_MIN_ANGLE_DEG = 40;
/** 目前畫面已經接近全世界：不必再拉到全世界（2D 經度跨度、3D 距離與全世界視野的比） */
export const OVERVIEW_NEAR_WORLD = 0.85;
/** 在全世界視野停留 */
export const OVERVIEW_HOLD_MS = 400;
/** 第一段（縮到全世界）、第二段（放大到新目標）的時間範圍；總時長上限 1300＋400＋1800＝3500 ms */
export const STAGE1_MS = Object.freeze({ minMs: 700, maxMs: 1300 });
export const STAGE2_MS = Object.freeze({ minMs: 900, maxMs: 1800 });
export const OVERVIEW_MAX_TOTAL_MS = STAGE1_MS.maxMs + OVERVIEW_HOLD_MS + STAGE2_MS.maxMs;

// ── 2D ──

/** 2D 視野在等距圓柱上的範圍 { lo, hi, s, n }（經度跨度最多一圈、緯度夾 ±85；lo/hi 以 cLon 展開） */
export function viewRect2d(view, width, height) {
  const lonSpan = Math.min(360, view.lonSpan);
  const latSpan = (view.lonSpan * view.k * height) / Math.max(width, 1);
  return { lo: view.cLon - lonSpan / 2, hi: view.cLon + lonSpan / 2, s: Math.max(-85, view.cLat - latSpan / 2), n: Math.min(85, view.cLat + latSpan / 2) };
}

/** 2D：新視野 to 有多少比例（面積，經緯度平面）在目前視野 from 裡看得到（0～1）。經度跨換日線時算三份副本 */
export function viewCover2d(from, to, width, height) {
  const a = viewRect2d(from, width, height);
  const b = viewRect2d(to, width, height);
  const shift = unwrapLon(to.cLon, from.cLon) - to.cLon;
  const bw = b.hi - b.lo;
  let ix = 0;
  if (a.hi - a.lo >= 360) ix = bw;
  else for (const k of [-360, 0, 360]) ix += Math.max(0, Math.min(a.hi, b.hi + shift + k) - Math.max(a.lo, b.lo + shift + k));
  const iy = Math.max(0, Math.min(a.n, b.n) - Math.max(a.s, b.s));
  const area = bw * (b.n - b.s);
  return area > 0 ? clamp((Math.min(ix, bw) * iy) / area, 0, 1) : 1;
}

/** 2D 全世界視野（第一段終點）：world＝fitView([], w, h)（整個世界、畫面長寬比），中心經度留在目前位置（只縮小、不橫移） */
export function worldView2d(from, world) {
  return { ...world, cLon: from.cLon };
}

/**
 * 2D 大幅移動：目前不是全世界視野、新目標在目前畫面看得到的比例 < OVERVIEW_MAX_COVER、兩個視野中心相距 ≥ OVERVIEW_MIN_ANGLE_DEG。
 * world＝全世界視野（fitView([], w, h)）
 */
export function bigMove2d(from, to, width, height, world) {
  if (!from || !to) return false;
  if (from.lonSpan >= OVERVIEW_NEAR_WORLD * Math.min(360, world.lonSpan)) return false;
  if (viewCover2d(from, to, width, height) >= OVERVIEW_MAX_COVER) return false;
  return toDeg(angleBetween({ lat: from.cLat, lon: from.cLon }, { lat: to.cLat, lon: to.cLon })) >= OVERVIEW_MIN_ANGLE_DEG;
}

// ── 3D ──

// 較窄方向的半視角（弧度），同 globemath
function narrowHalfFov(fovDeg, aspect) {
  const v = toRad(fovDeg) / 2;
  return Math.min(v, Math.atan(Math.tan(v) * (aspect > 0 ? aspect : 1)));
}

/** 3D 相機在距離 dist 時，畫面較窄方向邊緣打到地表的中心角（弧度）；射線打不到地球時是地平線 acos(1/dist) */
export function footprintAngle(dist, { fovDeg = 35, aspect = 1 } = {}) {
  const a = narrowHalfFov(fovDeg, aspect);
  const d = Math.max(dist, 1);
  const s = d * Math.sin(a);
  return s >= 1 ? Math.acos(1 / d) : Math.asin(s) - a;
}

/**
 * 3D：新相機 to 看得到的地表（以中心、footprintAngle 為半徑的球冠）有多少比例在目前相機 from 的球冠裡（0～1）。
 * 在新球冠內以 rings×sectors 的極座標格取樣（面積加權），算落在舊球冠內的比例
 */
export function camCover3d(from, to, { fovDeg = 35, aspect = 1, rings = 24, sectors = 48 } = {}) {
  const ra = footprintAngle(from.dist, { fovDeg, aspect });
  const rb = footprintAngle(to.dist, { fovDeg, aspect });
  const ang = angleBetween(from, to);
  if (ang + rb <= ra) return 1;
  if (ang >= ra + rb) return 0;
  const cosRa = Math.cos(ra);
  // 以 to 為北極的局部座標：from 的中心在 (sin ang, 0, cos ang)
  const fx = Math.sin(ang), fz = Math.cos(ang);
  let inside = 0, total = 0;
  for (let i = 0; i < rings; i++) {
    const r = ((i + 0.5) / rings) * rb;
    const w = Math.sin(r);
    for (let j = 0; j < sectors; j++) {
      const phi = ((j + 0.5) / sectors) * 2 * Math.PI;
      const c = Math.sin(r) * Math.cos(phi) * fx + Math.cos(r) * fz;
      total += w;
      if (c >= cosRa) inside += w;
    }
  }
  return inside / total;
}

/** 3D 全世界視野（第一段終點）：相機中心不動，拉到 overviewDist（maxDistFor(fov, aspect)：整顆地球放得進畫面） */
export function worldCam3d(from, overviewDist) {
  return { lat: from.lat, lon: from.lon, dist: overviewDist };
}

/** 3D 大幅移動：目前距離 < 全世界視野的 OVERVIEW_NEAR_WORLD、新相機看得到的地表在目前畫面 < OVERVIEW_MAX_COVER、中心角距 ≥ OVERVIEW_MIN_ANGLE_DEG */
export function bigMove3d(from, to, { fovDeg = 35, aspect = 1, overviewDist }) {
  if (!from || !to) return false;
  if (from.dist >= OVERVIEW_NEAR_WORLD * overviewDist) return false;
  if (camCover3d(from, to, { fovDeg, aspect }) >= OVERVIEW_MAX_COVER) return false;
  return toDeg(angleBetween(from, to)) >= OVERVIEW_MIN_ANGLE_DEG;
}

// ── 兩段式路徑（2D、3D 共用） ──

/**
 * 兩段式飛行：from →（第一段 fly(from, overview, STAGE1_MS＋opts1)）→ 在 overview 停 holdMs →（第二段 fly(overview, to, STAGE2_MS)）→ to。
 * fly＝單段飛行（2D flyPath、3D globeFly 的包裝），回 { durationMs, at(t), velocity?(t) }。
 * @param opts1 第一段額外選項（3D：vel＝起飛時的速度，延續原本的飛行）
 * @returns {{ overview: true, durationMs, stage1Ms, holdMs, stage2Ms, to, at(t), stageAt(t), velocity?(t), retarget(elapsedMs, newTo) }}
 *   stageAt 回 'out'（縮小中）、'hold'（停留）、'in'（放大中）；retarget 在第一段或停留中回第二段換終點的新路徑（第一段與停留不變、
 *   起飛時間沿用），已在第二段回 null（呼叫端照原本的單段飛行重新規劃）
 */
export function overviewFlight(from, overview, to, fly, { holdMs = OVERVIEW_HOLD_MS, opts1 = {}, stage1 = null } = {}) {
  const s1 = stage1 ?? fly(from, overview, { ...STAGE1_MS, ...opts1 });
  const s2 = fly(overview, to, { ...STAGE2_MS });
  const d1 = s1.durationMs;
  const d2 = s2.durationMs;
  const durationMs = d1 + holdMs + d2;
  const local = (t) => {
    const ms = clamp(t, 0, 1) * durationMs;
    if (ms < d1) return { stage: 'out', seg: s1, u: ms / d1 };
    if (ms < d1 + holdMs || d2 === 0) return { stage: 'hold', seg: null, u: 0 };
    return { stage: 'in', seg: s2, u: (ms - d1 - holdMs) / d2 };
  };
  const path = {
    overview: true, durationMs, stage1Ms: d1, holdMs, stage2Ms: d2, to,
    stageAt: (t) => local(t).stage,
    at(t) {
      if (t >= 1) return { ...to };
      if (t <= 0) return d1 > 0 ? s1.at(0) : { ...overview };
      const l = local(t);
      return l.seg ? l.seg.at(l.u) : { ...overview };
    },
    retarget(elapsedMs, newTo) {
      if (elapsedMs >= d1 + holdMs) return null;
      return overviewFlight(from, overview, newTo, fly, { holdMs, stage1: s1 });
    },
  };
  if (s1.velocity && s2.velocity) {
    path.velocity = (t) => {
      const l = local(t);
      return l.seg ? l.seg.velocity(l.u) : zeroLike(s2.velocity(0)); // 停留中靜止
    };
  }
  return path;
}
