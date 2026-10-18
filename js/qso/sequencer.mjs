// 通聯序列決策器（design D9）：逐條移植 FT8TW QsoSequencer／QsoState／QsoEvent／QsoDecision／QsoContext／
// QsoAction／QsoStartOrder。純函式，不發射、不寫日誌；「要發哪一則」(txOrder) 與「在哪個階段」(state) 分開。
// 逐筆比對 webtest/fixtures/qso-golden.json 的 transitions／fromFunctionOrder／startOrder。
import { callsignTo, checkFunOrder, isMyCallsign } from './messages.mjs';
import { t } from '../i18n/index.mjs';

const enumOf = (...names) => Object.freeze(Object.fromEntries(names.map((n) => [n, n])));

export const QsoState = enumOf('IDLE', 'CALLING_CQ', 'CALLING_DX', 'EXCHANGING', 'ROGERING', 'SIGNING_OFF', 'COMPLETED');

export const QsoEvent = enumOf(
  'RX_TARGET_GRID', 'RX_TARGET_REPORT', 'RX_TARGET_ROGER', 'RX_TARGET_RR73', 'RX_TARGET_73', 'RX_TARGET_CQ',
  'RX_TARGET_CALLING_OTHER', 'RX_SILENCE', 'USER_SET_ORDER', 'USER_RESET_CQ', 'USER_CALL_TARGET', 'USER_DISARM',
  'LIMIT_NO_REPLY_REACHED',
);

export const QsoAction = enumOf('TRANSMIT', 'RESET_TO_CQ', 'PICK_CANDIDATE', 'STOP_TX', 'NO_ACTION');

export const NO_TX = -1;

// QsoContext.defaults()：不限次數、收尾補發 2 次、無候選
export const DEFAULT_CONTEXT = Object.freeze({
  noReplyLimit: 0, noReplyCount: 0, finishRetryLimit: 2, finishRetryCount: 0, hasExchanged: false, hasCandidates: false,
});

const canFinishRetry = (c) => c.finishRetryLimit > 0 && c.finishRetryCount < c.finishRetryLimit;
const noReplyLimitReached = (c) => c.noReplyLimit > 0 && c.noReplyCount >= c.noReplyLimit;

const decision = (state, action, txOrder, shouldLog, reason) => ({ state, action, txOrder, shouldLog, reason });
const stay = (state, reason) => decision(state, QsoAction.NO_ACTION, NO_TX, false, reason);
const transmit = (state, order, reason) => decision(state, QsoAction.TRANSMIT, order, false, reason);
const transmitAndLog = (state, order, reason) => decision(state, QsoAction.TRANSMIT, order, true, reason);
const pickCandidate = (state, log, reason) => decision(state, QsoAction.PICK_CANDIDATE, NO_TX, log, reason);
const resetToCq = (reason) => decision(QsoState.CALLING_CQ, QsoAction.RESET_TO_CQ, NO_TX, false, reason);

// 收到對方指名我的訊息後的共同轉移（CALLING_CQ／CALLING_DX／EXCHANGING 相同的部分）
function onReply(event, state) {
  switch (event) {
    case QsoEvent.RX_TARGET_GRID: return transmit(QsoState.EXCHANGING, 2, t('qso.seq.gridSendReport'));
    case QsoEvent.RX_TARGET_REPORT:
      return transmit(state === QsoState.EXCHANGING ? QsoState.ROGERING : QsoState.EXCHANGING, 3, t('qso.seq.reportSendRReport'));
    case QsoEvent.RX_TARGET_ROGER: return transmitAndLog(QsoState.SIGNING_OFF, 4, t('qso.seq.rogerSendRR73'));
    case QsoEvent.RX_TARGET_RR73: return transmitAndLog(QsoState.SIGNING_OFF, 5, t('qso.seq.rr73Send73'));
    case QsoEvent.RX_TARGET_73: return pickCandidate(QsoState.COMPLETED, true, t('qso.seq.got73Next'));
    default: return null;
  }
}

function fromCallingCq(event, ctx) {
  const reply = onReply(event, QsoState.CALLING_CQ);
  if (reply) return reply;
  switch (event) {
    case QsoEvent.RX_TARGET_CQ: return transmit(QsoState.CALLING_DX, 1, t('qso.seq.followCq'));
    case QsoEvent.RX_SILENCE:
    case QsoEvent.RX_TARGET_CALLING_OTHER:
    case QsoEvent.LIMIT_NO_REPLY_REACHED:
      if (ctx.hasCandidates) return pickCandidate(QsoState.CALLING_CQ, false, t('qso.seq.cqNoReplyCandidates'));
      if (noReplyLimitReached(ctx) || event === QsoEvent.LIMIT_NO_REPLY_REACHED) {
        return decision(QsoState.IDLE, QsoAction.STOP_TX, NO_TX, false, t('qso.seq.cqLimit'));
      }
      return stay(QsoState.CALLING_CQ, t('qso.seq.continueCq'));
    default: return stay(QsoState.CALLING_CQ, t('qso.seq.cqIgnore'));
  }
}

function fromCallingDx(event, ctx) {
  const reply = onReply(event, QsoState.CALLING_DX);
  if (reply) return reply;
  switch (event) {
    case QsoEvent.RX_SILENCE:
    case QsoEvent.RX_TARGET_CQ:
    case QsoEvent.RX_TARGET_CALLING_OTHER:
      if (ctx.hasCandidates) return pickCandidate(QsoState.CALLING_CQ, false, t('qso.seq.dxNoReplyCandidates'));
      if (noReplyLimitReached(ctx)) return resetToCq(t('qso.seq.dxLimitBackToCq'));
      return stay(QsoState.CALLING_DX, t('qso.seq.dxNoReplyContinue'));
    default: return stay(QsoState.CALLING_DX, t('qso.seq.dxIgnore'));
  }
}

function fromExchanging(event, ctx) {
  const reply = onReply(event, QsoState.EXCHANGING);
  if (reply) return reply;
  switch (event) {
    case QsoEvent.RX_SILENCE:
    case QsoEvent.RX_TARGET_CQ:
    case QsoEvent.RX_TARGET_CALLING_OTHER:
      if (noReplyLimitReached(ctx)) return pickCandidate(QsoState.CALLING_CQ, false, t('qso.seq.exLost'));
      return stay(QsoState.EXCHANGING, t('qso.seq.exResend'));
    default: return stay(QsoState.EXCHANGING, t('qso.seq.exIgnore'));
  }
}

function fromRogering(event, ctx) {
  switch (event) {
    case QsoEvent.RX_TARGET_RR73: return transmitAndLog(QsoState.SIGNING_OFF, 5, t('qso.seq.rr73Send73'));
    case QsoEvent.RX_TARGET_73: return pickCandidate(QsoState.COMPLETED, true, t('qso.seq.got73Next'));
    case QsoEvent.RX_TARGET_ROGER: return transmitAndLog(QsoState.SIGNING_OFF, 4, t('qso.seq.bothRogerSendRR73'));
    case QsoEvent.RX_TARGET_REPORT: return transmit(QsoState.ROGERING, 3, t('qso.seq.reportResendR'));
    case QsoEvent.RX_TARGET_GRID: return transmit(QsoState.EXCHANGING, 2, t('qso.seq.gridBackToExchange'));
    case QsoEvent.RX_SILENCE:
    case QsoEvent.RX_TARGET_CQ:
    case QsoEvent.RX_TARGET_CALLING_OTHER:
      if (noReplyLimitReached(ctx)) return pickCandidate(QsoState.CALLING_CQ, false, t('qso.seq.rr73WaitLimit'));
      return stay(QsoState.ROGERING, t('qso.seq.rr73WaitResend'));
    default: return stay(QsoState.ROGERING, t('qso.seq.rogIgnore'));
  }
}

// 已送 RR73／73、已記錄：再送收尾本身就是重送語意；對方重送舊步驟只補 RR73，不重做、不重複記錄（issue#82）
function fromSigningOff(event, ctx) {
  switch (event) {
    case QsoEvent.RX_TARGET_RR73:
      return canFinishRetry(ctx)
        ? transmit(QsoState.SIGNING_OFF, 5, t('qso.seq.resend73'))
        : pickCandidate(QsoState.COMPLETED, false, t('qso.seq.finishLimit'));
    case QsoEvent.RX_TARGET_GRID:
    case QsoEvent.RX_TARGET_REPORT:
    case QsoEvent.RX_TARGET_ROGER:
      return canFinishRetry(ctx)
        ? transmit(QsoState.SIGNING_OFF, 4, t('qso.seq.resendRR73'))
        : pickCandidate(QsoState.COMPLETED, false, t('qso.seq.finishLimitIgnore'));
    case QsoEvent.RX_TARGET_73: return pickCandidate(QsoState.COMPLETED, false, t('qso.seq.got73Done'));
    case QsoEvent.RX_SILENCE:
    case QsoEvent.RX_TARGET_CQ:
    case QsoEvent.RX_TARGET_CALLING_OTHER:
      return pickCandidate(QsoState.COMPLETED, false, t('qso.seq.silentNext'));
    default: return stay(QsoState.SIGNING_OFF, t('qso.seq.soIgnore'));
  }
}

// QsoSequencer.next：回傳 { state, action, txOrder, shouldLog, reason }，永不為 null
export function next(state, event, ctx) {
  if (state == null || event == null) return stay(QsoState.IDLE, t('qso.seq.nullInput'));
  const c = ctx ?? DEFAULT_CONTEXT;
  switch (event) {
    case QsoEvent.USER_DISARM: return decision(QsoState.IDLE, QsoAction.STOP_TX, NO_TX, false, t('qso.seq.userStop'));
    case QsoEvent.USER_RESET_CQ: return resetToCq(t('qso.seq.userCq'));
    case QsoEvent.USER_CALL_TARGET: return transmit(QsoState.CALLING_DX, 1, t('qso.seq.userCall'));
    case QsoEvent.USER_SET_ORDER: return stay(state, t('qso.seq.userOrder'));
    default: break;
  }
  switch (state) {
    case QsoState.IDLE: return stay(QsoState.IDLE, t('qso.seq.idle'));
    case QsoState.CALLING_CQ: return fromCallingCq(event, c);
    case QsoState.CALLING_DX: return fromCallingDx(event, c);
    case QsoState.EXCHANGING: return fromExchanging(event, c);
    case QsoState.ROGERING: return fromRogering(event, c);
    case QsoState.SIGNING_OFF: return fromSigningOff(event, c);
    case QsoState.COMPLETED: return pickCandidate(QsoState.CALLING_CQ, false, t('qso.seq.completedNext'));
    default: return stay(state, t('qso.seq.unknownState'));
  }
}

// QsoSequencer.fromFunctionOrder：由 functionOrder（1~6）與旗標推回語意狀態
export function fromFunctionOrder(order, callingCq, saved, peerReplied) {
  if (saved && (order === 4 || order === 5)) return QsoState.SIGNING_OFF;
  if (callingCq || order === 6) return QsoState.CALLING_CQ;
  switch (order) {
    case 1: return peerReplied ? QsoState.EXCHANGING : QsoState.CALLING_DX;
    case 2: return QsoState.EXCHANGING;
    case 3: return QsoState.ROGERING;
    case 4:
    case 5: return QsoState.EXCHANGING;
    default: return QsoState.IDLE;
  }
}

const ORDER_EVENT = [null, 'RX_TARGET_GRID', 'RX_TARGET_REPORT', 'RX_TARGET_ROGER', 'RX_TARGET_RR73', 'RX_TARGET_73', 'RX_TARGET_CQ'];

// QsoEvent.fromMessage 的序號版：1~6 以外一律「對方在呼叫別人」
export function eventFromOrder(order) {
  return ORDER_EVENT[order] ?? QsoEvent.RX_TARGET_CALLING_OTHER;
}

export function eventFromMessage(msg) {
  return msg == null ? QsoEvent.RX_TARGET_CALLING_OTHER : eventFromOrder(checkFunOrder(msg));
}

// QsoStartOrder.MAX_AGE_MS：選中的訊息超過 5 分鐘就不跳步
export const START_ORDER_MAX_AGE_MS = 5 * 60 * 1000;

// QsoStartOrder.forReplyTo：直接呼叫時從第幾步開始（1~5）；不是指名我、太舊、或會變成不發射的一律 1
export function forReplyTo(msg, { myCall, now, msgUtc }) {
  if (msg == null || !isMyCallsign(myCall, callsignTo(msg))) return 1;
  if (now - msgUtc > START_ORDER_MAX_AGE_MS) return 1;
  const d = next(QsoState.CALLING_CQ, eventFromMessage(msg), DEFAULT_CONTEXT);
  if (d.action !== QsoAction.TRANSMIT || d.txOrder < 1 || d.txOrder > 5) return 1;
  return d.txOrder;
}

