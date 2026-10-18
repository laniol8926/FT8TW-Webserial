// 通聯流程用的訊息工具（add-web-transmit qso-automation、design D10）：移植自 FT8TW
//   GeneralVariables.checkFunOrder／checkFun1~5／hasNumericReport／checkIsMyCallsign、
//   Ft8Message.getCallsignTo／getCallsignFrom／checkIsCQ／getMessageText、
//   FT8TransmitSignal.getFunctionCommand／pickReportToSend／getReportFromExtraInfo／reportRetryLimit、
//   TransmitCallsign.formatReport、ReportResolver、NonstdCallsign、DirectCall.check。
// 逐筆比對 tools/qsogolden 產生的 webtest/fixtures/qso-golden.json。

export const NO_REPORT = -100; // ReportResolver.NO_REPORT：0 是合法的 0 dB，不可當成未設定
export const DEFAULT_UNKNOWN_REPORT = -15; // 沒量到對方訊號時發射用的中庸預設值（不進日誌）
export const MIN_REPORT = -30;
export const MAX_REPORT = 20;

const CQ_WORDS = new Set(['CQ', 'DE', 'QRZ']);
const MODIFIER = /^(?:[0-9]{3}|[A-Z]{1,4})$/; // Java matches() 是整串比對
const GRID4 = /^[A-Z][A-Z][0-9][0-9]$/; // checkFun1 的寫法（A–Z，不是 A–R）
const R_GRID = /^R ([A-R][A-R][0-9][0-9])$/; // GridExchange.R_GRID
const CALL_TOKEN = /^(?:<[^<>\s]+>|[A-Z0-9]+(?:\/[A-Z0-9]+){0,2})$/;
const EXTRA = /^(?:[A-R]{2}[0-9]{2}|R [A-R]{2}[0-9]{2}|R?[+-][0-9]{1,2}|RRR|RR73|73)$/;

// ===== 序列步驟辨識（GeneralVariables.checkFun*）=====

// Java Integer.parseInt：可帶一個 +／-，其餘全是數字
function parseJavaInt(s) {
  return /^[+-]?[0-9]+$/.test(s) ? Number.parseInt(s, 10) : null;
}

const inReportRange = (v) => (v >= -99 && v <= -1) || (v >= 0 && v <= 72);

export function isRGrid(extra) {
  return typeof extra === 'string' && R_GRID.test(extra.trim());
}

// 1：網格（或空白）
export function checkFun1(extra) {
  return (GRID4.test(extra.trim()) && extra !== 'RR73') || extra.trim().length === 0;
}

// 2：數字報告，如 -10
export function checkFun2(extra) {
  if (extra == null || extra.trim().length < 2) return false;
  const v = parseJavaInt(extra.trim());
  return v !== null && inReportRange(v);
}

// 3：R＋報告，或競賽的 R＋網格
export function checkFun3(extra) {
  if (isRGrid(extra)) return true;
  if (extra == null || extra.trim().length < 2) return false;
  const t = extra.trim();
  if (!(t[0] === 'R' || t[1] === 'R')) return false;
  const v = parseJavaInt(t.replace('R', '').trim()); // replaceFirst
  return v !== null && inReportRange(v);
}

export const checkFun4 = (extra) => extra.trim() === 'RR73' || extra.trim() === 'RRR';
export const checkFun5 = (extra) => extra.trim() === '73';

export function checkFunOrderByExtraInfo(extra) {
  if (checkFun5(extra)) return 5;
  if (checkFun4(extra)) return 4;
  if (checkFun3(extra)) return 3;
  if (checkFun2(extra)) return 2;
  if (checkFun1(extra)) return 1;
  return -1;
}

// 有數字報告（R＋網格沒有）
export function hasNumericReport(extra) {
  if (isRGrid(extra)) return false;
  return checkFun3(extra) || checkFun2(extra);
}

// FT8TransmitSignal.getReportFromExtraInfo：去掉所有 R 再解析，失敗 -100（只對 hasNumericReport 為真的用）
export function reportFromExtra(extra) {
  const v = parseJavaInt(extra.replaceAll('R', '').trim());
  return v === null ? NO_REPORT : v;
}

// ===== 訊息文字 ↔ 欄位（Ft8Message）=====

// 把解碼文字拆成 Ft8Message 的欄位：callsignTo（CQ 時含修飾詞，如 "CQ DX"）、callsignFrom、extraInfo。
// 認不出的（自由文字、遙測）回 { free: true }，等同 i3=0 n3=0。
export function parseFt8Text(text) {
  const tokens = String(text ?? '').trim().toUpperCase().split(/\s+/).filter(Boolean);
  const free = { free: true, callsignTo: '', callsignFrom: '', extraInfo: tokens.join(' ') };
  if (tokens.length < 2) return free;
  let to;
  let rest;
  if (CQ_WORDS.has(tokens[0])) {
    const hasModifier = tokens.length >= 3 && tokens[0] === 'CQ' && MODIFIER.test(tokens[1]);
    to = hasModifier ? `CQ ${tokens[1]}` : tokens[0];
    rest = tokens.slice(hasModifier ? 2 : 1);
  } else {
    to = tokens[0];
    rest = tokens.slice(1);
    if (!CALL_TOKEN.test(to)) return free;
  }
  const [from, ...more] = rest;
  const extra = more.join(' ');
  if (!from || !CALL_TOKEN.test(from) || (extra !== '' && !EXTRA.test(extra))) return free;
  return { free: false, callsignTo: to, callsignFrom: from, extraInfo: extra };
}

const stripBrackets = (s) => s.replaceAll('<', '').replaceAll('>', '');

// Ft8Message.getCallsignFrom：拿掉角括號（<...> 變成 "..."）
export function callsignFrom(msg) {
  return msg.callsignFrom == null ? '' : stripBrackets(msg.callsignFrom);
}

// Ft8Message.getCallsignTo：CQ／DE／QRZ 回空字串
export function callsignTo(msg) {
  const to = msg.callsignTo;
  if (to == null || to.length < 2) return '';
  if (to.startsWith('CQ') || to.startsWith('DE') || to.startsWith('QRZ')) return '';
  return stripBrackets(to);
}

export function isCq(msg) {
  return CQ_WORDS.has(String(msg.callsignTo ?? '').trim().split(' ')[0]);
}

// GeneralVariables.checkFunOrder：6＝CQ，-1＝認不出
export function checkFunOrder(msg) {
  if (msg == null || msg.free) return -1;
  if (isCq(msg)) return 6;
  if (msg.extraInfo == null) return -1;
  return checkFunOrderByExtraInfo(msg.extraInfo);
}

// ===== 呼號 =====

// GeneralVariables.checkIsMyCallsign：相同，或 我/後綴、前綴/我
export function isMyCallsign(myCall, call) {
  if (!myCall || myCall.length === 0 || call == null || call.trim().length === 0) return false;
  const my = myCall.trim().toUpperCase();
  const c = call.trim().toUpperCase();
  return c === my || c.startsWith(`${my}/`) || c.endsWith(`/${my}`);
}

const BASECALL = /^(?:[A-Z0-9]?[A-Z0-9][0-9][A-Z]{1,3}|3DA0[A-Z0-9]{1,3}|3X[A-Z][A-Z0-9]{1,4})$/;

// NonstdCallsign.isStandard：去掉 /P、/R 後能塞進 28 位元標準呼號
export function isStandardCallsign(call) {
  if (call == null) return false;
  let c = call.trim().toUpperCase();
  if (c.endsWith('/P') || c.endsWith('/R')) c = c.slice(0, -2);
  if (c.length > 7) return false;
  return BASECALL.test(c);
}

// NonstdCallsign.bothNonstandard：雙方都是複合呼號，對方多半只看到 <...>（照發，但要提醒）
export function bothNonstandard(myCall, toCall) {
  if (myCall == null || toCall == null) return false;
  const to = toCall.trim();
  if (to === '' || myCall.trim() === '') return false;
  if (to === 'CQ' || to.startsWith('CQ ')) return false;
  return !isStandardCallsign(myCall) && !isStandardCallsign(to);
}

// ===== 報告 =====

export const isValidReport = (r) => r >= MIN_REPORT && r <= MAX_REPORT;
export const clampReport = (r) => Math.min(MAX_REPORT, Math.max(MIN_REPORT, r));

// 送出的報告字串。刻意與 FT8TW 不同：FT8TW 是 "+5"、"0"，這裡照 WSJT-X 與解碼端寫成 "+05"、"+00"。
// "+5" 與 "+05" 打包結果相同；"0" 則不是合法報告（checkFun2 也不認），會讓訊息打包失敗。
export function formatReport(r) {
  const v = clampReport(r);
  return `${v < 0 ? '-' : '+'}${String(Math.abs(v)).padStart(2, '0')}`;
}

// FT8TransmitSignal.pickReportToSend：呼叫當下記的 SNR → 實際解碼到的 SNR → -15
export function pickReport(snr, decodedSnr) {
  if (isValidReport(snr)) return snr;
  if (isValidReport(decodedSnr)) return decodedSnr;
  return DEFAULT_UNKNOWN_REPORT;
}

// ReportResolver.resolve(3 參數)：rst_sent，最後回落到我方解碼 SNR（那就是我會送的值）
export function resolveSentReport(exchanged, history, decodedSnr) {
  if (exchanged !== NO_REPORT) return exchanged;
  if (history !== NO_REPORT) return history;
  return decodedSnr;
}

// ReportResolver.resolve(2 參數)：rst_rcvd，沒收到就是沒有，不捏造
export function resolveReceivedReport(exchanged, history) {
  return exchanged !== NO_REPORT ? exchanged : history;
}

export const hasReport = (r) => r !== NO_REPORT && r !== -120;
export const reportText = (r) => (hasReport(r) ? String(r) : '');

// FT8TransmitSignal.reportRetryLimit：對方連續送同一步的容忍輪數；finishRetryLimit≤0 時固定 4
export function reportRetryLimit(finishRetryLimit) {
  if (finishRetryLimit <= 0) return 4;
  return Math.max(finishRetryLimit * 2, finishRetryLimit + 1);
}

// ===== 6 則標準訊息（getFunctionCommand＋getMessageText）=====

export function isValidModifier(modifier) {
  return typeof modifier === 'string' && MODIFIER.test(modifier);
}

const grid4 = (grid) => (grid && grid.length > 4 ? grid.slice(0, 4) : grid ?? '');
const join = (...parts) => parts.join(' ').trim();

// 回傳 [{ order, text, sentReport }] 共 6 則；sentReport＝會進日誌的送出報告（回退預設值不算，NO_REPORT）。
// report：呼叫當下記的對方 SNR；decodedSnr：之後實際解碼到的 SNR；contest：第 2 步改送 "R <網格>"。
export function standardMessages({ myCall, myGrid = '', target, report = NO_REPORT, decodedSnr = NO_REPORT, modifier = null, contest = false }) {
  const me = myCall;
  const grid = grid4(myGrid);
  const real = isValidReport(report) || isValidReport(decodedSnr);
  const rpt = pickReport(report, decodedSnr);
  const sent = real ? rpt : NO_REPORT;
  const g = grid.trim().toUpperCase();
  const contestGrid = contest && /^[A-R]{2}[0-9]{2}$/.test(g) ? `R ${g}` : null; // GridExchange.formatRGrid
  const cq = isValidModifier(modifier) ? join('CQ', modifier, me, grid) : join('CQ', me, grid);
  return [
    { order: 1, text: join(target, me, grid), sentReport: NO_REPORT },
    contestGrid
      ? { order: 2, text: join(target, me, contestGrid), sentReport: NO_REPORT }
      : { order: 2, text: join(target, me, formatReport(rpt)), sentReport: sent },
    { order: 3, text: join(target, me, `R${formatReport(rpt)}`), sentReport: sent },
    { order: 4, text: join(target, me, 'RR73'), sentReport: NO_REPORT },
    { order: 5, text: join(target, me, '73'), sentReport: NO_REPORT },
    { order: 6, text: cq, sentReport: NO_REPORT },
  ];
}

// ===== 直接呼叫的拒絕條件（DirectCall.check）=====

export const REFUSAL = Object.freeze({ NONE: 'NONE', HASHED: 'HASHED', MYSELF: 'MYSELF', NOT_STANDARD: 'NOT_STANDARD' });

export function directCallRefusal(msg, myCall) {
  const from = msg ? callsignFrom(msg) : '';
  if (msg && msg.free) return REFUSAL.NOT_STANDARD;
  if (!from || from.includes('...')) return REFUSAL.HASHED;
  if (isMyCallsign(myCall, from)) return REFUSAL.MYSELF;
  return REFUSAL.NONE;
}
