// 解碼週期跑馬條（同 FT8TW 頁首的進度線）：依校正後的 UTC 算出目前在 slot 中的位置，一秒跳一次
import { SLOT_MS } from './slot.mjs';

// slot 開始後經過的毫秒數，0 ≤ 值 < 週期
function elapsedIn(utcMs, period) {
  return ((utcMs % period) + period) % period;
}

// 一秒跳一次的顯示：第幾秒（從 1 起算）、週期長度（FT4 為 7.5）、跑馬條寬度（第幾秒／週期，最多 1）
// periodMs：JS8 依目前速度的 slot 長度（add-web-js8-chat J2）；省略＝SLOT_MS[mode]
export function slotTick(utcMs, mode, periodMs = SLOT_MS[mode]) {
  const period = periodMs;
  if (!period) return null;
  const second = Math.floor(elapsedIn(utcMs, period) / 1000) + 1;
  return { second, period: String(period / 1000), width: Math.min(1, (second * 1000) / period) };
}

// 距離下一次跳動的毫秒數：slot 內的下一個整秒，或更早到的 slot 邊界（FT4 最後半秒）
export function msToNextTick(utcMs, mode, periodMs = SLOT_MS[mode]) {
  const period = periodMs;
  if (!period) return null;
  const e = elapsedIn(utcMs, period);
  return Math.min(Math.floor(e / 1000) * 1000 + 1000, period) - e;
}

// 兩條跑馬條（add-dt-offset-advisor D20）：main＝橘色（真實時鐘＝發射時間 utcMs）；rx＝青色，收訊音訊延遲 ≠ 0 時才有，
// 用接收切 slot 的時間（utcMs − rxDelayMs，即 clock.rxOffsetMs 的時間），與實際解碼節奏對齊。nextMs：兩條中較早的下一次跳動
export function progressBars(utcMs, mode, periodMs = SLOT_MS[mode], rxDelayMs = 0) {
  const main = slotTick(utcMs, mode, periodMs);
  if (!main) return { main: null, rx: null, nextMs: null };
  const rxUtc = utcMs - (rxDelayMs || 0);
  const rx = rxDelayMs ? slotTick(rxUtc, mode, periodMs) : null;
  const nextMs = Math.min(msToNextTick(utcMs, mode, periodMs), rx ? msToNextTick(rxUtc, mode, periodMs) : Infinity);
  return { main, rx, nextMs };
}

// 模式框框裡的字：FT8 → 8、FT4 → 4（同 FT8TW）；JS8 → J（FT8TW 沒有 JS8 框框，取 8 會和 FT8 混淆）
export function modeBadge(mode) {
  if (mode === 'JTTY') return 'T'; // slice(-1) 會是 Y
  return mode === 'JS8' ? 'J' : mode.slice(-1);
}

// 狀態列（同 FT8TW 頁首「8 週期:1/0 UTC:12:31:31」）：模式框框、發射週期／目前週期（沒在發射時發射週期為 -）、UTC
export function statusLine(utcMs, mode, txParity, periodMs = SLOT_MS[mode]) {
  const period = periodMs;
  const cur = period ? Math.floor(utcMs / period) % 2 : '-';
  const d = new Date(utcMs);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    badge: modeBadge(mode),
    cycle: `${txParity === 0 || txParity === 1 ? txParity : '-'}/${cur}`,
    utc: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}
