// 摩登電台卡的彙整（add-web-transmit 3.5、design D17）：解碼快照 → 「一台電台一列」。
// 移植自 FT8TW station/StationAggregator.java（純 Java）：時間窗、排序、篩選遮罩、強度格、標籤數。
// 與 Java 的差異（網頁沒有對應資料）：
//   - 「追蹤」（FILTER_TRACKED）：FT8TW 是 POTA 追蹤清單；網頁還沒有追蹤清單，改用設置裡的「關注呼號」。沒有灰卡。
//   - 「已通聯」：FT8TW 取訊息加入清單當下的快照；網頁直接查 QSO 記錄，目前呼叫的對象一律不算（同規則 2 的效果）。
//   - spot 交叉比對（第 67 節）沒有移植。
// rows：{ text, snr, freqHz, startUtc, mode }，最舊在前或任意順序皆可（同時間取後出現的）。
import { isMyCallsign } from '../qso/messages.mjs';
import { gridDistanceKm, gridToLatLng } from '../country/geo.mjs';
import { normalizeTarget, parseRow } from '../cards/rules.mjs';
import { sequenceOf } from '../tx/scheduler.mjs';
import { t } from '../i18n/index.mjs';

export const SORT = Object.freeze({ RECENT: 'recent', SNR: 'snr', DISTANCE: 'distance', CALL: 'call' }); // CALL：呼號字母（使用者 2026-10-07）

export const FILTER_CQ = 1;
export const FILTER_CALLING_ME = 1 << 1;
export const FILTER_NEW_DXCC = 1 << 2;
export const FILTER_NEW_ITU = 1 << 3;
export const FILTER_NEW_CQ_ZONE = 1 << 4;
export const LEGACY_FILTER_SLOT = 1 << 5; // 舊版留下的位元，讀設定時要清掉
export const FILTER_POTA_SOTA = 1 << 6;
export const FILTER_SLOT_0 = 1 << 7;
export const FILTER_SLOT_1 = 1 << 8;
export const FILTER_TRACKED = 1 << 9;

export const DEFAULT_WINDOW_MINUTES = 10;
export const WINDOW_CHOICES = Object.freeze([5, 10, 15, 30]);

// 篩選 chip（StationViewFragment.CHIP_MASKS／CHIP_LABELS 的順序）
export const CHIPS = Object.freeze([
  [0, t('station.chip.all')], [FILTER_TRACKED, t('station.chip.tracked')], [FILTER_CQ, 'CQ'], [FILTER_CALLING_ME, t('station.chip.callingMe')],
  [FILTER_NEW_DXCC, 'NEW DXCC'], [FILTER_NEW_ITU, 'NEW ITU'], [FILTER_NEW_CQ_ZONE, t('station.chip.newCqZone')],
  [FILTER_SLOT_0, 'Slot_0'], [FILTER_SLOT_1, 'Slot_1'],
  [FILTER_POTA_SOTA, 'SOTA/POTA'],
]);

export function normalizeWindowMinutes(minutes) {
  return WINDOW_CHOICES.includes(minutes) ? minutes : DEFAULT_WINDOW_MINUTES;
}

// 按下一個 chip 後的新遮罩：一般是 toggle（OR）；時序 0／1 互斥；「追蹤」與其他全部互斥；0（全部）清空
export function applyFilterToggle(mask, bit) {
  if (bit === 0) return 0;
  const turningOn = (mask & bit) === 0;
  let next = mask ^ bit;
  if (turningOn && bit === FILTER_SLOT_0) next &= ~FILTER_SLOT_1;
  if (turningOn && bit === FILTER_SLOT_1) next &= ~FILTER_SLOT_0;
  if (turningOn && bit === FILTER_TRACKED) return FILTER_TRACKED;
  if (turningOn) next &= ~FILTER_TRACKED;
  return next;
}

export function sanitizeMask(mask) {
  return (Number.isInteger(mask) ? mask : 0) & ~LEGACY_FILTER_SLOT;
}

// 強度格（1～5），只依 SNR；與解碼清單共用，定義在 signal.mjs
export { signalBars } from './signal.mjs';

function matchesFilter(r, mask) {
  if (mask === 0) return true;
  return Boolean(((mask & FILTER_CQ) && r.isCq)
    || ((mask & FILTER_CALLING_ME) && r.callingMe)
    || ((mask & FILTER_NEW_DXCC) && r.newDxcc)
    || ((mask & FILTER_NEW_ITU) && r.newItu)
    || ((mask & FILTER_NEW_CQ_ZONE) && r.newCqZone)
    || ((mask & FILTER_POTA_SOTA) && r.potaSota)
    || ((mask & FILTER_SLOT_0) && r.seq === 0)
    || ((mask & FILTER_SLOT_1) && r.seq === 1)
    || ((mask & FILTER_TRACKED) && r.tracked));
}

// chip 上的台數：要傳未篩選的那一份
export function count(rows, filterMask) {
  if (!rows) return 0;
  const mask = sanitizeMask(filterMask);
  if (mask === 0) return rows.length;
  return rows.filter((r) => matchesFilter(r, mask)).length;
}

const byRecent = (x, y) => (y.lastHeardUtcMs - x.lastHeardUtcMs) || (x.callsign < y.callsign ? -1 : x.callsign > y.callsign ? 1 : 0);

function comparator(sort) {
  if (sort === SORT.SNR) return (x, y) => (y.snr - x.snr) || byRecent(x, y);
  if (sort === SORT.CALL) return (x, y) => (x.callsign < y.callsign ? -1 : x.callsign > y.callsign ? 1 : byRecent(x, y));
  if (sort === SORT.DISTANCE) {
    return (x, y) => {
      const hx = x.distanceKm !== null;
      const hy = y.distanceKm !== null;
      if (hx !== hy) return hx ? -1 : 1; // 沒有距離的排最後
      if (hx && y.distanceKm !== x.distanceKm) return y.distanceKm - x.distanceKm; // 遠的在前（同 FT8TW）
      return byRecent(x, y);
    };
  }
  return byRecent;
}

// params：{ nowUtcMs, windowMinutes, myGrid, myCall, currentTarget, showWorked, sort, filterMask,
//           tracked: Set（關注呼號）, workedCalls: Set, newFlags(call) → { newDxcc, newItu, newCqZone } }
export function build(rows, params) {
  if (!rows || !params) return [];
  const p = params;
  const windowMs = normalizeWindowMinutes(p.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000;
  const target = normalizeTarget(p.currentTarget);
  const myOk = gridToLatLng(p.myGrid) !== null;
  const isMine = (c) => isMyCallsign(p.myCall ?? '', c);
  const byCall = new Map();
  rows.forEach((row, index) => {
    if (row.own) return;
    if (p.nowUtcMs - row.startUtc > windowMs) return;
    const m = parseRow(row.text);
    const from = m.from.trim().toUpperCase();
    if (m.free || !from || from.includes('...') || isMine(from)) return;
    let acc = byCall.get(from);
    if (!acc) byCall.set(from, (acc = { latest: null, parsed: null, index: -1, grid: null, gridTime: -Infinity, gridIndex: -1, potaSota: false }));
    if (!acc.latest || row.startUtc > acc.latest.startUtc || (row.startUtc === acc.latest.startUtc && index > acc.index)) {
      acc.latest = row;
      acc.parsed = m;
      acc.index = index;
    }
    if (m.grid && (row.startUtc > acc.gridTime || (row.startUtc === acc.gridTime && index > acc.gridIndex))) {
      acc.grid = m.grid;
      acc.gridTime = row.startUtc;
      acc.gridIndex = index;
    }
    acc.potaSota ||= m.ota;
  });

  const mask = sanitizeMask(p.filterMask ?? 0);
  const out = [];
  for (const [callsign, a] of byCall) {
    const worked = Boolean(p.workedCalls?.has(callsign)) && callsign !== target;
    if (p.showWorked === false && worked) continue;
    const to = a.parsed.to;
    const flags = p.newFlags?.(callsign) ?? {};
    let distanceKm = null;
    if (a.grid && myOk) distanceKm = gridDistanceKm(p.myGrid, a.grid) ?? 0;
    const r = {
      callsign,
      latest: a.latest,
      lastHeardUtcMs: a.latest.startUtc,
      grid: a.grid,
      distanceKm,
      snr: a.latest.snr,
      freqHz: a.latest.freqHz,
      isCq: a.parsed.cq,
      callingMe: to !== '' && isMine(to),
      newDxcc: Boolean(flags.newDxcc),
      newItu: Boolean(flags.newItu),
      newCqZone: Boolean(flags.newCqZone),
      worked,
      potaSota: a.potaSota,
      seq: sequenceOf(a.latest.startUtc, a.latest.mode),
      tracked: Boolean(p.tracked?.has(callsign)),
    };
    if (matchesFilter(r, mask)) out.push(r);
  }
  return out.sort(comparator(p.sort));
}

// ── 卡片顯示格式（StationFormat）──
export const FRESH_MS = 30_000;
export const STALE_MS = 5 * 60_000;
export const isFresh = (last, now) => now - last < FRESH_MS;
export const isStale = (last, now) => now - last > STALE_MS;
export const snrText = (snr) => (snr > 0 ? `+${snr}` : String(snr));
export const frequencyText = (hz) => `${Math.round(hz)} Hz`;
export const distanceText = (km) => (km === null || km === undefined ? null : `${km} km`);

// 標籤（順序固定：CQ → ★叫我 → NEW DXCC → NEW ITU → NEW CQ區 → ◎追蹤 → ✓已通）：[文字, 樣式]
export function tagsOf(r) {
  const tags = [];
  if (r.isCq) tags.push(['CQ', 'cq']);
  if (r.callingMe) tags.push([t('station.tag.callingMe'), 'me']);
  if (r.newDxcc) tags.push(['NEW DXCC', 'solid']);
  if (r.newItu) tags.push(['NEW ITU', 'outline']);
  if (r.newCqZone) tags.push([t('station.tag.newCqZone'), 'dashed']);
  if (r.tracked) tags.push([t('station.tag.tracked'), 'solid']);
  if (r.worked) tags.push([t('station.tag.worked'), 'worked']);
  return tags;
}
