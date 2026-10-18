// 設定頁「i」說明：文字在字典 i18n/dict/help.mjs（FT8TW App 原有的說明＋網頁才有的項目，英文／繁中）。純函式，畫面在 config/ui.mjs。
import { t } from '../i18n/index.mjs';
import helpDict from '../i18n/dict/help.mjs';

// id：index.html 的 data-help；沒有這則說明回 null
export function helpText(id) {
  const key = `help.${id}`;
  return Object.hasOwn(helpDict.en, key) ? t(key) : null;
}

// 切成段落，每段再切成文字與網址：[[{ text } | { href }]]。畫面以 textContent／<a> 組出，不用 innerHTML
export function helpParagraphs(text) {
  if (!text) return [];
  return String(text).split('\n').filter((line) => line.trim()).map((line) => {
    const parts = [];
    let last = 0;
    for (const m of line.matchAll(/https?:\/\/[^\s，。）)]+/g)) {
      if (m.index > last) parts.push({ text: line.slice(last, m.index) });
      parts.push({ href: m[0] });
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push({ text: line.slice(last) });
    return parts;
  });
}
