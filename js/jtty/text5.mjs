// JTTY TEXT5 字元表與輸入檢查（add-web-jtty jtty-protocol「內容字文法」）。
// 陣列索引＝6 bit 代碼（design D6b，黑箱分析確定）：前 61 字的順序取自第三方描述，代碼 61–63 為 | : ;（Wave C 由 WSJT-X 酬載對出）。

// 64 字：0–9、A–Z、空白、+ - . / ? ! " # $ % , & * ( ) _ ' = [ ] { } < >、| : ;
export const TEXT5_CHARS = Object.freeze([
  ...'0123456789',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ' ',
  ...'+-./?!"#$%,&*()_\'=[]{}<>',
  ...'|:;',
]);

const CHAR_SET = new Set(TEXT5_CHARS);

export function isText5Char(c) {
  return CHAR_SET.has(c);
}

// 送出前的正規化：轉大寫、~ 與各種空白字元轉空白（規格「文字打包」、D6b）。逐字轉換，長度與原文相同（ß 之類不展開成兩字），
// 輸入框標示的位置才對得上；其餘（空白壓縮、去頭尾）不做，打包端要求「解回＝正規化原文」
export function normalize(text) {
  let out = '';
  for (const c of String(text ?? '')) {
    if (c === '~' || /\s/u.test(c)) out += ' '; // 換行、Tab、NBSP 等空白字元都當空白（D6b）
    else {
      const up = c.toUpperCase();
      out += up.length === c.length ? up : c;
    }
  }
  return out;
}

// 不在字元表內的字元（正規化之後判斷，所以小寫與 ~ 不算）：[{ index（UTF-16 位置，給 setSelectionRange）, char }]
export function unsupportedChars(text) {
  const bad = [];
  let index = 0;
  for (const c of normalize(text)) {
    if (!CHAR_SET.has(c)) bad.push({ index, char: c });
    index += c.length;
  }
  return bad;
}

export function isSupported(text) {
  return unsupportedChars(text).length === 0;
}
