// JTTY 長訊息自動分則（add-jtty-utx U12，使用者 2026-10-09）：超過 16 frame 的訊息切成多則，每則各自規劃（發話者 frame、
// 開頭呼號字、UTX 都照單則規則）、各自 EOM。純函式：規劃函式由呼叫端注入（實際接 txplan.planTx＋WASM codec）。
//
// 切法：對原文（只把各種空白壓成一個空白、去頭尾；不轉大寫，UTX 要保留大小寫）以字（grapheme）為單位，
//   1. 倍增找上界；整段放得下就是最後一則
//   2. 否則二分搜尋找最長放得下的前綴 L（frame 數不是嚴格單調，例如湊成 `CQ <我> CQ` 時發話者 frame 會拿掉，
//      所以二分只當候選）
//   3. 從 L 往回找斷點（範圍：L 的 1/3、至少 8 字）：優先空白（空白丟掉）、左邊是全形標點（標點留在前一則；半形標點當一般字元）；
//      範圍內沒有才斷在兩個 CJK 字之間（中文任意字間）；都沒有就在 L 硬切（單一超長 token）
//   4. 斷點那段再規劃一次確認放得下，不行就往回縮；每則至少 1 字，不會死迴圈
//
// plan(segment) → { frameCount, ... }（planTx 成功結果）或 { error }；放得下＝沒有 error 且 frameCount ≤ maxFrames
import { MAX_FRAMES } from './utxframes.mjs';

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** 字（grapheme，沒有 Intl.Segmenter 時退成 code point） */
export function graphemes(text) {
  const s = String(text ?? '');
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/** 切分與字數用的文字：各種空白字元壓成一個空白、去頭尾（~ 不動：強化編碼保留原文） */
export function collapse(raw) {
  return String(raw ?? '').replace(/\s+/gu, ' ').trim();
}

/** 字數（正規化後、含中文；畫面「N 字」） */
export function charCount(raw) {
  return graphemes(collapse(raw)).length;
}

const isSpace = (g) => g === ' ';
// 只算全形／非 ASCII 標點（，。、！？…」）：半形 / . : - 常在呼號、頻率、時間裡（BV6LC/P、14.074），當一般字元不切開
const isPunct = (g) => g.codePointAt(0) >= 0x80 && /^\p{P}/u.test(g);
const isCjk = (g) => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(g);

// 在第 k 個字之前斷開的優先度（0 < k < 長度）：2＝空白或標點後、1＝兩側都是 CJK 字（中文任意字間）、0＝不能斷
export function breakLevel(chars, k) {
  const a = chars[k - 1];
  const b = chars[k];
  if (isSpace(b) || isSpace(a) || isPunct(a)) return 2;
  return isCjk(a) && isCjk(b) ? 1 : 0;
}
export const isBreak = (chars, k) => breakLevel(chars, k) > 0;

/**
 * @param {string} raw 輸入框原文
 * @param {(segment: string) => object} plan 規劃函式（planTx 的結果）
 * @param {{ maxFrames?: number, window?: number }} opts window：往回找斷點的最少字數
 * @returns {{ parts: { text: string, plan: object }[] } | { error: string, plan?: object }}
 *   parts[i].text＝這一則的原文片段；plan＝它的規劃結果（frames、text、utx…）。第一個字就放不下回 error
 */
export function splitMessage(raw, plan, { maxFrames = MAX_FRAMES, window = 8 } = {}) {
  const fits = (r) => Boolean(r) && !r.error && r.frameCount <= maxFrames;
  let chars = graphemes(collapse(raw));
  if (!chars.length) return { error: 'empty' };
  const parts = [];
  const join = (n) => chars.slice(0, n).join('').trim();
  while (chars.length) {
    // 倍增找上界（放不下的長度）：整段很長時不必規劃整段（UTX 規劃與長度成正比）
    let lo = 0; // 已知放得下（0＝還沒有）
    let hi = null; // 已知放不下
    for (let n = 16; n < chars.length; n *= 2) {
      if (fits(plan(join(n)))) lo = n;
      else {
        hi = n;
        break;
      }
    }
    if (hi === null) {
      const whole = plan(chars.join(''));
      if (fits(whole)) {
        parts.push({ text: chars.join(''), plan: whole });
        break;
      }
      if (whole?.error && whole.error !== 'too-long') return { error: whole.error, plan: whole };
      hi = chars.length;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fits(plan(join(mid)))) lo = mid;
      else hi = mid;
    }
    if (lo === 0) {
      // 二分只是候選（非單調）：再試 1 個字；連 1 字都放不下就是錯誤
      const one = plan(join(1));
      if (!fits(one)) return { error: one?.error ?? 'too-long', plan: one };
      lo = 1;
    }
    // 往回找斷點
    const L = lo;
    const min = Math.max(1, L - Math.max(window, Math.floor(L / 3)));
    // 先找空白、標點；範圍內沒有才找 CJK 字間；都沒有就硬切
    let cut = L;
    if (L < chars.length && breakLevel(chars, L) < 2) {
      const find = (level) => {
        for (let k = L; k >= min; k--) if (breakLevel(chars, k) >= level) return k;
        return 0;
      };
      cut = find(2) || find(1) || L;
    }
    // 斷點那段再確認；不行就往回縮（至少 1 字）
    let seg = join(cut);
    let r = seg ? plan(seg) : null;
    while (cut > 1 && (!seg || !fits(r))) {
      cut--;
      seg = join(cut);
      r = seg ? plan(seg) : null;
    }
    if (!seg || !fits(r)) {
      cut = L;
      seg = join(L);
      r = plan(seg);
    }
    parts.push({ text: seg, plan: r });
    chars = chars.slice(cut);
    while (chars.length && isSpace(chars[0])) chars.shift();
  }
  return { parts };
}
