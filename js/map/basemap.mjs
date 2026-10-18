// 2D 影像底圖的裁切（add-map-settings-globe D5）：底圖是等距圓柱投影（經度 −180～180、緯度 90～−90 鋪滿整張），
// 與 projection.mjs 同一種投影，所以整張影像在畫面上是一個矩形；只要算出那個矩形（−360／0／+360 三個副本，
// 同陸地輪廓補滿換日線）與畫面的交集，再換回影像的來源範圍，drawImage 只取看得到的部分。純函式，有單元測試。
import { projectRaw, worldOffsets } from './projection.mjs';

const MIN_PX = 0.5; // 小於半個像素的條狀交集不畫

/**
 * @returns [{ sx, sy, sw, sh, dx, dy, dw, dh }]（drawImage 的 9 參數版；一般最多 3 個，矮寬畫面跨度超過一圈時更多；左到右）
 */
export function basemapCrop(view, width, height, imgW, imgH) {
  if (!view || !(width > 0) || !(height > 0) || !(imgW > 0) || !(imgH > 0)) return [];
  const out = [];
  const [, y0] = projectRaw(view, width, height, 90, 0);
  const [, y1] = projectRaw(view, width, height, -90, 0);
  const cy0 = Math.max(0, y0);
  const cy1 = Math.min(height, y1);
  if (cy1 - cy0 < MIN_PX) return out;
  for (const off of worldOffsets(view)) {
    const [x0] = projectRaw(view, width, height, 0, -180 + off);
    const [x1] = projectRaw(view, width, height, 0, 180 + off);
    const cx0 = Math.max(0, x0);
    const cx1 = Math.min(width, x1);
    if (cx1 - cx0 < MIN_PX) continue;
    const fx = imgW / (x1 - x0);
    const fy = imgH / (y1 - y0);
    out.push({
      sx: (cx0 - x0) * fx, sy: (cy0 - y0) * fy, sw: (cx1 - cx0) * fx, sh: (cy1 - cy0) * fy,
      dx: cx0, dy: cy0, dw: cx1 - cx0, dh: cy1 - cy0,
    });
  }
  return out;
}
