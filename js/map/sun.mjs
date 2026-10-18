// 日夜分界（使用者 2026-10-08：3D 地圖加白天黑夜線，黑夜區稍微暗一點點）。純函式，有單元測試；畫在 globe.mjs（shader）與 map.mjs（遮罩）。
// 太陽直射點用低精度公式（天文年曆 Astronomical Almanac 的太陽位置，誤差約 0.01°～0.1°，畫地圖綽綽有餘）：
//   n＝離 J2000.0 的日數；平黃經 L、平近點角 g；黃經 λ＝L＋1.915 sin g＋0.020 sin 2g；黃赤交角 ε；
//   赤緯 δ＝asin(sin ε sin λ)＝直射點緯度；赤經 α；均時差 E＝L − α；直射點經度＝−15·(UT 時 − 12) − E。
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export const NIGHT_DIM = 0.3; // 黑夜區亮度減 30%（稍微暗一點點，標點、文字、弧線照樣看得清楚）
export const TWILIGHT_DEG = 8; // 晨昏帶寬度：太陽高度 −4°～+4° 之間漸變，不是一刀切

/** 太陽直射點 { lat, lon }（度）；date：Date 或 UTC 毫秒 */
export function subsolarPoint(date) {
  const ms = typeof date === 'number' ? date : date.getTime();
  const n = ms / 86_400_000 - 10957.5; // J2000.0＝2000-01-01 12:00 UTC
  const L = toRad((280.46 + 0.9856474 * n) % 360);
  const g = toRad((357.528 + 0.9856003 * n) % 360);
  const lambda = L + toRad(1.915) * Math.sin(g) + toRad(0.02) * Math.sin(2 * g);
  const eps = toRad(23.439 - 0.0000004 * n);
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const eot = wrap180(toDeg(L - ra)); // 均時差（度；×4＝分鐘）
  const utcHours = (((ms / 3_600_000) % 24) + 24) % 24;
  return { lat: toDeg(dec), lon: wrap180(-15 * (utcHours - 12) - eot) };
}

/** 太陽在 (lat, lon) 的高度角（度）；sub＝subsolarPoint。正＝白天、負＝黑夜 */
export function sunElevation(lat, lon, sub) {
  const p = toRad(lat), s = toRad(sub.lat);
  const cosZ = Math.sin(p) * Math.sin(s) + Math.cos(p) * Math.cos(s) * Math.cos(toRad(lon - sub.lon));
  return toDeg(Math.asin(Math.max(-1, Math.min(1, cosZ))));
}

/** 太陽高度 → 黑夜程度 0（白天）～1（黑夜）；晨昏帶內 smoothstep 漸變 */
export function nightFactor(elevDeg, bandDeg = TWILIGHT_DEG) {
  const t = Math.max(0, Math.min(1, (bandDeg / 2 - elevDeg) / bandDeg));
  return t * t * (3 - 2 * t);
}

/**
 * 2D 用的等距圓柱黑夜遮罩（經度 −180～180、緯度 90～−90 鋪滿，同底圖影像）：每格的透明度（0～255），
 * 疊一層黑色就是亮度 ×(1 − NIGHT_DIM·黑夜程度)。
 */
export function nightMask(sub, width, height, dim = NIGHT_DIM) {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) / height) * 180;
    for (let x = 0; x < width; x++) {
      const lon = -180 + ((x + 0.5) / width) * 360;
      out[y * width + x] = Math.round(255 * dim * nightFactor(sunElevation(lat, lon, sub)));
    }
  }
  return out;
}

export const TERMINATOR_COLOR = 'rgba(255, 214, 140, 0.7)'; // 晨昏線：淡淡的暖色細線

/**
 * 晨昏線（太陽高度 0°）的經緯度折線：經度 −180～180 每 step 度一點，緯度＝atan(−cos(經差) / tan(赤緯))。
 * 春分秋分（赤緯 0）時是兩條經線，這裡會在 ±90° 之間跳：照樣畫得出來
 */
export function terminatorPoints(sub, step = 2) {
  const out = [];
  const t = Math.tan(toRad(sub.lat));
  for (let lon = -180; lon <= 180 + 1e-9; lon += step) {
    const c = Math.cos(toRad(lon - sub.lon));
    const lat = Math.abs(t) < 1e-9 ? (Math.abs(c) < 1e-9 ? 0 : -Math.sign(c) * 90) : toDeg(Math.atan(-c / t));
    out.push({ lat, lon });
  }
  return out;
}
