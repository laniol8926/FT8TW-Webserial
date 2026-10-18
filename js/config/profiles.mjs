// 設定組（add-web-profiles，移植 FT8TW Radio Profile）：純邏輯，storage 可注入；畫面在 config/ui.mjs。
// 目前設定組的值留在原本的鍵（P1），ft8tw.profiles 只存清單、目前 id 與其他設定組的值。
// 切換分兩段（P3、review 2026-10-09）：① requestSwitch 只把「要切到哪組＋目前的值」一次寫進 ft8tw.profiles（pending），然後重新載入；
// ② 新頁面在任何模組讀設定之前（boot.mjs）completePending：寫入新那組的值、更新清單。舊頁面在重新載入前的晚到寫入
// 會被 ② 蓋掉，不會串到新設定組；任何一步寫入失敗都不會遺失資料（pending 留著，下次載入再完成）。
import { t } from '../i18n/index.mjs';
import configDict from '../i18n/dict/config.mjs';

export const PROFILES_KEY = 'ft8tw.profiles';
// 整個搬（原始 JSON 字串）：基本（呼號、網格、波段、模式、音訊輸入）、電台控制、發射（輸出裝置、發射電平…）
export const WHOLE_KEYS = Object.freeze(['ft8tw.settings', 'ft8tw.rig', 'ft8tw.tx']);
const CONFIG_KEY = 'ft8tw.config';
// ft8tw.config 中隨設定組的欄位（App PROFILE_KEYS：tomodifier、cqorderopt、launchsupervision、noreplylimit、finishretrylimit、spotpsk）；
// 網頁另加 rxAudioDelayMs（收訊音訊延遲屬於那一套收音路徑，例如 WebSDR，add-dt-offset-advisor D15）
export const SCOPED_CONFIG = Object.freeze(['cqModifier', 'autoFollowCQOrder', 'launchSupervisionMin', 'noReplyLimit', 'finishRetryLimit', 'pskSpots', 'rxAudioDelayMs']);
export const NAME_MAX = 24;
const DEFAULT_NAME = 'Default'; // 同 App radio_profiles 預設列
// 「預設」在所有語系的名稱都保留，不能拿來命名（換語系後不會出現兩個「預設」）
const RESERVED = new Set([DEFAULT_NAME, ...Object.values(configDict).map((d) => d['config.profileDefault'])].filter(Boolean).map((s) => s.toLowerCase()));

const fresh = () => ({ active: 1, list: [{ id: 1, name: DEFAULT_NAME, data: null }] });
const clean = (name) => String(name ?? '').trim();
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function readData(d) {
  if (!isObj(d)) return null;
  const out = {};
  for (const k of WHOLE_KEYS) {
    if (!(k in d)) continue;
    if (d[k] !== null && typeof d[k] !== 'string') return null;
    out[k] = d[k];
  }
  out.config = isObj(d.config) ? Object.fromEntries(SCOPED_CONFIG.filter((k) => k in d.config).map((k) => [k, d.config[k]])) : {};
  return out;
}

// 讀清單；沒有或壞掉 → 只有「預設」（P7）。不寫回 storage
export function loadProfiles(storage) {
  let raw = null;
  try {
    raw = JSON.parse(storage.getItem(PROFILES_KEY) ?? 'null');
  } catch {
    raw = null;
  }
  if (!isObj(raw) || !Array.isArray(raw.list)) return fresh();
  const seen = new Set();
  const list = [];
  for (const p of raw.list) {
    const id = p?.id;
    const name = clean(p?.name);
    if (!Number.isInteger(id) || id < 1 || seen.has(id) || !name || name.length > NAME_MAX) continue;
    seen.add(id);
    list.push({ id, name, data: readData(p.data) });
  }
  if (!list.length) return fresh();
  const active = list.some((p) => p.id === raw.active) ? raw.active : list[0].id;
  const st = { active, list };
  if (Number.isInteger(raw.next) && raw.next > Math.max(...list.map((p) => p.id))) st.next = raw.next;
  const pd = raw.pending;
  if (isObj(pd) && pd.from === active && list.some((p) => p.id === pd.to) && pd.to !== active) {
    st.pending = { to: pd.to, from: pd.from, drop: pd.drop === true, snapshot: readData(pd.snapshot) };
  }
  return st;
}

function save(storage, st) {
  storage.setItem(PROFILES_KEY, JSON.stringify({ v: 1, ...st }));
}

const nextId = (st) => Math.max(st.next ?? 0, ...st.list.map((p) => p.id + 1));

export function displayName(p) {
  return p.name === DEFAULT_NAME ? t('config.profileDefault') : p.name;
}

// 名稱錯誤：'empty'｜'long'｜'duplicate'｜null。exceptId：改名時跟自己相同可以
export function nameError(st, name, exceptId = null) {
  const n = clean(name);
  if (!n) return 'empty';
  if (n.length > NAME_MAX) return 'long';
  const key = n.toLowerCase();
  const self = st.list.find((p) => p.id === exceptId);
  if (self && (self.name.toLowerCase() === key || displayName(self).toLowerCase() === key)) return null;
  if (RESERVED.has(key)) return 'duplicate';
  return st.list.some((p) => p.id !== exceptId && (p.name.toLowerCase() === key || displayName(p).toLowerCase() === key)) ? 'duplicate' : null;
}

function readConfig(storage) {
  try {
    const c = JSON.parse(storage.getItem(CONFIG_KEY) ?? '{}');
    return isObj(c) ? c : {};
  } catch {
    return {};
  }
}

// 目前的值（從原本的鍵）
function snapshot(storage) {
  const data = {};
  for (const k of WHOLE_KEYS) data[k] = storage.getItem(k);
  const cfg = readConfig(storage);
  data.config = Object.fromEntries(SCOPED_CONFIG.filter((k) => k in cfg).map((k) => [k, cfg[k]]));
  return data;
}

// 把一組值寫進原本的鍵：整個搬的鍵原本沒有就移除；config 只換 SCOPED_CONFIG 的 7 個欄位，其他（共用）保留
function apply(storage, data) {
  for (const k of WHOLE_KEYS) {
    const v = data?.[k] ?? null;
    if (v === null) storage.removeItem(k);
    else storage.setItem(k, v);
  }
  const cfg = readConfig(storage);
  for (const k of SCOPED_CONFIG) delete cfg[k];
  Object.assign(cfg, data?.config ?? {});
  storage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

const find = (st, id) => {
  const p = st.list.find((x) => x.id === id);
  if (!p) throw new Error(`unknown profile ${id}`);
  return p;
};

// ① 要切到 id：只寫一次 ft8tw.profiles（pending＋目前的值）。回傳是否需要重新載入
export function requestSwitch(storage, id) {
  const st = loadProfiles(storage);
  find(st, id);
  if (id === st.active) return false;
  st.pending = { to: id, from: st.active, drop: false, snapshot: snapshot(storage) };
  save(storage, st);
  return true;
}

// ① 刪除：刪別組直接刪；刪目前那組＝切到清單中其他第一組並丟掉目前這組（只剩一組不能刪）。回傳是否需要重新載入
export function requestDelete(storage, id) {
  const st = loadProfiles(storage);
  find(st, id);
  if (st.list.length <= 1) throw new Error('last');
  if (id !== st.active) {
    st.next = nextId(st);
    st.list = st.list.filter((p) => p.id !== id);
    delete st.pending;
    save(storage, st);
    return false;
  }
  st.pending = { to: st.list.find((p) => p.id !== id).id, from: id, drop: true, snapshot: null };
  save(storage, st);
  return true;
}

// ② 完成 pending（新頁面、任何模組讀設定之前）。寫入失敗：設定鍵還原成切換前的值、pending 留著下次再試；回傳 { switched, error }
export function completePending(storage) {
  const st = loadProfiles(storage);
  const pd = st.pending;
  if (!pd) return { switched: false, error: null };
  const target = find(st, pd.to);
  try {
    if (target.data) apply(storage, target.data); // 值壞掉（P7 丟掉了）：沿用目前的值，不要清空設定
  } catch (error) {
    try { if (pd.snapshot) apply(storage, pd.snapshot); } catch { /* 還原也失敗：pending 留著 */ }
    return { switched: false, error };
  }
  if (pd.drop) {
    st.next = nextId(st);
    st.list = st.list.filter((p) => p.id !== pd.from);
  } else {
    find(st, pd.from).data = pd.snapshot ?? find(st, pd.from).data;
  }
  target.data = null;
  st.active = pd.to;
  delete st.pending;
  try {
    save(storage, st);
  } catch (error) {
    return { switched: true, error }; // 設定鍵已是新那組；清單沒更新，pending 留著，下次載入再寫一次（同樣的結果）
  }
  return { switched: true, error: null };
}

// 一次做完（單元測試、不需要重新載入的呼叫端）
export function switchProfile(storage, id) {
  if (requestSwitch(storage, id)) {
    const r = completePending(storage);
    if (r.error) throw r.error;
  }
  return loadProfiles(storage);
}

export function deleteProfile(storage, id) {
  if (requestDelete(storage, id)) {
    const r = completePending(storage);
    if (r.error) throw r.error;
  }
  return loadProfiles(storage);
}

// 新增：複製目前那組、切過去（值一樣，設定鍵不用改，一次寫入）。回傳新 id
export function createProfile(storage, name) {
  const st = loadProfiles(storage);
  const err = nameError(st, name);
  if (err) throw new Error(err);
  const id = nextId(st);
  find(st, st.active).data = snapshot(storage);
  st.list.push({ id, name: clean(name), data: null });
  st.active = id;
  st.next = id + 1;
  delete st.pending;
  save(storage, st);
  return id;
}

export function renameProfile(storage, id, name) {
  const st = loadProfiles(storage);
  const p = find(st, id);
  const err = nameError(st, name, id);
  if (err) throw new Error(err);
  if (displayName(p) === clean(name)) return st; // 沒改（「預設」不要被存成翻譯後的字）
  p.name = clean(name);
  save(storage, st);
  return st;
}

// 給畫面用的錯誤訊息 key：已知代碼翻譯，其他（例如儲存空間不足）用通用訊息
export function errorKey(err) {
  return ['empty', 'long', 'duplicate', 'last'].includes(err?.message) ? `config.profileErr.${err.message}` : 'config.profileErr.save';
}
