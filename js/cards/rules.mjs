// 解碼卡片與呼叫清單的規則（add-web-transmit 3.2、design D16），純函式。移植自 FT8TW：
//   CallingListAdapter.onBindViewHolder：欄位、底色、粗體、★、刪除線、Δt 粗體、時序分組外框、D／I／C
//   MainViewModel.findIncludedCallsigns：哪些訊息進呼叫清單
//   WorkedStationFilter：「不顯示已通聯站台」
// 網頁沒有 Ft8Message 的 i3／n3，以 qso/messages.mjs 的 parseFt8Text 判斷（認不出＝自由文字／遙測）。
// 「已通聯」直接查 QSO 記錄的呼號集合（FT8TW checkQSLCallsign），不做 FT8TW 的加入當下快照（workedWhenAdded）：
// 網頁每次重畫都即時查，目前呼叫的對象另外豁免，效果與快照＋規則 2 相同。
// 刪除線（cardModel 的 strike）另外分波段／模式（使用者 2026-10-19）：同一個呼號在沒通聯過的
// 頻段或模式上還是算新的——鍵的格式跟 reporter.mjs 回報去重的「呼號｜波段｜模式」一樣（D14）。
// 注意這跟 hiddenAsWorked（WorkedStationFilter，下面）是兩回事，那個仍然整支呼號查，不分波段
// 模式——維持 Android 版 checkQSLCallsign 原本的行為，只有刪除線這裡改。
import { callsignFrom, callsignTo, isCq, isMyCallsign, parseFt8Text } from '../qso/messages.mjs';
import { checkMaidenhead, gridDistanceKm } from '../country/geo.mjs';
import { SLOT_MS } from '../slot.mjs';
import { countryName } from '../country/db.mjs';
import { formatUtc, formatUtcTenths } from '../format.mjs';
import { bandOf } from '../bands.mjs';
import { t } from '../i18n/index.mjs';

const OTA = /^CQ\s+(SOTA|POTA|OTA)\b/;

// 時序（Ft8Message.getSequence）與一分鐘內的四格（getSequence4）；與發射的 sequenceOf 同一個算法（+50 ms 容差）
export function sequence4(startUtc, mode) {
  const slot = SLOT_MS[mode] ?? 15000;
  return Math.floor((startUtc + 50) / slot) % 4;
}

// 呼號或 CQ 等的正規化：大寫、去角括號
const norm = (s) => String(s ?? '').trim().toUpperCase();

// 解析一則：from、to（CQ 時空字串）、是否 CQ、自由文字、最後一段是否網格
export function parseRow(text) {
  const m = parseFt8Text(text);
  const tokens = String(text ?? '').trim().toUpperCase().split(/\s+/);
  const last = tokens[tokens.length - 1];
  return {
    free: m.free,
    from: m.free ? '' : callsignFrom(m),
    to: m.free ? '' : callsignTo(m),
    cq: !m.free && isCq(m),
    ota: OTA.test(String(text ?? '').trim().toUpperCase()),
    grid: !m.free && checkMaidenhead(last) ? last : null,
  };
}

// 目前呼叫的對象：CQ 或空的不算（WorkedStationFilter.normalizeTarget）
export function normalizeTarget(target) {
  const t = norm(target);
  return t === '' || t === 'CQ' ? null : t;
}

// 這則的「對方」：我發的看 to、叫我的看 from、第三方看 from（setQueryHolderQSL_Callsign）
export function otherCallsign(p, myCall) {
  if (isMyCallsign(myCall, p.from)) return p.to;
  if (isMyCallsign(myCall, p.to)) return p.from;
  return p.from;
}

// 底色類別（優先順序同 CallingListAdapter：叫我最後覆寫）：me > follow（含 CQ POTA／SOTA）> cq-qsl > cq > related > plain
export function toneOf({ callingMe, follow, cq, worked, related }) {
  if (callingMe) return 'me';
  if (follow) return 'follow';
  if (cq) return worked ? 'cq-qsl' : 'cq';
  if (related) return 'related';
  return 'plain';
}

// 分區標記（尚未通聯的 DXCC／ITU／CQ 區）；查不到國別回 null
export function zoneMarks(info, worked) {
  if (!info) return null;
  return {
    d: !worked.dxcc.has(info.dxcc),
    i: !worked.itu.has(info.itu),
    c: !worked.cq.has(info.cq),
  };
}

export const EMPTY_WORKED = Object.freeze({ calls: new Set(), byBandMode: new Set(), dxcc: new Set(), itu: new Set(), cq: new Set() });

// 「呼號｜波段｜模式」鍵，band／mode 缺的話用 '?'（分開計，不會跟真的波段/模式混在一起）
export const workedKey = (call, band, mode) => `${call}|${band ?? '?'}|${mode ?? '?'}`;

// QSO 記錄 → 已通聯的呼號、DXCC、ITU 區、CQ 區（GeneralVariables 的 QSL_Callsign_list、dxccMap、ituMap、cqMap）
// calls：整支呼號（給 hiddenAsWorked／Stations 分頁用，不分波段模式）
// byBandMode：呼號＋波段＋模式（給 cardModel 的刪除線用，同一呼號換頻段/模式要算新的）
export function workedSets(qsos, lookup = () => null) {
  const w = { calls: new Set(), byBandMode: new Set(), dxcc: new Set(), itu: new Set(), cq: new Set() };
  for (const q of qsos ?? []) {
    const call = norm(q.call);
    if (!call) continue;
    w.calls.add(call);
    w.byBandMode.add(workedKey(call, q.band, q.mode));
    const info = lookup(call);
    if (info) {
      w.dxcc.add(info.dxcc);
      w.itu.add(info.itu);
      w.cq.add(info.cq);
    }
  }
  return w;
}

const pad4 = (hz) => String(Math.round(hz)).padStart(4, '0');

// 清單只顯示目前模式的列（Codex 介面測試 2026-10-09：切到 FT4 後還列著 FT8 的電台）；mode 未知（null）不過濾
export function rowsForMode(rows, mode) {
  return mode ? rows.filter((r) => r.mode === mode) : rows;
}

// 一則解碼的卡片內容。row：{ text, snr, freqHz, timeSec, startUtc, mode, own? }（own＝我方發射）
// ctx：{ myCall, myGrid, follow: Set, worked, lookup(call), gridOf(call), dialHz }
export function cardModel(row, ctx) {
  const p = parseRow(row.text);
  const myCall = ctx.myCall ?? '';
  const fromIsMe = isMyCallsign(myCall, p.from);
  const toIsMe = isMyCallsign(myCall, p.to);
  const callingMe = toIsMe && !fromIsMe;
  const follow = (ctx.follow?.has(norm(p.from)) ?? false) || p.ota;
  const worked = ctx.worked ?? EMPTY_WORKED;
  const other = norm(otherCallsign(p, myCall));
  // 這則解碼實際的波段（CAT 連線時可能跟目前設定的波段不同，見 row.dialHz 的註解，main.mjs D14）
  const dial = row.dialHz ?? ctx.dialHz;
  const band = Number.isFinite(dial) ? bandOf(dial) : null;
  const strike = other !== '' && worked.byBandMode.has(workedKey(other, band, row.mode));
  const lookup = ctx.lookup ?? (() => null);
  const fromInfo = p.free || !p.from ? null : lookup(p.from);
  const toInfo = p.free || p.cq || !p.to || p.to.includes('...') ? null : lookup(p.to);
  const grid = p.grid ?? (p.from ? ctx.gridOf?.(norm(p.from)) ?? null : null);
  const km = grid ? gridDistanceKm(ctx.myGrid, grid) : null;
  const dt = Number(row.timeSec ?? 0);
  const stream = row.mode === 'JTTY'; // 非時槽模式：不顯示 DT，起點時間到 0.1 s（add-web-jtty jtty-chat）
  return {
    utcText: stream ? formatUtcTenths(row.startUtc) : formatUtc(row.startUtc),
    seq: sequence4(row.startUtc, row.mode) % 2,
    seq4: sequence4(row.startUtc, row.mode),
    snr: row.own ? '' : String(row.snr),
    dt: row.own || stream ? '' : dt.toFixed(1),
    dtBold: !row.own && !stream && (dt > 1.0 || dt < -0.05),
    hz: row.own ? 'TX' : pad4(row.freqHz),
    message: `${callingMe ? '★ ' : ''}${String(row.text ?? '').trim()}`,
    star: callingMe,
    bold: callingMe || follow,
    tone: toneOf({ callingMe, follow, cq: p.cq, worked: strike, related: fromIsMe || toIsMe }),
    strike,
    from: p.from,
    to: p.to,
    cq: p.cq,
    callingMe,
    own: Boolean(row.own),
    mine: Boolean(row.own) || fromIsMe, // 靠右（同 FT8TW isMine：發送方是我），其餘靠左
    fromCountry: countryName(fromInfo),
    toCountry: countryName(toInfo),
    fromFlag: fromInfo?.flagUrl ?? null,
    toFlag: toInfo?.flagUrl ?? null,
    fromMarks: row.own ? null : zoneMarks(fromInfo, worked),
    toMarks: row.own ? null : zoneMarks(toInfo, worked),
    km,
    grid,
  };
}

// ── 呼叫清單（呼叫頁中段）──

// 收錄條件（findIncludedCallsigns）：我發的、叫我的、關注呼號發的或被叫的、CQ；網頁另加「目前對象」的往來。
// 排除的呼號前綴（checkIsExcludeCallsign）只看發話方。
export function inCallList(row, ctx) {
  const p = parseRow(row.text);
  if (row.own) return true;
  if (p.free) return false;
  const myCall = ctx.myCall ?? '';
  const target = normalizeTarget(ctx.target);
  const from = norm(p.from);
  const to = norm(p.to);
  const include = isMyCallsign(myCall, from) || isMyCallsign(myCall, to)
    || ctx.follow?.has(from) || (to !== '' && ctx.follow?.has(to)) || p.cq
    || (target !== null && (from === target || to === target));
  if (!include) return false;
  return !(ctx.excluded ?? []).some((pre) => pre && from.startsWith(pre));
}

// 「不顯示已通聯站台」（WorkedStationFilter.isHidden）：我方發的、目前對象的往來一律顯示
export function hiddenAsWorked(row, ctx) {
  if (ctx.showWorked !== false) return false;
  const p = parseRow(row.text);
  const myCall = ctx.myCall ?? '';
  if (row.own || isMyCallsign(myCall, p.from)) return false;
  const other = norm(otherCallsign(p, myCall));
  const target = normalizeTarget(ctx.target);
  if (target !== null && other === target) return false;
  return (ctx.worked ?? EMPTY_WORKED).calls.has(other);
}

// 解碼清單與呼叫清單共用的類別篩選（使用者 2026-10-09：「讓地圖顯示得比較清爽」）；呼叫清單另有「目前對象」
export const LIST_FILTERS = Object.freeze([
  ['all', t('cards.filter.all')], ['follow', t('cards.filter.follow')], ['cq', 'CQ'], ['me', t('cards.filter.me')],
  ['newdxcc', 'NEW DXCC'],
]);
export const CALL_FILTERS = Object.freeze([...LIST_FILTERS, ['target', t('cards.filter.target')]]);

// 時間篩選（分鐘，0＝全部）：以列的 startUtc 對目前 UTC，超過的列隱藏（不刪）
export const TIME_FILTERS = Object.freeze([0, 5, 10, 15, 30]);
export function withinMinutes(row, minutes, nowUtc) {
  if (!minutes) return true;
  return nowUtc - Number(row.startUtc) <= minutes * 60_000;
}

// 發話方的 DXCC 尚未通聯過（同 cardModel 的 D 標記）；我方發的、國別資料庫未載入（查不到）都不算
function fromNewDxcc(row, p, ctx) {
  if (row.own || p.free || !p.from || isMyCallsign(ctx.myCall ?? '', p.from)) return false;
  const info = (ctx.lookup ?? (() => null))(p.from);
  return Boolean(info) && !(ctx.worked ?? EMPTY_WORKED).dxcc.has(info.dxcc);
}

// 篩選切換：all／follow（發話方在追蹤清單，含 CQ POTA／SOTA，同 cardModel）／cq／me（叫我）／newdxcc／target（目前對象的往來，含我發給他的）
export function matchesCallFilter(row, filter, ctx) {
  if (filter === 'all' || !filter) return true;
  const p = parseRow(row.text);
  const myCall = ctx.myCall ?? '';
  if (filter === 'follow') return (ctx.follow?.has(norm(p.from)) ?? false) || p.ota;
  if (filter === 'cq') return p.cq;
  if (filter === 'me') return isMyCallsign(myCall, p.to) && !isMyCallsign(myCall, p.from);
  if (filter === 'newdxcc') return fromNewDxcc(row, p, ctx);
  if (filter === 'target') {
    const target = normalizeTarget(ctx.target);
    return target !== null && (norm(p.from) === target || norm(p.to) === target);
  }
  return true;
}

// 有沒有在篩選（計數要不要顯示「顯示中／總數」）
export function filterActive({ filter = 'all', minutes = 0 } = {}) {
  return filter !== 'all' || minutes > 0;
}

// 類別＋時間都符合才顯示
export function matchesListFilter(row, { filter = 'all', minutes = 0, nowUtc = 0 } = {}, ctx = {}) {
  return withinMinutes(row, minutes, nowUtc) && matchesCallFilter(row, filter, ctx);
}

// 篩選按鈕後面的筆數（使用者 2026-10-10，同 FT8TW 電台卡的「CQ 12」）：時間範圍內各類別各自算，與目前選哪一個無關
// kinds：LIST_FILTERS／CALL_FILTERS；回傳 { all: n, cq: n, … }
export function filterCounts(rows, kinds, { minutes = 0, nowUtc = 0 } = {}, ctx = {}) {
  const inTime = rows.filter((r) => withinMinutes(r, minutes, nowUtc));
  const out = {};
  for (const [key] of kinds) out[key] = key === 'all' ? inTime.length : inTime.filter((r) => matchesCallFilter(r, key, ctx)).length;
  return out;
}

// 解碼清單一列是否隱藏：模式不符，或（篩選只在 FT8／FT4／FT2 套用）不符篩選
export function decodeHidden({ rowMode, appMode, visible = true }) {
  return (rowMode ?? appMode) !== appMode || !visible;
}

// time：{ minutes, nowUtc }（不給＝不限時間）
export function callListRows(rows, filter, ctx, time = {}) {
  return rows.filter((r) => inCallList(r, ctx) && !hiddenAsWorked(r, ctx) && matchesListFilter(r, { filter, ...time }, ctx));
}
