// 多語系執行期（使用者 2026-10-07）：載入時就決定語系（讀 ft8tw.config 的 language 與瀏覽器語系），
// 所以其他模組在自己載入時呼叫 t() 也會拿到正確的語言（模組最上層的常數、標籤）。
// 用法：
//   import { t } from './i18n/index.mjs';  t('page.start')、t('page.decoded', { n: 3 })
//   HTML：<span data-i18n="page.start">開始接收</span>（中文原文留著當未載入前的後備）；
//         屬性：data-i18n-attr="aria-label:page.x;title:page.y"
//   切換語系：setLanguage('en'|'zh-TW'|'auto') → 存設定後重新載入頁面（最單純可靠，不必每個模組都會重畫）
import { createTranslator, readLanguagePref, resolveLocale } from './core.mjs';
import { mergedDicts } from './dict/index.mjs';

const storage = (() => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
})();
// 只有瀏覽器才偵測語系。Node（單元測試）也有 navigator.language 而且跟著系統語系走（繁中 Windows 與英文 CI 結果不同），
// 所以固定英文；要測繁中時設環境變數 FT8TW_LOCALE=zh-TW
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
const languages = isBrowser
  ? globalThis.navigator?.languages ?? (globalThis.navigator?.language ? [globalThis.navigator.language] : [])
  : [globalThis.process?.env?.FT8TW_LOCALE ?? 'en'];

export const languagePref = readLanguagePref(storage);
export const locale = resolveLocale(languagePref, languages);
const missing = new Set();
export const t = createTranslator({ locale, dicts: mergedDicts(), onMissing: (k) => missing.add(k) });
export const missingKeys = () => [...missing]; // 本機開發／自動化檢查用

// 把 data-i18n／data-i18n-attr 套到 root 底下的元素
export function applyDom(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  root.documentElement?.setAttribute('lang', locale);
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  root.documentElement?.classList.remove('i18n-pending'); // index.html 開頭的 inline script 先藏起畫面，翻譯套用完才顯示
}

// 語系設定：auto（依瀏覽器）、en、zh-TW。寫進 ft8tw.config 後重新載入
export function setLanguage(pref, { reload = () => globalThis.location?.reload() } = {}) {
  try {
    const raw = JSON.parse(storage?.getItem('ft8tw.config') ?? 'null');
    const next = raw && typeof raw === 'object' ? { ...raw, language: pref } : { v: 1, language: pref };
    storage?.setItem('ft8tw.config', JSON.stringify(next));
  } catch {
    // localStorage 不可用：只是記不住
  }
  reload();
}
