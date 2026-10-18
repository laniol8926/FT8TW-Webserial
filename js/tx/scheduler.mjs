// 發射排程（add-web-transmit 1.5、design D5、D6）的純函式：時間一律用校正後的 UTC（與收訊切 slot 同一個時間）。
// FT8／FT4／FT2 的音訊起點就是 slot 起點（FT8TW：DAC 輸出落在 T=0），JS8 在 slot 起點後 500 ms。
// 本 slot 已過截止時間就延到下一個同奇偶的 slot（FT8TW transmitNow）。
// JS8 多速度（add-web-js8-chat D8）：slot、起始延遲、截止（slot×1/6）依 submode；下表的 JS8 是 Normal。
import { t } from '../i18n/index.mjs'; // 錯誤訊息會顯示在發射狀態（無法發射）
import { periodMs, startDelayMs, txCutoffMs } from '../js8/submodes.mjs';

export const TX_SLOT_MS = { FT8: 15000, FT4: 7500, FT2: 3750, JS8: 15000 };
export const TX_CUTOFF_MS = { FT8: 2500, FT4: 1250, FT2: 600, JS8: 2500 };
export const TX_START_OFFSET_MS = { FT8: 0, FT4: 0, FT2: 0, JS8: 500 };

function slotOf(mode) {
  const slot = TX_SLOT_MS[mode];
  if (!slot) throw new Error(t('tx.err.mode', { mode }));
  return slot;
}

// 發射時序：{ slotMs, startOffsetMs, cutoffMs }。JS8 依 submode（省略＝0 Normal），其他模式不看 submode；
// 非法 submode 丟 submodes.mjs 的錯
export function txTiming(mode, submode = 0) {
  const slotMs = slotOf(mode);
  if (mode === 'JS8') return { slotMs: periodMs(submode), startOffsetMs: startDelayMs(submode), cutoffMs: txCutoffMs(submode) };
  return { slotMs, startOffsetMs: TX_START_OFFSET_MS[mode], cutoffMs: TX_CUTOFF_MS[mode] };
}

// 時序奇偶（FT8TW UtcTimer.sequential）：邊界前 50 ms 內算下一個 slot
export function sequenceOf(utcMs, mode) {
  return Math.floor((utcMs + 50) / slotOf(mode)) % 2;
}

// CQ：用下一個 slot 的奇偶
export function cqParity(nowUtc, mode) {
  return (sequenceOf(nowUtc, mode) + 1) % 2;
}

// 回覆對方：取對方那則訊息所在 slot 的相反奇偶
export function answerParity(theirSlotUtc, mode) {
  return (sequenceOf(theirSlotUtc, mode) + 1) % 2;
}

// 回傳 { slotStart, startUtc, late }：late＝本 slot 已開始、音訊從現在起發（未過截止）。
// parity 為 null 表示不分奇偶（JS8 多 frame 訊息在連續的 slot 依序發）；奇偶以該速度的 slot 編號算。
// submode 只對 JS8 有意義，省略＝0（Normal，與單一速度時相同）
export function nextTxSlot({ nowUtc, mode, parity, submode = 0 }) {
  const { slotMs: slot, startOffsetMs: offset, cutoffMs } = txTiming(mode, submode);
  if (parity !== 0 && parity !== 1 && parity !== null) throw new Error(t('tx.err.parity', { parity }));
  const current = Math.floor(nowUtc / slot) * slot;
  const parityOf = (start) => (parity === null ? null : Math.floor(start / slot) % 2);
  // 還沒到起點的下一個 slot 也可能是 current＋slot；先看本 slot 能不能用
  if (parityOf(current) === parity && nowUtc - current <= cutoffMs) {
    const start = current + offset;
    return nowUtc > start ? { slotStart: current, startUtc: nowUtc, late: true } : { slotStart: current, startUtc: start, late: false };
  }
  let next = current + slot;
  if (parityOf(next) !== parity) next += slot;
  return { slotStart: next, startUtc: next + offset, late: false };
}
