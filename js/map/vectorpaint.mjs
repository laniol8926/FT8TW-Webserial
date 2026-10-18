// 向量線與陸地的 Path2D（add-map-overlays C2、D14）：只有瀏覽器用（Path2D、DOMMatrix），2D 地圖與 3D 細節貼圖共用。
// 線（國界、州界、Zone、向量陸地）依 tile 分格，每格在「度數空間」建一次 Path2D（快取），畫的時候只挑看得到的格、
// 以 addPath(path, DOMMatrix) 一次換到畫面座標（等距圓柱投影是仿射的：x＝a·lon＋e、y＝d·lat＋f）。
// 不再每次重畫把全世界每一點都投影一遍（10m 資料十幾萬點，1800° 寬的壓矮地圖有 7 份副本）。
import { bucketize, visibleItems } from './detail.mjs';

const ptsOf = (it) => (ArrayBuffer.isView(it) ? it : it.pts);
const buckets = new WeakMap(); // 資料陣列 → { tile, list }
const linePaths = new WeakMap(); // 格 → Path2D（度）
const landPaths = new WeakMap(); // 格 → { fill, coast }（度）

function bucketsFor(items, tileDeg) {
  let b = buckets.get(items);
  if (!b || b.tile !== tileDeg) {
    b = { tile: tileDeg, list: bucketize(items, tileDeg) };
    buckets.set(items, b);
  }
  return b.list;
}

function linePath(bucket) {
  let p = linePaths.get(bucket);
  if (!p) {
    p = new Path2D();
    for (const it of bucket.items) {
      const f = ptsOf(it);
      p.moveTo(f[0], f[1]);
      for (let i = 2; i < f.length; i += 2) p.lineTo(f[i], f[i + 1]);
    }
    linePaths.set(bucket, p);
  }
  return p;
}

function landPath(bucket) {
  let p = landPaths.get(bucket);
  if (!p) {
    const fill = new Path2D();
    const coast = new Path2D();
    for (const r of bucket.items) {
      const f = r.pts;
      const n = f.length / 2;
      fill.moveTo(f[0], f[1]);
      for (let i = 1; i < n; i++) fill.lineTo(f[2 * i], f[2 * i + 1]);
      fill.closePath();
      // 海岸線：跳過切格產生的邊（parseLand skip）
      let pen = false;
      for (let i = 0; i < n; i++) {
        if (r.skip[i]) {
          pen = false;
          continue;
        }
        const j = (i + 1) % n;
        if (!pen) coast.moveTo(f[2 * i], f[2 * i + 1]);
        coast.lineTo(f[2 * j], f[2 * j + 1]);
        pen = true;
      }
    }
    p = { fill, coast };
    landPaths.set(bucket, p);
  }
  return p;
}

/** 經緯度 → 畫面的仿射矩陣（lon 先加 off）：x＝ax·(lon＋off)＋ex、y＝dy·lat＋fy */
export function affine(ax, ex, dy, fy, off = 0) {
  return new DOMMatrix([ax, 0, 0, dy, ex + ax * off, fy]);
}

/**
 * 看得到的線合成一個畫面座標的 Path2D
 * @param lines [Float32Array] 或 [{ pts, w, s, e, n }]
 * @param bounds { west, east, south, north }（展開經度）；offsets 360° 的倍數；padDeg 邊緣多留；matrixFor(off) → DOMMatrix
 */
export function visibleLinesPath(lines, bounds, offsets, padDeg, matrixFor, tileDeg = 10) {
  const out = new Path2D();
  for (const [b, off] of visibleItems(bucketsFor(lines, tileDeg), bounds, offsets, padDeg)) out.addPath(linePath(b), matrixFor(off));
  return out;
}

/** 看得到的陸地：{ fill（even-odd 填色）, coast（海岸線，不含切格的邊）, n（格數） } */
export function visibleLandPaths(land, bounds, offsets, padDeg, matrixFor) {
  const fill = new Path2D();
  const coast = new Path2D();
  let n = 0;
  for (const [b, off] of visibleItems(bucketsFor(land.rings, land.tile || 10), bounds, offsets, padDeg)) {
    const p = landPath(b);
    const m = matrixFor(off);
    fill.addPath(p.fill, m);
    coast.addPath(p.coast, m);
    n++;
  }
  return { fill, coast, n };
}
