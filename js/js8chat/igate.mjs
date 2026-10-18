// JS8 → APRS-IS iGate 的網頁端（add-web-js8-chat J4、aprs-igate spec、design D16、D19）。純函式，有單元測試。
// 收到的訊息符合轉發條件時，組成要交給轉送站 POST /aprs 的結構化資料；APRS 封包由轉送站自己組（不轉發外人給的原始內容）。
// 條件同 FT8TW Js8AprsGate：收件者 @APRSIS、訊息完整、非 UTX、發話者不是雜湊、指令只收 GRID／CMD；轉送站會再驗一次。

export const CMD_GRID = 15; // ' GRID'（JS8Call directed_cmds）
export const CMD_APRS = 24; // ' CMD'
// 下面兩個與 computePasscode 是轉送站 relay/src/aprs 的複本（網頁與轉送站分開部署）；webtest/js8chat-igate-parity 對照兩邊
// APRS 資料型別字元（CMD 內容的第一個字元，同 App）
export const APRS_TYPES = ':=!@/;>`\'$<?*)_,{T#&%[';
export const GRID_RE = /^[A-R]{2}[0-9]{2}(?:[A-X]{2})?$/;

/** 設定的呼號 → iGate 登入呼號：轉大寫、以 / 切開取最長的一段（同長取後面，同轉送站 baseCallsign）；空的回 '' */
export function gateCall(callsign) {
  const parts = String(callsign ?? '').trim().toUpperCase().split('/');
  let base = parts[0];
  for (const p of parts.slice(1)) if (p.length >= base.length) base = p;
  return base;
}

/**
 * @param msg Js8MessageAssembler 送出的訊息
 * @param opts.gate { call, passcode }（使用者自己的呼號與 APRS-IS passcode）；opts.dialHz 撥號頻率（不加聲音頻率）
 * @returns 要送 POST /aprs 的資料，或 null（不轉）
 */
export function igateRequest(msg, { gate, dialHz }) {
  if (!gate?.call || !Number.isInteger(gate.passcode)) return null;
  if (!msg?.complete || msg.utx || msg.callsignTo !== '@APRSIS') return null;
  const from = msg.callsignFrom ?? '';
  if (!from || from.startsWith('<')) return null;
  const text = msg.text ?? '';
  if (text.endsWith(' ✗')) return null; // checksum 驗不過
  const base = { gate: { call: gate.call, passcode: gate.passcode }, from };
  // freqHz：撥號頻率（同 App，封包註解寫「14.078MHz」）；0＝不明。snr 整數
  const tail = { freqHz: Math.round(dialHz ?? 0), snr: Math.round(msg.snr ?? 0), submode: msg.submode ?? 0 };
  if (msg.directedCmd === CMD_GRID) {
    const grid = text.match(/@APRSIS GRID ([A-Za-z0-9]+)/)?.[1]?.toUpperCase();
    if (!grid || !GRID_RE.test(grid) || grid === 'RR73') return null; // RR73 是 FT8 結尾語（轉送站也擋）
    return { ...base, kind: 'GRID', grid, ...tail };
  }
  if (msg.directedCmd === CMD_APRS) {
    const cmd = text.match(/@APRSIS CMD (.+)$/)?.[1];
    if (!cmd || !APRS_TYPES.includes(cmd[0])) return null;
    return { ...base, kind: 'CMD', cmd, ...tail };
  }
  return null;
}

// APRS-IS passcode（同 FT8TW AprsIsPasscode、aprsc passcode.c）：只用來核對使用者填的值（對不上提示、不擋），不自動算來登入
export function computePasscode(callsign) {
  let root = '';
  for (const ch of String(callsign ?? '')) {
    if (ch === '-' || root.length >= 9) break;
    root += ch.toUpperCase();
  }
  root = root.trim();
  if (!root) return null;
  let hash = 0x73e2;
  for (let i = 0; i < root.length; i += 2) {
    hash ^= root.charCodeAt(i) << 8;
    if (i + 1 < root.length) hash ^= root.charCodeAt(i + 1);
  }
  return hash & 0x7fff;
}

// 設定框的 passcode 提示（D23）：相符綠色（ok）、其他紅色；回 i18n key，畫面再翻
export function passcodeIndicator(call, passcode) {
  if (!call) return { key: 'js8chat.igate_need_call', ok: false };
  if (passcode === null) return { key: 'js8chat.igate_need_pass', ok: false };
  if (computePasscode(call) === passcode) return { key: 'js8chat.igate_match', ok: true, params: { call } };
  return { key: 'js8chat.igate_mismatch', ok: false, params: { call } }; // 對不上只提示，不擋（同 App）
}

// 轉送站 /aprs* 的錯誤碼 → i18n key
export const IGATE_ERROR_KEYS = Object.freeze({
  'bad-passcode': 'js8chat.igate_err_pass',
  'aprs-unverified': 'js8chat.igate_state.unverified',
  'igate-busy': 'js8chat.igate_err_busy',
  'trial-not-open': 'js8chat.igate_err_trial',
  'aprs-paused': 'js8chat.igate_err_paused', // 後台關閉 APRS 轉發（add-relay-forward-control F5）
  'forward-blocked': 'js8chat.igate_err_blocked',
  'igate-disabled': 'js8chat.igate_err_disabled',
  'test-only-local': 'js8chat.igate_err_testonly',
  'aprs-timeout': 'js8chat.igate_err_timeout',
  'aprs-unreachable': 'js8chat.igate_err_unreachable',
  'verify-cooldown': 'js8chat.igate_err_cooldown',
});
export const igateErrorKey = (code) => (Object.hasOwn(IGATE_ERROR_KEYS, code ?? '') ? IGATE_ERROR_KEYS[code] : null);

// POST /aprs/verify 的回應 → { ok, key, params } 或 { ok:false, error:{status, code} }（錯誤由畫面照錯誤碼翻）
export function verifyOutcome(status, json, call) {
  if (status === 200 && json?.result === 'verified') return { ok: true, key: 'js8chat.igate_verify_ok', params: { call } };
  if (status === 200 && json?.result === 'unverified') return { ok: false, key: 'js8chat.igate_state.unverified' };
  return { ok: false, error: { status, code: json?.error } };
}

export function parsePasscode(text) {
  const t = String(text ?? '').trim();
  if (!/^\d{1,5}$/.test(t)) return null;
  const v = Number(t);
  return v <= 0x7fff ? v : null;
}

/** 登入檢查的回應是否還算數：送出後結果被清掉（gen 變了）、passcode 或呼號改了，就丟掉舊結果 */
export function verifyStillCurrent(sent, now) {
  return sent.gen === now.gen && sent.call === now.call && sent.passcode === now.passcode;
}
