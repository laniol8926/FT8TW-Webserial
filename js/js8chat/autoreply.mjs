// JS8 自動回覆與心跳（HB）規則，純函式、不可變狀態。
// 移植自 App Js8AutoReply.onRxMessage／maybeReplyCq／maybeAckHeartbeat／buildReply、
// Js8HbAckLimiter（額度）、Js8RxKey.shouldAutoReply（速度閘門）。規格：add-web-js8-chat D7、D15。
//
// 用法（Wave 3 接線）：
//   const r = decide(msg, ctx, state, nowMs);
//   if (r.text && txController 接受這則發射) state = r.state;   // 拒收就保留舊 state
// App 只在 sendMessage 成功後才記冷卻／額度；decide 回傳的 state 是「假設送出成功」的狀態，
// 送不出去時呼叫端不可採用，否則放棄的那次也會吃掉冷卻與額度。
// 沒有要回（text===null）時，回傳的 state 一律是傳入的同一個物件。

/** 同一來源的查詢冷卻 */
export const REPLY_COOLDOWN_MS = 60_000;
/** CQ 自動回覆的同台冷卻：對方連續 CQ 只回第一次，之後由人接手 */
export const CQ_REPLY_COOLDOWN_MS = 10 * 60_000;
/** HEARING? 回報最近幾分鐘聽到的台、最多幾個（與長按回覆共用） */
export const HEARING_MINUTES = 15;
export const HEARING_MAX = 4;
/** HB ACK 總量視窗（滑動，不是整點歸零） */
export const HOUR_MS = 60 * 60 * 1000;
/** HB ACK 單台視窗 */
export const PER_CALL_WINDOW_MS = 10 * 60 * 1000;

// directed 指令值（web/js/js8/varicode.mjs DIRECTED_CMDS）
const CMD_SNR_Q = 0;
const CMD_HEARING_Q = 3;
const CMD_GRID_Q = 4;
const CMD_INFO_Q = 16;
const CMD_AGN_Q = 30;

export function initialState() {
  return { lastReplyTo: {}, lastCqReplyTo: {}, hbAcks: [] };
}

/** 速度閘門：發射只有一個速度，別的速度只顯示不回。未知（-1／未給）放行。 */
export function shouldAutoReply(msgSubmode, txSubmode) {
  if (msgSubmode === undefined || msgSubmode === null || msgSubmode < 0) return true;
  return msgSubmode === txSubmode;
}

/** GeneralVariables.checkIsMyCallsign：完全相同、MY/xxx、xxx/MY；只是包含不算 */
export function isMyCall(callsign, myCall) {
  if (!myCall || !myCall.trim() || !callsign || !callsign.trim()) return false;
  const my = myCall.trim().toUpperCase();
  const c = callsign.trim().toUpperCase();
  return c === my || c.startsWith(`${my}/`) || c.endsWith(`/${my}`);
}

/** JS8 的 SNR 欄位只編得下 -30～+31，超出會被數值正則截半，送出前先夾住 */
export function clampSnr(snr) {
  const n = Math.round(Number(snr));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-30, Math.min(30, n)) || 0; // || 0：把 -0 變成 0
}

/** Java String.format("%+03d") */
export function formatSnr(snr) {
  const n = clampSnr(snr);
  return (n < 0 ? '-' : '+') + String(Math.abs(n)).padStart(2, '0');
}

/** GeneralVariables.resolveJs8InfoContent：設定恰為 VERSION（不分大小寫）時代入版本，其餘轉大寫 */
export function resolveInfo(info, version) {
  if (info === undefined || info === null) return '';
  const t = String(info).trim();
  if (t.toUpperCase() === 'VERSION') return `VERSION ${version ?? ''}`.trim();
  return t.toUpperCase();
}

const grid4 = (grid) => (grid ? String(grid).trim().slice(0, 4) : '');

// ── HB ACK 額度（Js8HbAckLimiter）──

const hbKey = (call) => String(call).trim().toUpperCase();
const validLimit = (n) => Number.isFinite(n) && n > 0;

/** 最近一小時 ACK 幾次 */
export function hbAckCountInHour(state, now) {
  return state.hbAcks.filter((a) => now - a.t < HOUR_MS).length;
}

/** 這個呼號最近十分鐘 ACK 幾次 */
export function hbAckCountForCall(state, callsign, now) {
  if (!callsign) return 0;
  const k = hbKey(callsign);
  return state.hbAcks.filter((a) => a.call === k && now - a.t < PER_CALL_WINDOW_MS).length;
}

/** 額度過不過得了；不會吃掉額度。空呼號、上限值壞掉（≤0、非數字）一律 false */
export function hbAckAllow(state, callsign, now, maxPerHour, maxPerCall) {
  if (!callsign || !String(callsign).trim()) return false;
  if (!validLimit(maxPerHour) || !validLimit(maxPerCall)) return false;
  if (hbAckCountInHour(state, now) >= maxPerHour) return false;
  return hbAckCountForCall(state, callsign, now) < maxPerCall;
}

/** 記一筆已送出的 ACK（回傳新 state，順便丟掉滑出一小時視窗的紀錄） */
export function hbAckRecord(state, callsign, now) {
  if (!callsign || !String(callsign).trim()) return state;
  const kept = state.hbAcks.filter((a) => now - a.t < HOUR_MS);
  return { ...state, hbAcks: [...kept, { call: hbKey(callsign), t: now }] };
}

// ── 冷卻表 ──

const inCooldown = (map, call, now, ms) => {
  const last = map[call];
  return last !== undefined && now - last < ms;
};

// 寫入時順便清掉已過冷卻的紀錄，長時間掛機不會無限成長
const withStamp = (map, call, now, ms) => {
  const out = {};
  for (const [k, t] of Object.entries(map)) if (now - t < ms) out[k] = t;
  out[call] = now;
  return out;
};

// ── 主判斷 ──

const none = (state) => ({ text: null, state });

/**
 * 收到一則組好的 JS8 訊息，決定要不要自動回覆。
 * @param msg   message.mjs 的訊息（callsignFrom, callsignTo, isCq, isHeartbeat, directedCmd, snr, complete, submode）
 * @param ctx   { enabled, replyCq, replyHb, hbHourlyLimit, hbPerCallLimit, myCall, myGrid, info, version,
 *                txBusy, txSubmode, heardRecently(nowMs, minutes, max)→[call…], lastSentText }
 * @param state initialState() 或上一次採用的 state
 * @returns {{ text: string|null, state, kind?: 'directed'|'cq'|'hb', to?: string }}
 */
export function decide(msg, ctx, state = initialState(), nowMs) {
  if (!ctx.enabled) return none(state);
  const from = msg.callsignFrom;
  if (!from) return none(state);
  // 未解出的雜湊呼號、自己發射的回授：都不回（App 只在 CQ／HB 路徑擋自己，這裡三條路徑一起擋）
  if (from.startsWith('<') || isMyCall(from, ctx.myCall)) return none(state);
  // 速度閘門放在三條路徑之前，一起擋
  if (!shouldAutoReply(msg.submode, ctx.txSubmode)) return none(state);

  if (msg.isCq && msg.complete) return replyCq(msg, ctx, state, nowMs);
  if (msg.isHeartbeat && msg.complete) return ackHeartbeat(msg, ctx, state, nowMs);

  if (msg.directedCmd < 0 || !msg.complete) return none(state);
  if (!isMyCall(msg.callsignTo, ctx.myCall)) return none(state);
  if (inCooldown(state.lastReplyTo, from, nowMs, REPLY_COOLDOWN_MS)) return none(state);
  const text = buildReply(msg, ctx, nowMs);
  if (text === null) return none(state);
  if (ctx.txBusy) return none(state); // 忙就放棄：不排隊、不記冷卻
  return {
    text, kind: 'directed', to: from,
    state: { ...state, lastReplyTo: withStamp(state.lastReplyTo, from, nowMs, REPLY_COOLDOWN_MS) },
  };
}

function replyCq(msg, ctx, state, now) {
  if (!ctx.replyCq) return none(state);
  const from = msg.callsignFrom;
  if (inCooldown(state.lastCqReplyTo, from, now, CQ_REPLY_COOLDOWN_MS)) return none(state);
  if (ctx.txBusy) return none(state);
  return {
    text: `${from} SNR ${formatSnr(msg.snr)}`, kind: 'cq', to: from,
    state: { ...state, lastCqReplyTo: withStamp(state.lastCqReplyTo, from, now, CQ_REPLY_COOLDOWN_MS) },
  };
}

function ackHeartbeat(msg, ctx, state, now) {
  if (!ctx.replyHb) return none(state);
  const from = msg.callsignFrom;
  if (!hbAckAllow(state, from, now, ctx.hbHourlyLimit, ctx.hbPerCallLimit)) return none(state);
  if (ctx.txBusy) return none(state); // 額度只在真的送出後才記
  return {
    text: `${from} HEARTBEAT SNR ${formatSnr(msg.snr)}`, kind: 'hb', to: from,
    state: hbAckRecord(state, from, now),
  };
}

function buildReply(msg, ctx, now) {
  const from = msg.callsignFrom;
  switch (msg.directedCmd) {
    case CMD_SNR_Q:
      return `${from} SNR ${formatSnr(msg.snr)}`;
    case CMD_GRID_Q: {
      const g = grid4(ctx.myGrid);
      return g ? `${from} GRID ${g}` : null;
    }
    case CMD_INFO_Q: {
      if (!ctx.info || !String(ctx.info).trim()) return null;
      return `${from} INFO ${resolveInfo(ctx.info, ctx.version)}`;
    }
    case CMD_HEARING_Q: {
      // App 順序：先取前 HEARING_MAX 個，再去掉發問者（所以可能只剩 3 個）
      const heard = typeof ctx.heardRecently === 'function'
        ? ctx.heardRecently(now, HEARING_MINUTES, HEARING_MAX) : null;
      const calls = (heard || []).slice(0, HEARING_MAX).filter((c) => c !== from);
      return calls.length ? `${from} HEARING ${calls.join(' ')}` : null;
    }
    case CMD_AGN_Q:
      return ctx.lastSentText ? `${from} ${ctx.lastSentText}` : null;
    default: // STATUS? 等其他指令不自動回
      return null;
  }
}

// ── 心跳 ──

/** HB 定時是否到期；intervalMin ≤0／未給＝關。從沒送過（lastHbUtc 為 0）馬上到期。忙不忙由呼叫端判斷。 */
export function nextHeartbeatDue(intervalMin, lastHbUtc, nowUtc) {
  if (!(intervalMin > 0)) return false;
  return nowUtc - (lastHbUtc || 0) >= intervalMin * 60_000;
}

/** `HB <4 碼網格>`；沒網格時照 App 送 `HB` */
export function heartbeatText(myGrid) {
  return `HB ${grid4(myGrid)}`.trim();
}

/** 有狀態的薄包裝：decide 不改狀態，確定送出後 commit(r) 才生效 */
export function createAutoReply() {
  let state = initialState();
  return {
    get state() { return state; },
    decide: (msg, ctx, nowMs) => decide(msg, ctx, state, nowMs),
    commit(r) { if (r && r.text && r.state) state = r.state; },
    reset() { state = initialState(); },
  };
}
