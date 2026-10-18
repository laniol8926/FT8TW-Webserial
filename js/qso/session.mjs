// 自動通聯的一場場流程（qso-automation spec）：把 FT8TW FT8TransmitSignal 實際驅動發射的流程
// （parseMessagesLegacy 的計數、候選、冷卻、單次通聯，以及 doTransmit 的收尾）接到移植的 QsoSequencer 上。
// 對方回應我時「下一步發哪一則／要不要記錄／放棄」由 sequencer.next 決定（design D9），其餘是 FT8TW 的外圍規則。
//
// 全是純函式：每個入口吃舊 state、回傳 { state, ...結果 }，不碰時間、不碰發射。主線用法：
//   接收 slot 解碼完 → onDecoded(state, { parity, now, messages })
//   我方 slot 開始前 → beforeTransmit(state, now) 取得要發的 tx（null＝本輪不發）
//   使用者 → startCq／callTo／selectOrder／stop
//
// 與 FT8TW 刻意不同（spec 優先或修 FT8TW 的缺陷）：
//   - 收尾補發：本場補發與冷卻期補發共用一份額度（spec：最多 finishRetryLimit 次；FT8TW 兩份各算，最多 2×）
//   - 換對象時清掉上一場的解碼 SNR、收到的報告、對方網格（FT8TW 這幾個欄位會殘留到下一場）
//   - 記錄的報告：FT8TW doComplete 從訊息歷史撈；這裡在換對象時帶入對方那則的報告
//   - 自由文字、未解開的雜湊 <...> 不當候選、不自動回應（FT8TW 會把 "..." 當呼號叫）
//   - CQ 達 noReplyLimit：照 FT8TW 實際行為（issue#90）只歸零繼續 CQ，不採 QsoSequencer 的 STOP_TX；
//     完全停發交給主線的發射監管逾時
// 沒移植：關注呼號／追蹤清單／距離與 zone 評分（只做方案 0：SNR）、遲到收尾補寫（completeLateQso）、
//   野外日、待命、跟頻、解碼逾時跳過、發射監管 15 分鐘（主線負責）
import {
  NO_REPORT, parseFt8Text, callsignTo, callsignFrom, checkFunOrder, checkFun1, checkFun3, checkFun4, checkFun5,
  hasNumericReport, reportFromExtra, isMyCallsign, bothNonstandard, isValidReport, standardMessages,
  resolveSentReport, resolveReceivedReport, reportRetryLimit, directCallRefusal, REFUSAL,
} from './messages.mjs';
import { QsoAction, QsoState, next, fromFunctionOrder, eventFromOrder, forReplyTo } from './sequencer.mjs';
import { t } from '../i18n/index.mjs';
import {
  DEFAULT_FINISH_RETRY_LIMIT, DEFAULT_NO_REPLY_LIMIT, markQsoCompleted, isInQsoCooldown, canCooldownFinishRetry,
  markCooldownFinishRetry, cooldownRetries, addFail, removeFail, isFailed, releaseOldestFail, addCandidate, removeCandidate, takeCandidate,
} from './retry.mjs';

// 自動回應 CQ 的評分（setScoreWeight 方案 0：ASAP／SNR）。叫我的訊息每一步 1300 分，必定勝過 CQ。
const WEIGHT_CALLING_ME = 1300;
const WEIGHT_IS_CQ = 1.5;
const WEIGHT_SNR = 20;
const WEIGHT_OTA = 500;
const MAX_RELEASE_LOOPS = 10;
const OTA_CQ = /^CQ\s+(SOTA|POTA|OTA)\b/i;

export function createSession({
  myCall, myGrid = '', modifier = null, contest = false, band = 0, slotMs = 15000,
  noReplyLimit = DEFAULT_NO_REPLY_LIMIT, finishRetryLimit = DEFAULT_FINISH_RETRY_LIMIT, autoFollowCQ = false,
  excludeCalls = [],
}) {
  return {
    cfg: { myCall, myGrid, modifier, contest, band, slotMs, noReplyLimit, finishRetryLimit, autoFollowCQ, excludeCalls },
    active: false,
    singleQso: false, // 單次通聯：發射原本關著時直接呼叫，做完（或放棄）就停
    target: null, // { call, snr, freqHz }；call 為 'CQ' 表示呼 CQ
    order: 6, // 下一則要發第幾則（1~6）
    mySeq: 0, // 我方發射時序奇偶
    saved: false, finishRetryCount: 0, finishRetrying: false, finishTxSent: false,
    awaitingReply: false, noReplyCount: 0,
    lastRespOrder: -1, lastRespCall: '', sameRespCount: 0,
    sendReport: NO_REPORT, receivedReport: NO_REPORT, receiveTargetReport: NO_REPORT, sentTargetReport: NO_REPORT,
    peerGrid: '', peerReplied: false, startUtc: 0,
    candidates: [], failList: [], cooldown: {}, evidence: [], forceOnceAt: null, cooldownRetry: null,
    qsoState: QsoState.IDLE,
  };
}

// ===== 內部：直接改 s（呼叫端已 structuredClone），out 收集結果 =====

const isCqCall = (call) => call == null || call === '' || call.toUpperCase() === 'CQ';
const callingCq = (s) => !s.target || isCqCall(s.target.call);
const hasEvidence = (s, call) => s.evidence.includes(call);
const isAlreadyWorked = (s, call, now) => s.cfg.excludeCalls.includes(call) || isInQsoCooldown(s.cooldown, call, s.cfg.band, now);

function resetTargetReport(s) {
  s.receiveTargetReport = NO_REPORT;
  s.sentTargetReport = NO_REPORT;
  s.saved = false;
  s.finishRetryCount = 0;
  s.finishRetrying = false;
  s.finishTxSent = false;
}

function resetReportRetry(s) {
  s.lastRespOrder = -1;
  s.lastRespCall = '';
  s.sameRespCount = 0;
}

// setTransmit：換對象。報告與網格跟著對象走（FT8TW 這兩個欄位跨對象殘留，見回報）
function setTarget(s, { call, snr = NO_REPORT, freqHz = 0 }, order, grid = '') {
  const changed = !s.target || s.target.call !== call;
  s.target = { call, snr, freqHz };
  s.order = order;
  s.startUtc = 0;
  if (changed) {
    s.sendReport = NO_REPORT;
    s.receivedReport = NO_REPORT;
    s.peerReplied = false;
    s.peerGrid = '';
  }
  if (grid && checkFun1(grid) && grid.trim()) s.peerGrid = grid;
}

function finishSingleQso(s, out, reason) {
  if (!s.singleQso) return false;
  s.active = false;
  s.singleQso = false;
  out.stopped = true;
  out.reason = t('qso.singleDone', { reason });
  resetToCq(s, out, false);
  return true;
}

function resetToCq(s, out, userInitiated) {
  resetReportRetry(s);
  if (!userInitiated && finishSingleQso(s, out, t('qso.why.backToCq'))) return;
  resetTargetReport(s);
  if (!s.target || !isCqCall(s.target.call)) setTarget(s, { call: 'CQ' }, 6);
  s.order = 6;
}

// doComplete：寫一筆 QSO（沒交換證據就只標記收尾完畢、不寫）
function doComplete(s, out, now) {
  if (s.saved || !s.target) return;
  const call = s.target.call;
  s.saved = true;
  if (!hasEvidence(s, call)) {
    out.reason = t('qso.notExchanged', { call });
    return;
  }
  s.cooldown = markQsoCompleted(s.cooldown, call, s.cfg.band, now);
  s.candidates = removeCandidate(s.candidates, call);
  out.log = {
    call,
    grid: s.peerGrid,
    rstSent: resolveSentReport(s.sentTargetReport, NO_REPORT, s.sendReport),
    rstRcvd: resolveReceivedReport(s.receiveTargetReport, s.receivedReport),
    startUtc: s.startUtc || now,
    endUtc: now,
    band: s.cfg.band,
  };
}

// callFromCQME：去回應叫過我的人（order 最高的先）；全被排除就回 CQ
function callFromCandidates(s, out, now) {
  if (finishSingleQso(s, out, t('qso.why.noFollowOn'))) return;
  if (s.candidates.length === 0) return;
  let picked = null;
  while (s.candidates.length > 0) {
    const r = takeCandidate(s.candidates, now);
    s.candidates = r.list;
    if (!r.picked) break;
    if (isAlreadyWorked(s, r.picked.call, now)) continue;
    picked = r.picked;
    break;
  }
  if (!picked) {
    resetToCq(s, out, false);
    return;
  }
  const order = picked.order + 1 >= 6 ? 1 : picked.order + 1;
  resetTargetReport(s);
  s.noReplyCount = 0;
  setTarget(s, { call: picked.call, snr: picked.snr, freqHz: picked.freqHz }, order, picked.grid);
  heardReport(s, picked.report);
}

function candidatesOrCq(s, out, now) {
  if (s.candidates.length > 0) callFromCandidates(s, out, now);
  else resetToCq(s, out, false);
}

// tryCooldownFinishRetry：冷卻中的舊對象還在等我的收尾 → 補一次 RR73（不重做、不寫記錄）
function tryCooldownFinishRetry(s, now) {
  const retry = s.cooldownRetry;
  s.cooldownRetry = null;
  if (!retry || !canCooldownFinishRetry(s.cooldown, retry.call, s.cfg.band, now, s.cfg.finishRetryLimit)) return false;
  s.cooldown = markCooldownFinishRetry(s.cooldown, retry.call, s.cfg.band, now).table;
  setTarget(s, { call: retry.call, freqHz: retry.freqHz }, 4);
  s.saved = true;
  s.finishRetrying = true;
  return true;
}

function giveUpTarget(s, now) {
  const call = s.target.call;
  s.failList = addFail(s.failList, call, now);
  s.candidates = removeCandidate(s.candidates, call);
}

// 掃描本批訊息：收集叫我的候選、冷卻中等收尾的舊對象、自動回應 CQ 的最佳對象
function scan(s, msgs, now) {
  const { myCall, autoFollowCQ } = s.cfg;
  let best = null;
  for (let loop = 0; ; loop++) {
    let highest = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const from = callsignFrom(m);
      if (m.free || !from || from.includes('...')) continue; // 自由文字、雜湊呼號不當對象
      const to = callsignTo(m);
      const toMe = isMyCallsign(myCall, to);
      let funOrder = checkFunOrder(m);
      if (funOrder >= 6 || !toMe) funOrder = 0; // 非指名給我的，序列進度一律不採用
      const namedCallToMe = toMe && !checkFun4(m.extraInfo) && !checkFun5(m.extraInfo) && from !== myCall;
      if (isFailed(s.failList, from) && !namedCallToMe) continue;
      if (isAlreadyWorked(s, from, now)) {
        if (namedCallToMe && checkFun3(m.extraInfo)) s.cooldownRetry = { call: from, freqHz: m.freqHz };
        continue;
      }
      if (s.target && s.target.call === from) continue;
      let score = 0;
      let scored = false;
      if (namedCallToMe) {
        scored = true;
        score += WEIGHT_CALLING_ME * funOrder;
        s.candidates = addCandidate(s.candidates, candidateOf(m, from, funOrder), now);
        s.failList = removeFail(s.failList, from);
      }
      if (to === '' && !s.cfg.excludeCalls.includes(from)) {
        scored = true;
        score += WEIGHT_IS_CQ + (m.snr + 30) * WEIGHT_SNR;
        if (OTA_CQ.test(m.callsignTo.trim())) {
          score += WEIGHT_OTA;
          if (autoFollowCQ) s.candidates = addCandidate(s.candidates, candidateOf(m, from, funOrder), now);
        }
      }
      if (scored && autoFollowCQ && score > 0 && score > highest) {
        highest = score;
        best = { msg: m, call: from, funOrder };
      }
    }
    if (best || s.failList.length === 0) return best;
    const r = releaseOldestFail(s.failList, now);
    if (!r.released || loop >= MAX_RELEASE_LOOPS) return null;
    s.failList = r.list;
  }
}

// 對方那則帶的數字報告（R＋網格沒有）。FT8TW doComplete 從訊息歷史撈，這裡在換對象時帶過去
const reportOf = (m) => (hasNumericReport(m.extraInfo) ? reportFromExtra(m.extraInfo) : NO_REPORT);

function heardReport(s, report) {
  if (report === NO_REPORT) return;
  s.receivedReport = report;
  s.receiveTargetReport = report;
}

function candidateOf(m, call, order) {
  const grid = checkFun1(m.extraInfo) && m.extraInfo.trim() ? m.extraInfo.trim() : '';
  return { call, order, freqHz: m.freqHz, snr: m.snr, grid, report: reportOf(m), text: m.text };
}

// checkFunctionOrdFromMessages：本批最後一則「對象→我」的序列步驟，順便記下報告
function respOrderOf(s, msgs) {
  if (!s.target || isCqCall(s.target.call)) return -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!isMyCallsign(s.cfg.myCall, callsignTo(m)) || callsignFrom(m) !== s.target.call) continue;
    if (hasNumericReport(m.extraInfo)) {
      s.receivedReport = reportFromExtra(m.extraInfo);
      s.receiveTargetReport = s.receivedReport;
    }
    s.sendReport = m.snr;
    if (checkFun1(m.extraInfo) && m.extraInfo.trim()) s.peerGrid = m.extraInfo.trim();
    return checkFunOrder(m);
  }
  return -1;
}

function parseAll(messages) {
  return messages.map((m) => ({ ...parseFt8Text(m.text), text: m.text, snr: m.snr ?? NO_REPORT, freqHz: m.freqHz ?? 0 }));
}

function onTargetReplied(s, out, respOrder, now) {
  const call = s.target.call;
  if (!(s.saved && respOrder < 4)) {
    // 對方連續送同一步＝雙方都沒推進（單向失聰），達 reportRetryLimit 放棄
    if (respOrder === s.lastRespOrder && call.toUpperCase() === s.lastRespCall.toUpperCase()) {
      s.sameRespCount += 1;
      if (s.sameRespCount >= reportRetryLimit(s.cfg.finishRetryLimit)) {
        out.reason = t('qso.sameRespGiveUp', { call, n: s.sameRespCount });
        giveUpTarget(s, now);
        resetReportRetry(s);
        resetToCq(s, out, false);
        return;
      }
    } else {
      s.lastRespOrder = respOrder;
      s.lastRespCall = call;
      s.sameRespCount = 0;
    }
  }
  const before = fromFunctionOrder(s.order, false, s.saved, s.peerReplied);
  s.peerReplied = true;
  // 收尾補發額度：本場補發與冷卻期補發共用一份（spec：最多 finishRetryLimit 次；FT8TW 兩份各自計數）
  const retried = Math.max(s.finishRetryCount, cooldownRetries(s.cooldown, call, s.cfg.band, now));
  const d = next(before, eventFromOrder(respOrder), {
    noReplyLimit: s.cfg.noReplyLimit, noReplyCount: s.noReplyCount,
    finishRetryLimit: s.cfg.finishRetryLimit, finishRetryCount: retried,
    hasExchanged: true, hasCandidates: s.candidates.length > 0,
  });
  out.reason = d.reason;
  if (d.action === QsoAction.TRANSMIT) {
    if (before === QsoState.SIGNING_OFF) {
      s.finishRetryCount = retried + 1; // 收尾補發，不重做、不重複記錄
      s.finishRetrying = true;
      s.cooldown = markCooldownFinishRetry(s.cooldown, call, s.cfg.band, now).table;
    } else {
      s.noReplyCount = 0;
    }
    s.order = d.txOrder;
    if (d.shouldLog && d.txOrder !== 4) doComplete(s, out, now); // RR73（第 4 則）在送出時才記錄，同 FT8TW doTransmit
    return;
  }
  if (d.shouldLog) doComplete(s, out, now);
  candidatesOrCq(s, out, now);
}

function onTargetSilent(s, out, now) {
  if (s.saved && !s.finishRetrying) {
    out.reason = t('qso.doneSilentNext');
    candidatesOrCq(s, out, now);
    return;
  }
  if ((s.order === 1 || s.order === 6) && !s.singleQso && s.candidates.length > 0) {
    out.reason = t('qso.noReplyCallCaller');
    callFromCandidates(s, out, now);
    return;
  }
  out.reason = t('qso.noReplyContinue');
}

function onCallingCq(s, out, best, respOrder, now) {
  if (best) {
    const order = best.funOrder + 1;
    if (order <= 2 && s.candidates.length > 0) {
      callFromCandidates(s, out, now);
      return;
    }
    resetTargetReport(s);
    s.noReplyCount = 0;
    const grid = checkFun1(best.msg.extraInfo) ? best.msg.extraInfo.trim() : '';
    setTarget(s, { call: best.call, snr: best.msg.snr, freqHz: best.msg.freqHz }, order >= 6 ? 1 : order, grid);
    heardReport(s, reportOf(best.msg));
    out.reason = t('qso.autoReply', { call: best.call });
    return;
  }
  if (s.candidates.length > 0) {
    callFromCandidates(s, out, now);
    return;
  }
  if (tryCooldownFinishRetry(s, now)) {
    out.reason = t('qso.cooldownRR73');
    return;
  }
  if (respOrder === -1 && s.cfg.noReplyLimit > 0 && s.noReplyCount >= s.cfg.noReplyLimit) {
    s.noReplyCount = 0; // CQ 達上限只歸零繼續呼（停發交給發射監管，issue#90）
  }
}

function finalize(s, out) {
  s.qsoState = s.active ? fromFunctionOrder(s.order, callingCq(s), s.saved, s.peerReplied) : QsoState.IDLE;
  return { state: s, log: out.log ?? null, stopped: out.stopped ?? false, reason: out.reason ?? '' };
}

// ===== 公開入口 =====

// 接收 slot 解碼完成。parity＝該 slot 的時序奇偶；messages＝[{ text, snr, freqHz }]（空陣列也要呼叫）
export function onDecoded(state, { parity, now, messages = [] }) {
  const s = structuredClone(state);
  const out = {};
  const msgs = parseAll(messages);
  // 交換證據：任何指名我、序列 1~5 的訊息（不受發射開關影響，doComplete 的防呆要查）
  for (const m of msgs) {
    const from = callsignFrom(m);
    const order = checkFunOrder(m);
    if (isMyCallsign(s.cfg.myCall, callsignTo(m)) && !isMyCallsign(s.cfg.myCall, from) && order >= 1 && order <= 5 && !s.evidence.includes(from)) {
      s.evidence.push(from);
    }
  }
  if (!s.active || parity === s.mySeq) return finalize(s, out); // 我方發射那半拍解不完整，不處理
  s.cooldownRetry = null;

  const respOrder = respOrderOf(s, msgs);
  const best = msgs.length > 0 ? scan(s, msgs, now) : null;

  if (msgs.length === 0) {
    if (s.order === 4 || s.order === 5) {
      s.awaitingReply = false; // 剛送完收尾，這輪安靜不算沒回應
      out.reason = t('qso.silentAfterSignoff');
      resetToCq(s, out, false);
      return finalize(s, out);
    }
    if (s.awaitingReply) {
      s.awaitingReply = false;
      s.noReplyCount += 1;
      if (s.cfg.noReplyLimit > 0 && s.noReplyCount >= s.cfg.noReplyLimit) {
        s.noReplyCount = 0;
        if (!callingCq(s)) {
          out.reason = t('qso.noReplyLimitCq', { call: s.target.call });
          giveUpTarget(s, now);
          resetToCq(s, out, false);
        }
      }
    }
    return finalize(s, out);
  }

  // 使用者剛手動介入（選訊息、按 CQ）：保護一個 slot，不讓自動判斷蓋掉
  if (s.forceOnceAt !== null) {
    const fresh = now - s.forceOnceAt <= s.cfg.slotMs;
    s.forceOnceAt = null;
    if (fresh) {
      out.reason = t('qso.userJustChose');
      return finalize(s, out);
    }
  }

  if (!s.target) {
    resetToCq(s, out, false);
    return finalize(s, out);
  }

  if (respOrder === -1 && s.awaitingReply) {
    s.awaitingReply = false;
    s.noReplyCount += 1;
    if (s.cfg.noReplyLimit > 0 && s.noReplyCount >= s.cfg.noReplyLimit && !callingCq(s)) {
      out.reason = t('qso.noReplyLimit', { call: s.target.call });
      giveUpTarget(s, now);
      s.noReplyCount = 0;
      if (finishSingleQso(s, out, t('qso.why.noReplyLimit'))) return finalize(s, out);
      setTarget(s, { call: 'CQ' }, s.order);
      resetTargetReport(s);
    }
  }

  if (callingCq(s)) {
    s.order = 6;
    onCallingCq(s, out, best, respOrder, now);
  } else if (respOrder !== -1) {
    onTargetReplied(s, out, respOrder, now);
  } else {
    onTargetSilent(s, out, now);
  }
  return finalize(s, out);
}

// 我方 slot 開始前（FT8TW doTransmit＋發射 runnable）：決定本輪實際要發的訊息，第 4／5 則第一次送出時記錄
export function beforeTransmit(state, now) {
  const s = structuredClone(state);
  const out = {};
  if (!s.active || !s.target) return { ...finalize(s, out), tx: null };
  if (s.order === 4 || s.order === 5) {
    if (!s.saved) {
      doComplete(s, out, now);
      s.finishTxSent = true;
      s.candidates = removeCandidate(s.candidates, s.target.call);
    } else if (s.finishRetrying) {
      s.finishRetrying = false;
    } else if (!s.finishTxSent) {
      s.finishTxSent = true; // 已在解碼時記錄（收到 RR73），收尾訊息本身還沒送
    } else {
      resetToCq(s, out, false); // 收尾已送過，不再重複
      if (!s.active) return { ...finalize(s, out), tx: null };
    }
  }
  if (s.order === 1 || s.order === 2 || s.startUtc === 0) s.startUtc = now;
  const messages = messagesFor(s);
  const msg = messages[s.order - 1];
  if ((s.order === 2 || s.order === 3) && msg.sentReport !== NO_REPORT) s.sentTargetReport = msg.sentReport;
  s.awaitingReply = true;
  const tx = { order: s.order, text: msg.text, to: s.target.call, parity: s.mySeq };
  return { ...finalize(s, out), tx };
}

// 目前對象的 6 則標準訊息（下拉選單用）；呼 CQ 時對象位置是 "CQ"
export function messagesFor(state) {
  const call = state.target ? state.target.call : 'CQ';
  return standardMessages({
    myCall: state.cfg.myCall, myGrid: state.cfg.myGrid, target: call, modifier: state.cfg.modifier, contest: state.cfg.contest,
    report: state.target ? state.target.snr : NO_REPORT, decodedSnr: state.sendReport,
  });
}

// 開始發射／按 CQ。parity＝我方要用的時序（通常 cqParity(now)）；發射中再按 CQ 會保護一個 slot
export function startCq(state, { parity, now }) {
  const s = structuredClone(state);
  const out = {};
  if (s.active) s.forceOnceAt = now;
  else {
    s.active = true;
    s.singleQso = false;
  }
  if (parity === 0 || parity === 1) s.mySeq = parity;
  resetToCq(s, out, true);
  return finalize(s, out);
}

// 從解碼清單直接呼叫：message＝{ text, snr, freqHz }，msgUtc／parity＝那則所在 slot 的起點與奇偶。
// 拒絕時 refusal 為 HASHED／MYSELF／NOT_STANDARD，state 不變。原本沒在發射 → 單次通聯
export function callTo(state, { message, msgUtc, parity, now }) {
  const m = { ...parseFt8Text(message.text), text: message.text, snr: message.snr ?? NO_REPORT, freqHz: message.freqHz ?? 0 };
  const refusal = directCallRefusal(m, state.cfg.myCall);
  if (refusal !== REFUSAL.NONE) return { state, refusal, log: null, stopped: false, reason: refusal, warning: null };
  const s = structuredClone(state);
  const out = {};
  const call = callsignFrom(m);
  if (!s.active) s.singleQso = true;
  s.active = true;
  const startOrder = forReplyTo(m, { myCall: s.cfg.myCall, now, msgUtc });
  resetTargetReport(s);
  resetReportRetry(s);
  s.noReplyCount = 0;
  s.awaitingReply = false;
  s.mySeq = (parity + 1) % 2;
  const grid = checkFun1(m.extraInfo) ? m.extraInfo : '';
  setTarget(s, { call, snr: isValidReport(m.snr) ? m.snr : NO_REPORT, freqHz: m.freqHz }, startOrder, grid);
  if (isMyCallsign(s.cfg.myCall, callsignTo(m))) {
    s.peerReplied = startOrder > 1;
    heardReport(s, reportOf(m));
  }
  // 從第 4／5 步開始而這台剛記錄過：只補送收尾，不再寫記錄（QsoStartOrder.resendOnly）
  s.saved = startOrder >= 4 && isInQsoCooldown(s.cooldown, call, s.cfg.band, now);
  s.finishRetrying = s.saved;
  const warning = bothNonstandard(s.cfg.myCall, call) ? t('qso.bothCompound') : null;
  return { ...finalize(s, out), refusal: REFUSAL.NONE, warning };
}

// 使用者在下拉選第 n 則：只保證本輪（保護一個 slot），之後回到流程自動決定
export function selectOrder(state, n, now) {
  if (!Number.isInteger(n) || n < 1 || n > 6) throw new RangeError(`訊息序號必須是 1~6：${n}`);
  const s = structuredClone(state);
  s.order = n;
  s.forceOnceAt = now;
  s.noReplyCount = 0;
  return finalize(s, {});
}

// 停止發射（使用者或發射監管逾時）
export function stop(state) {
  const s = structuredClone(state);
  s.active = false;
  s.singleQso = false;
  return finalize(s, { stopped: true, reason: t('qso.stopTx') });
}
