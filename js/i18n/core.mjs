// 多語系的純邏輯（使用者 2026-10-07）：語系偵測、偏好、字串代入、查字。不碰 DOM，Node 可測；DOM 套用在 index.mjs。
// 支援：英文（預設）、繁體中文。瀏覽器語系是中文（含簡體，使用者決定）→ 繁中；手動選過（設置 › 顯示與佈景）以手動為準。

export const LOCALES = Object.freeze(['en', 'zh-TW']);
export const LANGUAGE_CHOICES = Object.freeze(['auto', ...LOCALES]); // 設置裡的選項（auto＝依瀏覽器）
const CONFIG_KEY = 'ft8tw.config';

// 依瀏覽器偏好順序（navigator.languages）找第一個支援的
export function detectLocale(languages) {
  for (const tag of languages ?? []) {
    const l = String(tag).toLowerCase();
    if (l === 'zh' || l.startsWith('zh-')) return 'zh-TW';
    if (l === 'en' || l.startsWith('en-')) return 'en';
  }
  return 'en';
}

export function resolveLocale(pref, languages) {
  return LOCALES.includes(pref) ? pref : detectLocale(languages);
}

// 直接讀 ft8tw.config 的 language（不經 config/model.mjs：i18n 要在所有模組之前就決定語系）
export function readLanguagePref(storage) {
  try {
    const v = JSON.parse(storage.getItem(CONFIG_KEY) ?? 'null')?.language;
    return LANGUAGE_CHOICES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function format(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// 查字：目前語系 → 英文 → key 本身（onMissing 記下沒翻到的）
export function createTranslator({ locale, dicts, onMissing = () => {} }) {
  return (key, params) => {
    const own = dicts[locale]?.[key];
    if (own !== undefined) return format(own, params);
    onMissing(key);
    const en = dicts.en?.[key];
    return format(en ?? key, params);
  };
}
