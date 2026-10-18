// JTTY 發話者辨識（add-jtty-utx design U9、U10）。純函式，不碰 DOM、不碰 WASM。
// JTTY 協定沒有發話者欄位：先看 FT8TW 的發話者 frame（U10，100% 確定），否則從內容推斷，再不行用頻率記憶。
//   發話者：`CQ <call> CQ`、CQ 開頭取最後一個標準呼號、`<to> DE <call>`、`DE <call>`
//   收話者：`<call> 599 …`、`TU NOW <call> …`、`<call> AGN?`、`<call> TU`（以及 `<to> DE <call>` 的 <to>）
// 頻率記憶：辨識出的發話者記到該頻率（±10 Hz、10 分鐘），同頻率之後的訊息歸給同一人；辨識不出時呼叫端顯示頻率。

export const SENDER_TOL_HZ = 10;
export const SENDER_TTL_MS = 10 * 60_000;

// 標準呼號（JTTY 呼號字收的那種，U9 只認這種）：前綴 1～2 字（含字母）＋數字＋1～3 個字母
const STANDARD_CALL = /^(?:[A-Z]{1,2}|[A-Z][0-9]|[0-9][A-Z])[0-9][A-Z]{1,3}$/;
export const isStandardCallText = (s) => STANDARD_CALL.test(s);

// 收話者後面接的報告字（`<call> 599 …`、`<call> AGN?`、`<call> TU`）
const TO_FOLLOWERS = new Set(['599', '5NN', 'AGN?', 'AGN', 'TU']);

// 組合器的缺段記號 `...` 也當分隔；去掉 token 兩端的標點（逗號、句點），保留 `?`（AGN?）
function tokensOf(text) {
  return String(text ?? '').toUpperCase().split(/\s+|\.\.\./u).map((t) => t.replace(/^[^A-Z0-9?]+|[^A-Z0-9?]+$/gu, '')).filter(Boolean);
}

/**
 * 從內容辨識發話者與收話者。
 * @param {string} text
 * @param {{ isCall?: (s: string) => boolean }} [opts] 標準呼號判斷（預設以格式判斷）
 * @returns {{ from: string|null, to: string|null }}
 */
export function identifyRoles(text, { isCall = isStandardCallText } = {}) {
  const t = tokensOf(text);
  let from = null;
  let to = null;
  // DE <call>（最可靠：明說是誰）；前面緊接的呼號是收話者
  const de = t.findIndex((w, i) => w === 'DE' && i + 1 < t.length && isCall(t[i + 1]));
  if (de >= 0) {
    from = t[de + 1];
    if (de > 0 && isCall(t[de - 1])) to = t[de - 1];
  } else if (t[0] === 'CQ') {
    // CQ <call> CQ，或 CQ 開頭取最後一個標準呼號（CQ DX BV6LC、CQ CQ K1ABC K1ABC）
    if (t.length >= 3 && isCall(t[1]) && t[2] === 'CQ') from = t[1];
    else from = [...t.slice(1)].reverse().find((w) => isCall(w)) ?? null;
  }
  if (!to) {
    if (t[0] === 'TU' && t[1] === 'NOW' && t.length > 2 && isCall(t[2])) to = t[2];
    else if (t.length > 1 && isCall(t[0]) && TO_FOLLOWERS.has(t[1])) to = t[0];
  }
  if (to && to === from) to = null;
  return { from, to };
}

/** 頻率記憶：freqHz 附近（±tolHz）最近一次辨識出的發話者，ttlMs 內有效 */
export class SenderMemory {
  constructor({ tolHz = SENDER_TOL_HZ, ttlMs = SENDER_TTL_MS } = {}) {
    this.tolHz = tolHz;
    this.ttlMs = ttlMs;
    this.entries = []; // { freqHz, call, utc }
  }

  note(freqHz, call, utc) {
    if (!call || !Number.isFinite(freqHz) || !Number.isFinite(utc)) return;
    // 同頻率只留一筆（新的取代舊的，換人時以新的為準）
    this.entries = this.entries.filter((e) => Math.abs(e.freqHz - freqHz) > this.tolHz && utc - e.utc <= this.ttlMs);
    this.entries.push({ freqHz, call, utc });
  }

  lookup(freqHz, utc) {
    let best = null;
    for (const e of this.entries) {
      const df = Math.abs(e.freqHz - freqHz);
      if (df > this.tolHz || utc - e.utc > this.ttlMs || utc - e.utc < -this.ttlMs) continue;
      if (!best || df < best.df || (df === best.df && e.utc > best.e.utc)) best = { e, df };
    }
    return best ? best.e.call : null;
  }

  clear() {
    this.entries = [];
  }
}

/**
 * 一則收到的訊息的發話者與收話者。發話者 frame（sender）＞內容＞頻率記憶；frame 或內容辨識出的會記進頻率記憶。
 * 頻率記憶的人剛好是這則的收話者時不採用（同頻率換人回話）。
 * @returns {{ from: string|null, to: string|null, source: 'frame'|'content'|'freq'|null }}
 */
export function resolveSender({ text, freqHz, utc, sender = null }, memory, opts = {}) {
  const roles = identifyRoles(text, opts);
  let from = sender || roles.from;
  let source = sender ? 'frame' : roles.from ? 'content' : null;
  if (from) memory?.note(freqHz, from, utc);
  else {
    const remembered = memory?.lookup(freqHz, utc) ?? null;
    if (remembered && remembered !== roles.to) {
      from = remembered;
      source = 'freq';
    }
  }
  const to = roles.to && roles.to !== from ? roles.to : null;
  return { from: from ?? null, to, source };
}

/** 自己要送的訊息是否已明確帶自己的呼號（U10：這時不附發話者 frame） */
export function namesSelf(text, myCall, opts = {}) {
  const me = String(myCall ?? '').trim().toUpperCase();
  return Boolean(me) && identifyRoles(text, opts).from === me;
}
