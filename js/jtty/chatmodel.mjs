// JTTY 通訊畫面的資料規則（純函式，add-web-jtty jtty-chat、design D10）：泡泡紀錄、輸入列上方三欄的保存、送出鍵的狀態。
// 泡泡沿用 js8chat 的紀錄格式（store／chatview／model）：{ id, utc, dir, from, to, text, complete, snr, freqHz, live, aborted? }
import { clampSerial, SERIAL_MIN } from './fkeys.mjs';
import { loadRetention, cutoffFor } from '../retention.mjs';
import { MAX_MESSAGES } from '../js8chat/store.mjs';
import { normalizeFecSetting } from './fec.mjs';

export const FIELDS_KEY = 'ft8tw.jtty.fields';
export const DB_NAME = 'ft8tw-jttychat';

const call = (s) => String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9/]/g, '');

// 對方呼號、排隊呼號、序號（1～16383）；壞資料逐欄回預設
export function loadFields(storage) {
  let saved = null;
  try {
    saved = JSON.parse(storage.getItem(FIELDS_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  const o = saved && typeof saved === 'object' ? saved : {};
  return { his: call(o.his), queued: call(o.queued), serial: o.serial === undefined ? SERIAL_MIN : clampSerial(o.serial) };
}

export function saveFields(storage, { his, queued, serial }) {
  try {
    storage.setItem(FIELDS_KEY, JSON.stringify({ his: call(his), queued: call(queued), serial: clampSerial(serial) }));
    return true;
  } catch {
    return false;
  }
}

export function normalizeCall(s) {
  return call(s);
}

// 組合器的訊息快照 → 收到的泡泡。id 帶起點，換接收器（組合器 id 重新編號）也不會撞。
// roles：發話者／收話者（sender.mjs resolveSender，add-jtty-utx U9、U10）；UTX 訊息加 utx（泡泡標「強化」）；
// 糾錯修復過的加 repaired（修復的 frame 數，泡泡標「已修復」，add-jtty-fec）
export function rxRecord(snap, { from = '', to = '' } = {}) {
  return {
    id: `rx-${snap.t0}-${snap.id}`,
    dir: 'rx', utc: snap.t0, from: from || '', to: to || '', text: snap.text,
    complete: snap.state === 'complete', live: snap.state === 'receiving',
    snr: snap.snr, freqHz: snap.freqHz,
    ...(snap.utx ? { utx: true } : {}),
    ...(snap.repaired ? { repaired: snap.repaired } : {}),
  };
}

// 送出的泡泡：送出時建立（排隊中、發射中＝live），結束時依結果定稿；走強化編碼的加 utx；
// 自動分則（add-jtty-utx U12）的每一則加 part（{ i, n }，泡泡標「i/n」，空中不帶編號）
export function txRecord({ seq, utc, to, text, utx = false, part = null }) {
  return { id: `tx-${utc}-${seq}`, dir: 'tx', utc, from: '', to: to || '', text, complete: false, live: true, ...(utx ? { utx: true } : {}), ...(part ? { part: { i: part.i, n: part.n } } : {}) };
}

// 自動分則每則之間休息幾個 frame（U12，使用者 2026-10-09：可調、預設 4，1～16）
export const REST_FRAMES_DEFAULT = 4;
export const REST_FRAMES_MIN = 1;
export const REST_FRAMES_MAX = 16;
export function clampRestFrames(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || v === null || v === '' || typeof v === 'boolean') return REST_FRAMES_DEFAULT;
  return Math.min(REST_FRAMES_MAX, Math.max(REST_FRAMES_MIN, n));
}

// 通訊畫面偏好（add-jtty-utx）：強化編碼（U5，預設關）、附帶我的呼號（U10，預設開）、選台（U11，null＝全部）、分則休息 frame 數（U12）、
// 糾錯（add-jtty-fec E1：'off'／'standard'／'strong'，預設標準）
export const PREFS_KEY = 'ft8tw.jtty.prefs';
export function loadJttyPrefs(storage) {
  let o = null;
  try {
    o = JSON.parse(storage.getItem(PREFS_KEY) ?? 'null');
  } catch {
    o = null;
  }
  o = o && typeof o === 'object' ? o : {};
  return {
    utx: o.utx === true,
    attachCall: o.attachCall !== false,
    station: typeof o.station === 'string' && o.station ? o.station : null,
    restFrames: o.restFrames === undefined ? REST_FRAMES_DEFAULT : clampRestFrames(o.restFrames),
    fec: normalizeFecSetting(o.fec),
  };
}
export function saveJttyPrefs(storage, { utx = false, attachCall = true, station = null, restFrames = REST_FRAMES_DEFAULT, fec = undefined } = {}) {
  try {
    storage.setItem(PREFS_KEY, JSON.stringify({ utx: Boolean(utx), attachCall: Boolean(attachCall), station: station || null, restFrames: clampRestFrames(restFrames), fec: normalizeFecSetting(fec) }));
    return true;
  } catch {
    return false;
  }
}

// outcome：done → 完整；aborted／error／rejected／dropped（被停止清掉的排隊）→ 已中斷；
// cancelled（分則還沒開始發就被停止的那幾則，U12）→ 已取消
export function finishTx(rec, outcome, { startUtc } = {}) {
  const done = outcome === 'done';
  const mark = done ? {} : outcome === 'cancelled' ? { cancelled: true } : { aborted: true };
  return { ...rec, ...(Number.isFinite(startUtc) ? { utc: startUtc } : {}), live: false, complete: done, ...mark };
}

// 開啟對話：保留期限沿用 SWL Log 的設定（比照 JS8 對話，js8chat/ui.mjs），先清掉過期的，再載入最近 500 則
export async function loadConversation(store, { storage, now = Date.now() }) {
  await store.purgeOlderThan(cutoffFor(now, loadRetention(storage)));
  return store.list({ limit: MAX_MESSAGES });
}

// 輸入列上方的提示：recheck() 回目前仍擋住的原因（字串）或 null；條件變了（呼號、欄位、頻率）呼叫 refresh()，
// 原因解除就清掉、原因換了就換字。沒有 recheck 的提示（發射失敗、被停止）留到下一次 set
export function createWarnState(show) {
  let text = '';
  let recheck = null;
  const put = (next) => {
    if (next === text) return;
    text = next;
    show(next);
  };
  return {
    get text() {
      return text;
    },
    set(next, check = null) {
      recheck = next ? check : null;
      text = next ?? '';
      show(text);
    },
    refresh() {
      if (!recheck) return;
      let reason;
      try {
        reason = recheck();
      } catch {
        return;
      }
      if (!reason) recheck = null;
      put(reason || '');
    },
  };
}

// 送出鍵：沒在發射＝送出；發射中、輸入框空＝停止；發射中有字＝排入下一則（同 JS8 通訊畫面）
export function sendButtonKey(busy, hasText) {
  if (!busy) return 'jtty.send';
  return hasText ? 'jtty.queue' : 'jtty.stop';
}

// 編碼／發射的錯誤代碼 → 畫面文字（code review 2026-10-09：原本直接顯示 too-long 這類代碼）；不認得的（防護給的原因）原樣
const TX_ERROR_CODES = new Set(['too-long', 'bad-freq', 'empty', 'watchdog']);
export function txErrorText(code, t) {
  if (code === undefined || code === null) return '';
  return TX_ERROR_CODES.has(code) ? t(`jtty.txerr.${code}`) : String(code);
}
