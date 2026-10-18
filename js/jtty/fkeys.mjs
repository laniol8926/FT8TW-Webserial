// JTTY F1～F8 巨集（add-web-jtty jtty-chat「F1～F8 巨集」、design D10、W3）：預設、代換、序號規則、存取、點泡泡帶入呼號。
// 代換：%M＝我的呼號、%H＝對方呼號欄、%E＝599 <序號>、%Q＝排隊呼號欄；用到的欄位空著就不發（回錯誤碼）。
// 序號規則（W3）綁在 F 鍵上（不看巨集內容）：F6 發射前先加 1 再代換；F3 正常發射完成後加 1；其餘不變；另有手動 ±。
import { isValidCallsign } from '../settings.mjs';

export const DEFAULT_MACROS = Object.freeze([
  'CQ %M CQ', // F1
  '%H %E', // F2
  '%H TU CQ %M CQ', // F3
  '%M', // F4
  '%H', // F5
  'TU NOW %Q %E', // F6
  '%H AGN?', // F7
  '%E', // F8
]);
export const MACROS_KEY = 'ft8tw.jtty.macros';
export const SERIAL_MIN = 1;
export const SERIAL_MAX = 16383;
const BUMP_BEFORE = 6; // F6：換下一台，發射前加 1
const BUMP_AFTER = 3; // F3：結束通聯，發射完成後加 1

// 到上限不繞回（規格未定，選保守做法）
export function clampSerial(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return SERIAL_MIN;
  return Math.min(SERIAL_MAX, Math.max(SERIAL_MIN, v));
}

export function adjustSerial(serial, delta) {
  return clampSerial(clampSerial(serial) + delta);
}

const call = (s) => String(s ?? '').trim().toUpperCase();

// 回 { text } 或 { error: 'noMyCall'|'noHisCall'|'noQueued'|'badSerial'|'empty' }
export function expand(macro, { myCall, hisCall, queued, serial } = {}) {
  const fields = { M: call(myCall), H: call(hisCall), Q: call(queued) };
  const missing = { M: 'noMyCall', H: 'noHisCall', Q: 'noQueued' };
  let error = null;
  const text = String(macro ?? '').replace(/%([MHQE])/gi, (_, k) => {
    const key = k.toUpperCase();
    if (key === 'E') {
      if (!Number.isInteger(serial) || serial < SERIAL_MIN || serial > SERIAL_MAX) error ??= 'badSerial';
      return `599 ${serial}`;
    }
    if (!fields[key]) error ??= missing[key];
    return fields[key];
  }).trim();
  if (error) return { error };
  if (!text) return { error: 'empty' };
  return { text };
}

// 按下 F<key>（1～8）：回 { text, serialNow（立刻寫回序號欄）, serialAfterDone（發射正常完成後的序號）} 或 { error }
// 有錯誤時序號不動（F6 的排隊呼號空著不會先加）
export function planSend(key, { macros = DEFAULT_MACROS, myCall, hisCall, queued, serial } = {}) {
  if (!Number.isInteger(key) || key < 1 || key > 8) return { error: 'badKey' };
  const base = clampSerial(serial);
  const serialNow = key === BUMP_BEFORE ? clampSerial(base + 1) : base;
  const r = expand(macros[key - 1] ?? DEFAULT_MACROS[key - 1], { myCall, hisCall, queued, serial: serialNow });
  if (r.error) return r;
  return { text: r.text, serialNow, serialAfterDone: key === BUMP_AFTER ? clampSerial(serialNow + 1) : serialNow };
}

// 發射結束後的序號：只有正常發完（'done'）才套用發射後加 1，中斷或失敗維持 serialNow
export function serialAfter(plan, outcome) {
  return outcome === 'done' ? plan.serialAfterDone : plan.serialNow;
}

// 讀巨集：沒存過、壞 JSON、localStorage 不可用 → 預設；逐項檢查，不是字串的那一項用預設
export function loadMacros(storage) {
  let saved = null;
  try {
    saved = JSON.parse(storage.getItem(MACROS_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  if (!Array.isArray(saved)) return [...DEFAULT_MACROS];
  return DEFAULT_MACROS.map((d, i) => (typeof saved[i] === 'string' ? saved[i] : d));
}

export function saveMacros(storage, macros) {
  if (!Array.isArray(macros) || macros.length !== 8 || !macros.every((m) => typeof m === 'string')) return false;
  try {
    storage.setItem(MACROS_KEY, JSON.stringify(macros));
    return true;
  } catch {
    return false;
  }
}

export function resetDefaults(storage) {
  try {
    storage.removeItem(MACROS_KEY);
  } catch {
    // localStorage 不可用：照樣回預設
  }
  return [...DEFAULT_MACROS];
}

// 點泡泡帶入呼號：訊息中第一個不是我的呼號的合法呼號（token 去掉頭尾非呼號字元，如 `AGN?`、`<...>`、逗號）
export function callFromMessage(text, myCall) {
  const me = call(myCall);
  // 缺段記號 `...` 也當分隔（組合時直接相接，可能黏在呼號旁）
  for (const raw of String(text ?? '').toUpperCase().split(/\s+|\.\.\./)) {
    const token = raw.replace(/^[^A-Z0-9/]+|[^A-Z0-9/]+$/g, '');
    if (token && token !== me && isValidCallsign(token)) return token;
  }
  return null;
}
