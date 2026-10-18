// 頻率清單（add-web-frequency-list）：每個模式的頻率表（內建＝FT8TW App assets，可自訂）、選項排序分組、編輯驗證、
// 舊設定遷移、切換模式帶入、刪除後回退。純函式，DOM 在 freq-ui.mjs。
// 頻率表存在 ft8tw.bands（全域，不隨設定組）：{ v: 1, tables: { FT8?: [{ hz, marked }], … } }，只存被編輯過的模式（同 App 的覆寫檔）。
import { BANDS, bandOf, dialFor } from './bands.mjs';
import { DEFAULT_TABLES } from './bands-data.mjs';

// APP_FREQ_MODES：內建表由 tools/gen-bands.mjs 從 FT8TW App assets 產生（bands-data.mjs）；
// JTTY（add-web-jtty D15）App 沒有，內建表寫在下面 EXTRA_TABLES
export const APP_FREQ_MODES = Object.freeze(['FT8', 'FT4', 'FT2', 'JS8']);
export const FREQ_MODES = Object.freeze([...APP_FREQ_MODES, 'JTTY']);
// JTTY 建議頻率：20m 14.090 MHz（來源 DXZone，記於 openspec/changes/add-web-jtty/provenance.md）。
// TODO 其他波段依 DXZone 頻率表補，來源記 provenance
export const EXTRA_TABLES = Object.freeze({
  JTTY: Object.freeze([Object.freeze({ hz: 14_090_000, marked: true })]),
});
export const BANDS_KEY = 'ft8tw.bands';
const BAND_ORDER = BANDS.map((b) => b.band);
const byHz = (a, b) => a.hz - b.hz;
const validHz = (hz) => Number.isInteger(hz) && hz > 0 && bandOf(hz) !== null;

// 14.074、7.0475、14.074501：至少 3 位小數，多的去掉尾零
export function formatMHz(hz) {
  return (hz / 1e6).toFixed(6).replace(/(\.\d{3}\d*?)0+$/, '$1');
}

// 選項文字（收合的 <select> 只顯示選中的這一行，所以每個選項都帶波段）
export function optionText({ hz, marked }) {
  return `${bandOf(hz)} ${formatMHz(hz)}${marked ? ' ★' : ''}`;
}

export function defaultTable(mode) {
  return (DEFAULT_TABLES[mode] ?? EXTRA_TABLES[mode] ?? []).map((e) => ({ hz: e.hz, marked: e.marked }));
}

// 一個模式的清單：去掉不合格、重複的項目；空的回 null（當成沒編輯過）
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !validHz(e.hz) || out.some((x) => x.hz === e.hz)) continue;
    out.push({ hz: e.hz, marked: e.marked === true });
  }
  return out.length ? out.sort(byHz) : null;
}

// 被編輯過的模式：{ FT8?: [...], … }
export function loadTables(storage) {
  try {
    const saved = JSON.parse(storage.getItem(BANDS_KEY) ?? 'null');
    const tables = saved?.tables;
    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) return {};
    const out = {};
    for (const m of FREQ_MODES) {
      const list = cleanList(tables[m]);
      if (list) out[m] = list;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveTables(storage, overrides) {
  try {
    storage.setItem(BANDS_KEY, JSON.stringify({ v: 1, tables: overrides }));
    return true;
  } catch {
    return false;
  }
}

// 頻率表編輯存檔（code review 2026-10-09）：先重新讀 storage 再改這個模式，別的分頁對其他模式的修改不被這個分頁的舊表蓋掉。
// list＝該模式的完整清單；null＝恢復預設。回傳存檔後的頻率表
export function applyTableEdit(storage, mode, list) {
  const next = loadTables(storage);
  if (list) next[mode] = list.map((e) => ({ hz: e.hz, marked: e.marked }));
  else delete next[mode];
  saveTables(storage, next);
  return next;
}

export function tableFor(overrides, mode) {
  return overrides[mode] ? overrides[mode].map((e) => ({ ...e })) : defaultTable(mode);
}

// 依波段順序分組；組內常用在前，同類依頻率
export function groupTable(list) {
  const groups = new Map();
  for (const e of list) {
    const band = bandOf(e.hz);
    if (!groups.has(band)) groups.set(band, []);
    groups.get(band).push(e);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b))
    .map(([band, items]) => ({ band, items: items.sort((a, b) => Number(b.marked) - Number(a.marked) || a.hz - b.hz) }));
}

// 使用者輸入的 MHz（同 App 頻率表編輯）→ Hz 整數；最多 6 位小數
export function parseMHz(text) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  if (!m) return null;
  const hz = Number(m[1]) * 1e6 + Number((m[2] ?? '').padEnd(6, '0'));
  return hz > 0 ? hz : null;
}

// replacingHz：修改哪一筆（不跟自己比重複）；error：format／outOfBand／duplicate
export function validateEntry(list, text, replacingHz = null) {
  const hz = parseMHz(text);
  let error = null;
  if (hz === null) error = 'format';
  else if (!bandOf(hz)) error = 'outOfBand';
  else if (hz !== replacingHz && list.some((e) => e.hz === hz)) error = 'duplicate';
  return { ok: !error, hz: error ? null : hz, error };
}

export function upsertEntry(list, entry, replacingHz = null) {
  return [...list.filter((e) => e.hz !== replacingHz && e.hz !== entry.hz), { hz: entry.hz, marked: Boolean(entry.marked) }].sort(byHz);
}

// 最後一筆不能刪（選單不能是空的）
export function removeEntry(list, hz) {
  if (list.length <= 1) return list;
  return list.filter((e) => e.hz !== hz);
}

export function setMarked(list, hz, marked) {
  return list.map((e) => (e.hz === hz ? { ...e, marked: Boolean(marked) } : e));
}

// 同波段的常用頻率：該模式的標準頻率（在清單裡）→ 常用中最低的 → 同波段任一 → null
export function commonFor(list, band, mode = null) {
  if (!band) return null;
  const inBand = list.filter((e) => bandOf(e.hz) === band).sort(byHz);
  const std = mode ? dialFor(band, mode) : null;
  return inBand.find((e) => e.hz === std)?.hz ?? inBand.find((e) => e.marked)?.hz ?? inBand[0]?.hz ?? null;
}

// 後備：同波段 → 該模式 20m 標準（在清單裡）→ 清單第一個常用 → 第一個 → 20m 標準
export function fallbackFreq(list, mode, band) {
  const sorted = [...list].sort(byHz);
  const std20 = dialFor('20m', mode);
  return commonFor(sorted, band, mode)
    ?? sorted.find((e) => e.hz === std20)?.hz
    ?? sorted.find((e) => e.marked)?.hz
    ?? sorted[0]?.hz
    ?? std20;
}

// 修改了某模式目前選的那一筆（replacingHz → newHz）：選擇跟著改到新值（否則會被當成刪掉、跳到同波段常用）
export function remapSelected(freqByMode, mode, replacingHz, newHz) {
  if (replacingHz === null || replacingHz === undefined || freqByMode?.[mode] !== replacingHz) return { ...freqByMode };
  return { ...freqByMode, [mode]: newHz };
}

// 選的頻率不在清單（被刪掉、別的設定組選的）→ 同波段常用
export function resolveSelected(list, hz, mode) {
  if (hz && list.some((e) => e.hz === hz)) return hz;
  return fallbackFreq(list, mode, hz ? bandOf(hz) : null);
}

// 切換到 mode：上次選的（在清單裡）→ 目前頻率所在波段的常用
export function pickForMode(freqByMode, mode, list, currentHz) {
  const last = freqByMode?.[mode];
  if (last && list.some((e) => e.hz === last)) return last;
  return fallbackFreq(list, mode, currentHz ? bandOf(currentHz) : null);
}

export function sanitizeFreqByMode(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return Object.fromEntries(FREQ_MODES.filter((m) => validHz(obj[m])).map((m) => [m, obj[m]]));
}

// 舊設定（只有 band）→ 目前模式在該波段的標準頻率；沒有標準頻率 → 內建清單同波段常用 → 20m 標準
export function migrateFreqByMode(saved) {
  const mode = FREQ_MODES.includes(saved?.mode) ? saved.mode : 'FT8';
  const out = sanitizeFreqByMode(saved?.freqByMode);
  if (!out[mode]) out[mode] = dialFor(saved?.band, mode) ?? fallbackFreq(defaultTable(mode), mode, saved?.band ?? null);
  return out;
}
