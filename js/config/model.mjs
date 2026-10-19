// 設定模型（station-settings spec、design D19）：彙整所有設定的 key、預設值、驗證與版本遷移。純函式，不碰 DOM。
//
// 儲存位置（localStorage）：
//   ft8tw.settings          呼號、網格、波段、模式、音訊輸入（settings.mjs，接收站版本就有）
//   ft8tw.tx                發射聲音頻率、時序、輸出裝置、音量（tx/prefs.mjs）
//   ft8tw.autostart         開網頁自動開始接收（autostart.mjs）
//   ft8tw.swlRetentionDays  SWL Log 保留期限（retention.mjs）
//   ft8tw.config            本檔新增的項目（CQ 對象、自動通聯、回報開關、顯示），帶版本號 v
//   ft8tw.rig               電台控制：控制方式、機型、序列埠參數、CI-V、PTT 延遲、授權過的埠（rig/prefs.mjs，add-web-rig-control）
// 舊 key 沿用原本的格式與載入函式，不搬資料：接收站版本升上來的使用者設定不會遺失。
import { loadSettings } from '../settings.mjs';
import { loadTxPrefs } from '../tx/prefs.mjs';
import { loadAutoStart } from '../autostart.mjs';
import { loadRetention } from '../retention.mjs';
import { loadRigPrefs, RIG_KEY } from '../rig/prefs.mjs';
import { LANGUAGE_CHOICES } from '../i18n/core.mjs';
import { t } from '../i18n/index.mjs';
import { DEFAULT_TILE_SOURCE, TILE_SOURCE_IDS, validateTileAttribution, validateTileTemplate } from '../map/tilesource.mjs';

export const CONFIG_KEY = 'ft8tw.config';
export const CONFIG_VERSION = 1;
export const STORAGE_KEYS = Object.freeze({
  settings: 'ft8tw.settings',
  tx: 'ft8tw.tx',
  autostart: 'ft8tw.autostart',
  retention: 'ft8tw.swlRetentionDays',
  config: CONFIG_KEY,
  rig: RIG_KEY,
  profiles: 'ft8tw.profiles', // 設定組（add-web-profiles P10）
  bands: 'ft8tw.bands', // 頻率表（add-web-frequency-list D6）：全域，不隨設定組
});

// 排除已通聯（FT8TW qsoFilterOpt）：儲存值 0 所有、1 一小時、2 四小時、3 八小時、4 今天、5 30 天、6 365 天、7 關閉。
// 下拉的順序同 FT8TW CqFilterSpinnerAdapter：關閉擺第一個
export const QSO_FILTER_OPTIONS = Object.freeze([7, 0, 1, 2, 3, 4, 5, 6].map((v) => [v, t(`config.qsoFilter.${v}`)]));
// 發射監管（分鐘，FT8TW LaunchSupervisionSpinnerAdapter）：0＝忽略，其餘 5、15、25…95
export const SUPERVISION_OPTIONS = Object.freeze([0, ...Array.from({ length: 10 }, (_, i) => (i + 1) * 10 - 5)]);
export const NO_REPLY_OPTIONS = Object.freeze(Array.from({ length: 31 }, (_, i) => i)); // 0＝忽略
export const FINISH_RETRY_OPTIONS = Object.freeze([0, 1, 2, 3]); // FinishRetrySpinnerAdapter.MAX_RETRY＝3；0＝關閉
export const THEMES = Object.freeze(['auto', 'light', 'dark']);
// 時間偏移（ms，FT8TW 時間偏移）：修正電腦時鐘，加在自動校時結果上，收發都用。−2.0～+2.0 秒、每 0.1 秒
export const TIME_OFFSET_LIMIT_MS = 2000;
export const TIME_OFFSET_OPTIONS = Object.freeze(Array.from({ length: 41 }, (_, i) => (i - 20) * 100));
// 收訊音訊延遲（ms，add-dt-offset-advisor D14）：音訊比空中晚到多少（WebSDR、喇叭→麥克風），只影響接收。
// −2.0～+2.0 秒每 0.1 秒、+2.5～+10.0 秒每 0.5 秒（D10）。負值（音訊比空中早到）實際上不會大，只到 −2 秒
export const RX_DELAY_LIMIT_MS = 10000; // 正向上限
export const RX_DELAY_MIN_MS = -TIME_OFFSET_LIMIT_MS; // 負向下限
const WIDE_DELAYS = Array.from({ length: 16 }, (_, i) => 2500 + i * 500);
export const RX_DELAY_OPTIONS = Object.freeze([...TIME_OFFSET_OPTIONS, ...WIDE_DELAYS]);

// 最接近 ms 的合法收訊音訊延遲（超出範圍即夾在 −2～+10 秒；等距取絕對值小的；不回傳 −0；非數字當 0）
export function nearestRxDelay(ms) {
  const v = Number.isFinite(ms) ? ms : 0;
  let best = 0;
  for (const o of RX_DELAY_OPTIONS) {
    const d = Math.abs(o - v) - Math.abs(best - v);
    if (d < 0 || (d === 0 && Math.abs(o) < Math.abs(best))) best = o;
  }
  return best;
}

const msNumber = (v) => (typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v);
// 列表字型大小（px，使用者 2026-10-06：網頁版改成 8–26 px）。舊版存的 s/m/l/xl 換成最接近的 px
export const FONT_SIZES = Object.freeze([8, 10, 12, 14, 16, 18, 20, 22, 24, 26]);
const LEGACY_FONT_SIZES = Object.freeze({ s: 14, m: 16, l: 18, xl: 20 });

const CALL_ITEM = /^[A-Z0-9/]{1,12}$/;
const MODIFIER = /^(?:[0-9]{3}|[A-Z]{1,4})$/;

// CQ 對象（CQ modifier）：000–999 或 1–4 個字母；空字串＝不加。不合格回 null
export function normalizeModifier(text) {
  if (typeof text !== 'string') return null;
  const v = text.trim().toUpperCase();
  return v === '' || MODIFIER.test(v) ? v : null;
}

// 呼號或前綴清單：逗號（含全形）、頓號、空白分隔；轉大寫、去重、丟掉不合格的
export function parseCallList(input) {
  const parts = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,，、]+/) : [];
  const out = [];
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const v = p.trim().toUpperCase();
    if (CALL_ITEM.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

const bool = (def) => ({ def, read: (v) => (typeof v === 'boolean' ? v : undefined) });
const oneOf = (def, options) => ({ def, read: (v) => (options.includes(v) ? v : undefined) });
const list = () => ({ def: Object.freeze([]), read: (v) => (Array.isArray(v) || typeof v === 'string' ? parseCallList(v) : undefined) });

// 每個欄位：預設值與 read（合法回正規化後的值，不合法回 undefined）
const FIELDS = {
  cqModifier: { def: '', read: (v) => normalizeModifier(v) ?? undefined },
  // 自動通聯（qso-automation spec；T2 讀取）
  autoFollowCQ: bool(true),
  autoFollowCQOrder: oneOf(0, [0, 1, 2, 3, 4, 5, 6]), // 回應 CQ 方案，標籤見 qso/autofollow.mjs SCHEME_LABELS
  qsoFilterOpt: oneOf(4, QSO_FILTER_OPTIONS.map(([v]) => v)),
  showWorkedStations: bool(true),
  // Control 分頁「隱藏已通聯站台」（使用者 2026-10-19）：跟 showWorkedStations 分開，各管各的——
  // showWorkedStations 只影響 Stations 分頁的站台清單與分區新舊標記，不碰解碼清單；這個只管
  // 解碼清單要不要把已通聯過的列直接拿掉（不是加刪除線，是真的不顯示）。
  hideWorkedDecodes: bool(false),
  followCallsigns: list(),
  excludedCallsigns: list(), // 排除的呼號前綴
  launchSupervisionMin: oneOf(15, SUPERVISION_OPTIONS),
  noReplyLimit: oneOf(0, NO_REPLY_OPTIONS),
  finishRetryLimit: oneOf(2, FINISH_RETRY_OPTIONS),
  synFrequency: bool(false), // 同頻發射（FT8TW synFrequency，預設異頻）
  // 回報 PSKReporter：接收到的 spot（現有功能）、網頁完成的 QSO（W3，T5 實作）；同 FT8TW spotPSK 預設開
  pskSpots: bool(true),
  pskQso: bool(true),
  // 顯示
  theme: oneOf('auto', THEMES),
  fontSize: { def: 16, read: (v) => {
    const px = typeof v === 'string' ? LEGACY_FONT_SIZES[v] ?? (/^\d+$/.test(v) ? Number(v) : undefined) : v;
    return FONT_SIZES.includes(px) ? px : undefined;
  } },
  modernCalling: bool(false), // 呼叫畫面使用電台卡（摩登），同 FT8TW modernCalling
  keepScreenOn: bool(true), // 接收中保持螢幕開啟（Screen Wake Lock，使用者 2026-10-18）：全域，不隨設定組
  // 語系（使用者 2026-10-07）：auto＝依瀏覽器；i18n/core.mjs 在所有模組之前直接讀這個欄位
  language: oneOf('auto', LANGUAGE_CHOICES),
  // 時鐘
  // 範圍外（開發中分支曾放寬到 ±10 秒，未上線）退回最近的上下限；範圍內不在 0.1 秒格點上的才算不合格
  timeOffsetMs: { def: 0, read: (v) => {
    const n = msNumber(v);
    if (Number.isInteger(n) && Math.abs(n) > TIME_OFFSET_LIMIT_MS) return Math.sign(n) * TIME_OFFSET_LIMIT_MS;
    return TIME_OFFSET_OPTIONS.includes(n) ? n : undefined;
  } },
  dtAdvisor: bool(true), // 自動偵測時間偏差（add-dt-offset-advisor D12）：全域設定，不隨設定組
  // 收訊音訊延遲（D14）：只影響接收；隨設定組（profiles.mjs SCOPED_CONFIG）
  // 範圍外（開發中曾有 −10 秒）正規化到最近的合法值；範圍內不在格點上的才算不合格
  rxAudioDelayMs: { def: 0, read: (v) => {
    const n = msNumber(v);
    if (Number.isInteger(n) && (n > RX_DELAY_LIMIT_MS || n < RX_DELAY_MIN_MS)) return nearestRxDelay(n);
    return RX_DELAY_OPTIONS.includes(n) ? n : undefined;
  } },
  // 線上地圖來源（add-map-tile-source S2）：全域，不隨設定組。自訂網址樣板只存一組；空字串＝沒填。
  // 選了自訂但網址空的組合由 map/tilesource.mjs resolveTileSource 退回 EOX 2025
  mapTileSource: oneOf(DEFAULT_TILE_SOURCE, TILE_SOURCE_IDS),
  mapTileUrl: { def: '', read: (v) => (v === '' || validateTileTemplate(v) === null ? v : undefined) },
  mapTileAttribution: { def: '', read: (v) => (validateTileAttribution(v) === null ? v.trim() : undefined) },
};

export const CONFIG_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.def])));

const fresh = (v) => (Array.isArray(v) ? [...v] : v);

// raw：localStorage 裡解析出來的東西（可能是任何值）。回傳 { config, invalid（被退回預設的欄位）, from（原本的版本，沒有資料時 null）}
export function migrateConfig(raw) {
  const ok = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
  const from = ok ? (Number.isInteger(raw.v) ? raw.v : 0) : null;
  const config = {};
  const invalid = [];
  for (const [key, f] of Object.entries(FIELDS)) {
    if (!ok || !(key in raw)) {
      config[key] = fresh(f.def);
      continue;
    }
    const v = f.read(raw[key]);
    if (v === undefined) invalid.push(key);
    config[key] = v === undefined ? fresh(f.def) : v;
  }
  // v0 → v1：目前沒有欄位改名；之後改格式時在這裡依 from 轉換
  return { config, invalid, from };
}

export function loadConfig(storage) {
  let raw = null;
  try {
    raw = JSON.parse(storage.getItem(CONFIG_KEY) ?? 'null');
  } catch {
    raw = null; // 壞掉的 JSON 或 localStorage 不可用：全部預設
  }
  return migrateConfig(raw);
}

export function saveConfig(storage, config) {
  const { config: clean } = migrateConfig(config);
  try {
    storage.setItem(CONFIG_KEY, JSON.stringify({ v: CONFIG_VERSION, ...clean }));
    return true;
  } catch {
    return false; // 無痕模式等：只是下次不會記得
  }
}

// 只改 patch 裡認得而且合法的欄位；回傳更新後的設定
export function updateConfig(storage, patch) {
  const { config } = loadConfig(storage);
  for (const [key, value] of Object.entries(patch)) {
    const f = FIELDS[key];
    const v = f?.read(value);
    if (v !== undefined) config[key] = v;
  }
  saveConfig(storage, config);
  return config;
}

// 給其他模組（T2 通聯流程等）一次讀齊所有設定
export function loadAll(storage) {
  return {
    settings: loadSettings(storage),
    tx: loadTxPrefs(storage),
    autostart: loadAutoStart(storage),
    retentionDays: loadRetention(storage),
    config: loadConfig(storage).config,
    rig: loadRigPrefs(storage),
  };
}

// 發射監管的毫秒數；0＝忽略（不限時）
export function supervisionMs(config) {
  return config.launchSupervisionMin * 60_000;
}
