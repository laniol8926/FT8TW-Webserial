// 經緯度 ↔ Maidenhead 網格（design D13）。只在瀏覽器內換算，經緯度不保存、不送出。

const GRID = /^[A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2})?$/;
const EPS = 1e-9; // 經度 180、緯度 90 正好落在邊界外，往內縮一點

export function latLonToGrid(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new RangeError(`座標不合理：${lat}, ${lon}`);
  }
  const x = Math.min(lon + 180, 360 - EPS);
  const y = Math.min(lat + 90, 180 - EPS);
  const A = 'A'.charCodeAt(0);
  const a = 'a'.charCodeAt(0);
  return (
    String.fromCharCode(A + Math.floor(x / 20)) +
    String.fromCharCode(A + Math.floor(y / 10)) +
    String(Math.floor((x % 20) / 2)) +
    String(Math.floor(y % 10)) +
    String.fromCharCode(a + Math.floor((x % 2) * 12)) +
    String.fromCharCode(a + Math.floor((y % 1) * 24))
  );
}

export function isValidGrid(grid) {
  return typeof grid === 'string' && GRID.test(grid);
}

// 慣例寫法：前兩碼大寫、子方格小寫（PL05sb）
export function normalizeGrid(grid) {
  const g = grid.trim();
  return g.slice(0, 4).toUpperCase() + g.slice(4).toLowerCase();
}

// 網格 → 該方格中心的經緯度（地圖標點用）。4 碼取 2°×1° 方格中心，6 碼取子方格中心。不合格式回 null
export function gridToLatLon(grid) {
  if (!isValidGrid(grid)) return null;
  const g = grid.toUpperCase();
  const A = 'A'.charCodeAt(0);
  let lon = (g.charCodeAt(0) - A) * 20 - 180 + Number(g[2]) * 2;
  let lat = (g.charCodeAt(1) - A) * 10 - 90 + Number(g[3]);
  if (g.length === 6) {
    lon += (g.charCodeAt(4) - A + 0.5) * (2 / 24);
    lat += (g.charCodeAt(5) - A + 0.5) * (1 / 24);
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}
