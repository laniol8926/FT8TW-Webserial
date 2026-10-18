// Maidenhead 網格 → 經緯度與兩點距離（design D15），移植自 FT8TW MaidenheadGrid：
//   gridToLatLng：2／4／6／8／10 碼、取最細一級的中心點、緯度夾在 ±85；RR73、RR 不是網格
//   getDist：球面餘弦定律，R = 6371393 m
//   checkMaidenhead：訊息裡的「網格」只認 4 或 6 碼、前兩碼字母後兩碼數字、不是 RR73
export const EARTH_RADIUS_M = 6371393;

export function gridToLatLng(grid) {
  if (grid == null) return null;
  const g = String(grid).trim().toUpperCase();
  if (![2, 4, 6, 8, 10].includes(g.length) || g === 'RR73' || g === 'RR') return null;
  let lon = -180;
  let lat = -90;
  let lonSize = 360;
  let latSize = 180;
  for (let k = 0; k < g.length / 2; k++) {
    const base = k === 0 ? 18 : k % 2 === 1 ? 10 : 24;
    lonSize /= base;
    latSize /= base;
    const zero = base === 10 ? 48 : 65; // '0' 或 'A'
    lon += (g.charCodeAt(2 * k) - zero) * lonSize;
    lat += (g.charCodeAt(2 * k + 1) - zero) * latSize;
  }
  lon += lonSize / 2;
  lat += latSize / 2;
  return { lat: Math.max(-85, Math.min(85, lat)), lon };
}

const rad = (d) => (d * Math.PI) / 180;

// 公里；acos 超出定義域（同一點的浮點誤差）時 Java 回 NaN，這裡同樣回 NaN
export function distanceKm(a, b) {
  const cos = Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(a.lon) - rad(b.lon)) + Math.sin(rad(a.lat)) * Math.sin(rad(b.lat));
  return (EARTH_RADIUS_M * Math.acos(cos)) / 1000;
}

export function checkMaidenhead(s) {
  if (typeof s !== 'string' || (s.length !== 4 && s.length !== 6) || s === 'RR73') return false;
  return /^[A-Za-z]{2}[0-9]{2}/.test(s);
}

// 顯示用的整數公里（MaidenheadGrid.getDistStr）：任一方不是網格、或距離為 0 時回 null（畫面留空）
export function gridDistanceKm(myGrid, theirGrid) {
  const a = gridToLatLng(myGrid);
  const b = gridToLatLng(theirGrid);
  if (!a || !b) return null;
  const km = distanceKm(a, b);
  return Number.isFinite(km) && km !== 0 ? Math.round(km) : null;
}
