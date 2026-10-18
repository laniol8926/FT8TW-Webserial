// 接收站設定的驗證與存取（receiver-settings spec）。存在 localStorage，只存呼號、網格、模式、各模式選的撥號頻率（波段由頻率推得）。
import { t } from './i18n/index.mjs';
import { isValidGrid, normalizeGrid } from './maidenhead.mjs';
import { bandOf } from './bands.mjs';
import { migrateFreqByMode } from './freqlist.mjs';

const SETTINGS_KEY = 'ft8tw.settings';
const RECEIVER_ID_KEY = 'ft8tw.receiverId';
const RECEIVER_ID = /^[0-9a-f]{32}$/;
export const MODES = Object.freeze(['FT8', 'FT4', 'JS8', 'FT2', 'JTTY']); // JTTY：串流聊天模式（add-web-jtty D15）
const DEFAULTS = { callsign: '', grid: '', band: '20m', mode: 'FT8', deviceId: '' };

// 推得的欄位（add-web-frequency-list D1）：dialHz＝目前模式選的撥號頻率、band＝它所在的波段
export function withDial(s) {
  const dialHz = s.freqByMode[s.mode];
  return { ...s, dialHz, band: bandOf(dialHz) ?? s.band ?? DEFAULTS.band };
}

function defaults() {
  return withDial({ ...DEFAULTS, freqByMode: migrateFreqByMode(DEFAULTS) });
}
// 與轉送站 relay/src/validate.js 的 CALLSIGN 相同：主體至少含一個數字與一個字母，允許一個前綴與一個後綴
const CALLSIGN = /^(?:[A-Z0-9]{1,8}\/)?(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,10}(?:\/[A-Z0-9]{1,8})?$/;

export function isValidCallsign(callsign) {
  return typeof callsign === 'string' && CALLSIGN.test(callsign);
}

// 呼號或網格留空可以存（照常解碼、不回報）；有填就要合格式
export function validateSettings({ callsign = '', grid = '' }) {
  const value = { callsign: callsign.trim().toUpperCase(), grid: grid.trim() ? normalizeGrid(grid) : '' };
  const errors = {};
  if (value.callsign && !isValidCallsign(value.callsign)) errors.callsign = t('page.settings.callsign_invalid');
  if (value.grid && !isValidGrid(value.grid)) errors.grid = t('page.settings.grid_invalid');
  return { ok: Object.keys(errors).length === 0, errors, value };
}

export function loadSettings(storage) {
  try {
    const saved = JSON.parse(storage.getItem(SETTINGS_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return defaults();
    // 逐欄判斷：一欄壞掉不連帶丟掉另一欄
    const { errors, value } = validateSettings({ callsign: String(saved.callsign ?? ''), grid: String(saved.grid ?? '') });
    const mode = MODES.includes(saved.mode) ? saved.mode : DEFAULTS.mode;
    // 舊設定只有 band：遷移成該波段該模式的標準頻率（D3）
    return withDial({
      callsign: errors.callsign ? '' : value.callsign,
      grid: errors.grid ? '' : value.grid,
      band: DEFAULTS.band,
      mode,
      deviceId: typeof saved.deviceId === 'string' ? saved.deviceId : DEFAULTS.deviceId,
      freqByMode: migrateFreqByMode({ ...saved, mode }),
    });
  } catch {
    return defaults();
  }
}

// 只挑允許的欄位存，經緯度之類的東西就算被傳進來也不會落地；band 是推得的，照存（舊版網頁讀得懂）
export function saveSettings(storage, { callsign = '', grid = '', band = DEFAULTS.band, mode = DEFAULTS.mode, deviceId = '', freqByMode = {} }) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ callsign, grid, band, mode, deviceId, freqByMode }));
    return true;
  } catch {
    return false;
  }
}

// 每個瀏覽器一個隨機的接收者 ID（spot-relay spec），即 PSKReporter 的 persistentIdentifier
export function getReceiverId(storage, crypto) {
  let saved = null;
  try {
    saved = storage.getItem(RECEIVER_ID_KEY);
  } catch {
    // localStorage 不可用：每次開網頁產生新的 ID
  }
  if (typeof saved === 'string' && RECEIVER_ID.test(saved)) return saved;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    storage.setItem(RECEIVER_ID_KEY, id);
  } catch {
    // 存不了也照常使用
  }
  return id;
}
