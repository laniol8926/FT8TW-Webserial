// JS8 通訊畫面的輸入組字（design D13、D14）。純函式，不碰 DOM；i18n 只回 key，由畫面端 t()。
// 以 FT8TW App 為準：Js8Fragment.prependSelectedCall／applyQuickMessage／updateFramePreview、
// Js8AprsMessage.build、Js8PositionSource（網格取捨）。
import { buildJs8Frames } from '../js8/encode.mjs';
import { formatSnr } from './quickreply.mjs';

/** 各速度的 slot 秒數（design D2：NOR 15、FST 10、TUR 6、SLO 30、FTW 4） */
export const SLOT_SECONDS = Object.freeze({ 0: 15, 1: 10, 2: 6, 4: 30, 8: 4 });

/** 快速選單 9 項的 id（順序同 App showQuickMessageMenu） */
export const QUICK_IDS = Object.freeze([
  'cq', 'snrQuery', 'infoQuery', 'statusQuery', 'replySnr', 'replyInfo', 'replyStatus', 'position', 'aprsMessage',
]);

const NO_PREPEND = ['CQ', 'HB', 'HEARTBEAT', '@', '`'];
const norm = (s) => (s == null ? '' : String(s).trim().toUpperCase());
const blank = (s) => s == null || String(s).trim() === '';

/**
 * 選定某台時，訊息開頭不是該台呼號、也不以 CQ／HB／HEARTBEAT／@／` 開頭，就在前面補上該台呼號
 * （對照 JS8Call AUTO_PREPEND_DIRECTED）。結果去頭尾空白；內文保留原大小寫。
 * 照 App：比對用 startsWith、不看字界（選 BU2BB 時 "BU2BBX HI" 視為已有呼號）。
 * @param {string} text 輸入框內容；空白或 null 原樣回傳
 * @param {string|null} [selectedCall] 選定的台；沒選為 null／空字串
 * @returns {string}
 */
export function prependSelectedCall(text, selectedCall) {
  if (text == null) return text;
  const trimmed = String(text).trim();
  if (trimmed === '') return text;
  const call = norm(selectedCall);
  if (call === '') return trimmed;
  const upper = trimmed.toUpperCase();
  if (upper.startsWith(call) || NO_PREPEND.some((p) => upper.startsWith(p))) return trimmed;
  return `${call} ${trimmed}`;
}

const GRID4 = /^[A-R]{2}[0-9]{2}$/;
const GRID6 = /^[A-R]{2}[0-9]{2}[A-X]{2}$/;

// Js8PositionSource 的設定網格分支（網頁沒有 GPS）：取前 6 碼合法 → 6 碼；恰好 4 碼合法（非 RR73）→ 4 碼＋coarse；
// 5 碼或後兩碼不合法的不降級成 4 碼（多半是打錯字，悄悄砍掉會把錯字藏起來）
function positionGrid(grid) {
  const g = norm(grid);
  if (g.length >= 6 && GRID6.test(g.slice(0, 6))) return { grid: g.slice(0, 6), coarse: false };
  if (g.length === 4 && g !== 'RR73' && GRID4.test(g)) return { grid: g, coarse: true };
  return null;
}

/**
 * 快速選單 9 項（design D14；App Js8Fragment.applyQuickMessage）。選了只填入輸入框，不直接發射。
 *
 * @param {object} [ctx]
 * @param {string} [ctx.myCall] 我的呼號（目前未用到，保留給畫面端一起傳）
 * @param {string} [ctx.myGrid] 我的網格（CQ 取 4 碼；送出位置要 6 碼，恰好 4 碼時標 coarse）
 * @param {string|null} [ctx.selectedCall] 上方選定的台
 * @param {{ snr: number }|null} [ctx.lastRx] 選定台最近一則收到的訊息（回 SNR 用）
 * @param {string} [ctx.infoText] 設定好的 INFO 內容（回 INFO 用）
 * @param {string} [ctx.statusText] 設定好的 STATUS 內容（回 STATUS 用）
 * @returns {{ id: string, labelKey: string, text: string|null, disabled: boolean, reasonKey: string|null,
 *   coarse?: boolean, needsInput?: boolean }[]}
 *   disabled 時 text 為 null、reasonKey 是要顯示的原因；position 的 coarse=true 表示只有 4 碼（UI 要提示範圍）；
 *   aprsMessage 的 needsInput=true：先問收件人與內文，再用 aprsCmd() 組字
 */
export function quickMenu({ myGrid, selectedCall, lastRx, infoText, statusText } = {}) {
  const call = norm(selectedCall);
  const item = (id, text, reasonKey = null, extra = {}) => ({
    id, labelKey: `js8chat.quick.${id}`, text: reasonKey ? null : text, disabled: reasonKey !== null, reasonKey, ...extra,
  });
  const NEED_CALL = 'js8chat.quick.selectStationFirst';
  const directed = (id, cmd) => item(id, `${call} ${cmd}`, call ? null : NEED_CALL);
  const fixed = (id, keyword, content, emptyKey) => {
    if (!call) return item(id, null, NEED_CALL);
    if (blank(content)) return item(id, null, emptyKey);
    return item(id, `${call} ${keyword} ${norm(content)}`);
  };

  const snrOk = lastRx != null && lastRx.snr != null && Number.isFinite(Number(lastRx.snr));
  let replySnr;
  if (!call) replySnr = item('replySnr', null, NEED_CALL);
  else if (!snrOk) replySnr = item('replySnr', null, 'js8chat.quick.noSnrHeard');
  else replySnr = item('replySnr', `${call} SNR ${formatSnr(lastRx.snr)}`);

  const pos = positionGrid(myGrid);
  const position = pos
    ? item('position', `@APRSIS GRID ${pos.grid}`, null, { coarse: pos.coarse })
    : item('position', null, 'js8chat.quick.noGrid', { coarse: false });

  return [
    item('cq', `CQ CQ CQ ${norm(myGrid).slice(0, 4)}`.trim()),
    directed('snrQuery', 'SNR?'),
    directed('infoQuery', 'INFO?'),
    directed('statusQuery', 'STATUS?'),
    replySnr,
    fixed('replyInfo', 'INFO', infoText, 'js8chat.quick.noInfoSet'),
    fixed('replyStatus', 'STATUS', statusText, 'js8chat.quick.noStatusSet'),
    position,
    item('aprsMessage', null, null, { needsInput: true }),
  ];
}

/** APRS 訊息內文上限（APRS 1.0.1 第 14 章） */
export const APRS_MAX_TEXT = 67;
const APRS_ADDRESSEE_WIDTH = 9;
const APRS_ADDRESSEE = /^[A-Z0-9-]{1,9}$/;
const APRS_ALLOWED_PUNCT = ' .-+?!/';

/**
 * 「發 APRS 訊息」：組成 `@APRSIS CMD :<收件人補空白至 9 字元>:<內文>`（移植 Js8AprsMessage.build）。
 * 不加訊息編號 {NN}（只有 JS8→APRS-IS 單向，ack 回不來）。
 * 不管強化編碼開不開，一律轉大寫走 legacy：UTX 訊息所有 iGate（含 FT8TW 自己的 igate.mjs）都不轉。
 * 內文只收英數、空白與 . - + ? ! /（中文等非 ASCII 也是 BAD_CHAR）。
 *
 * @param {string} to 收件人（1～9 字元 [A-Z0-9-]，不分大小寫）
 * @param {string} text 內文
 * @returns {{ text: string|null, error: null|'BAD_ADDRESSEE'|'EMPTY_TEXT'|'TOO_LONG'|'BAD_CHAR', badChar: string|null }}
 */
export function aprsCmd(to, text) {
  const fail = (error, badChar = null) => ({ text: null, error, badChar });
  const addr = norm(to);
  if (!APRS_ADDRESSEE.test(addr)) return fail('BAD_ADDRESSEE');
  const body = text == null ? '' : String(text).trim().toUpperCase();
  if (body === '') return fail('EMPTY_TEXT');
  if (body.length > APRS_MAX_TEXT) return fail('TOO_LONG');
  for (const ch of body) {
    const ok = (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || APRS_ALLOWED_PUNCT.includes(ch);
    if (!ok) return fail('BAD_CHAR', ch);
  }
  return { text: `@APRSIS CMD :${addr.padEnd(APRS_ADDRESSEE_WIDTH, ' ')}:${body}`, error: null, badChar: null };
}

/**
 * 狀態列「n frame／n 秒」預覽（App updateFramePreview）：照輸入原文拆 frame（不自動補呼號，同 App；
 * 要預覽補呼號後的結果請先自行 prependSelectedCall）。網格只用前 4 碼（同 App）。
 * 字表未載入等例外也收成 { error }，因為每次按鍵都會呼叫。
 *
 * @param {string} text
 * @param {{ mycall?: string, mygrid?: string, submode?: number, forceUtx?: boolean }} [opts]
 * @returns {{ frames: number, seconds: number, utx: boolean } | { error: string }} utx：真的有 UTX frame（泡泡標 FT8TW 用）
 */
export function previewFrames(text, { mycall = '', mygrid = '', submode = 0, forceUtx = false } = {}) {
  const slot = SLOT_SECONDS[submode];
  if (slot === undefined) return { error: 'unknown submode' };
  let r;
  try {
    r = buildJs8Frames(text ?? '', { mycall, mygrid: norm(mygrid).slice(0, 4), submode, forceUtx });
  } catch (e) {
    return { error: e.message };
  }
  if (r.error) return { error: r.error };
  if (r.frames.length === 0) return { error: 'nothing packable in message' };
  return { frames: r.frames.length, seconds: r.frames.length * slot, utx: r.utx };
}
