// JTTY 強化編碼（UTX）發射端與共用工具（add-jtty-utx design U1～U3、U5、U6）。純函式，不碰 DOM、不碰 WASM。
//
// frame 配置（34 bit 酬載＝內容字 32 bit＋保留 bit＋EOM；hi＝內容字>>>30、lo＝(內容字<<2 | 保留<<1 | EOM)）：
//   UTX frame 的保留 bit＝1（U1），32 bit 內容字全給 UTX；內容字內 bit 順序 MSB 先（與 D6b 一致）。
//   第一個 frame：bit31＝S＝1、bit30–28＝擴充類型（001＝UTX v1，其餘保留）、bit27–0＝位元流 28 bit
//   後續 frame： bit31＝S＝0、bit30–0＝位元流 31 bit
// 位元流＝utx.encode(text) 去掉開頭 24 bit MAGIC（自 2 bit 初始模式起）。
// padding 只加在整條位元流的結尾（落在最後一個 frame）：先補一個 `0`，其餘補 `1` 至 frame 滿；
// 中間的 frame 全是資料。位元流剛好塞滿 n 個 frame 時，`0` 沒地方放，要多一個 `0`＋30 個 `1` 的 frame（也算在 16 個內）。
// 接收端只在 EOM frame 到時以 lastIndexOf('0') 去掉 padding，再於前面補回 MAGIC 交 utx.decode()。
// 開頭呼號字（U2）照一般 JTTY frame（保留 bit 0、不設 EOM）送，由呼叫端以 WASM pack 打包。
import { MAGIC_BITS, encode as utxEncode } from '../js8/utx.mjs';
import { normalize, isText5Char } from './text5.mjs';

export const UTX_EXT_TYPE_V1 = 0b001;
export const FIRST_BITS = 28; // 第一個 frame 的位元流容量
export const NEXT_BITS = 31; // 後續 frame 的位元流容量
export const MAX_FRAMES = 16;

const bin = (v, n) => (v >>> 0).toString(2).padStart(n, '0');

// ===== 觸發條件（U5）=====

/** 是否需要 UTX：正規化後有 TEXT5 以外的字，或 a–z 與 A–Z 混用（~ 與各種空白字元照 text5.normalize 當空白，不觸發） */
export function needsUtxJtty(raw) {
  const s = String(raw ?? '');
  const chars = Array.from(s);
  const norm = Array.from(normalize(s));
  let hasUpper = false;
  let hasLower = false;
  for (let i = 0; i < chars.length; i++) {
    if (!isText5Char(norm[i])) return true;
    const c = chars[i];
    if (c >= 'a' && c <= 'z') hasLower = true;
    else if (c >= 'A' && c <= 'Z') hasUpper = true;
  }
  return hasUpper && hasLower;
}

// ===== 開頭呼號字切分（U2）=====

// 呼號字的 6 種形式（D6b i2＝0／1），依 token 數由長到短嘗試；null＝呼號位置
const CALL_FORMS = [
  ['CQ', null, 'CQ'],
  ['TU', null, 'CQ'],
  ['TU', 'NOW', null],
  [null, 'TU'],
  [null, 'AGN?'],
  [null],
];

/**
 * 訊息開頭連續、可打包成呼號字的片段。token 以正規化（大寫）後比對；每段回正規化後以單一空白相接的文字。
 * rest：最後一段之後的原文（去掉前導空白；呼號字已提供後面的隱含空白，D6b）。
 * @param {string} text
 * @param {{ isStandardCall: (call: string) => boolean }} opts 呼叫端注入（實際接 WASM，判斷能否打包成呼號字）
 * @returns {{ prefix: { text: string }[], rest: string }}
 */
export function splitLeadingCalls(text, { isStandardCall }) {
  const raw = String(text ?? '');
  const norm = normalize(raw); // 逐字轉換，位置與原文對齊
  const tokens = [...norm.matchAll(/\S+/gu)].map((m) => ({ t: m[0], end: m.index + m[0].length }));
  const prefix = [];
  let i = 0;
  let end = 0;
  for (;;) {
    let hit = null;
    for (const form of CALL_FORMS) {
      if (i + form.length > tokens.length) continue;
      const ok = form.every((w, k) => (w === null ? isStandardCall(tokens[i + k].t) : tokens[i + k].t === w));
      if (ok) {
        hit = form.length;
        break;
      }
    }
    if (hit === null) break;
    prefix.push({ text: tokens.slice(i, i + hit).map((x) => x.t).join(' ') });
    end = tokens[i + hit - 1].end;
    i += hit;
  }
  return { prefix, rest: prefix.length ? raw.slice(end).replace(/^\s+/u, '') : raw };
}

// UTX 段的文字：各種空白字元換成空白、連續空白壓成一個、去頭尾（其餘保留原文，含 ~ 與大小寫）
export function utxText(rest) {
  return String(rest ?? '').replace(/\s+/gu, ' ').trim();
}

// ===== 位元流 ↔ 內容字 =====

/** 位元流需要幾個 frame（含至少 1 bit padding） */
export function framesForBits(nbits) {
  const need = nbits + 1;
  return need <= FIRST_BITS ? 1 : 1 + Math.ceil((need - FIRST_BITS) / NEXT_BITS);
}

/** n 個 UTX frame 可承載的位元流長度（扣掉至少 1 bit padding） */
export function capacityBits(nframes) {
  return nframes <= 0 ? -1 : FIRST_BITS + NEXT_BITS * (nframes - 1) - 1;
}

/**
 * 位元流（不含 MAGIC）→ 內容字。最後一個 frame 補 `0` 再補 `1`；剛好塞滿時多一個 padding frame。
 * @returns {{ word: number, first: boolean, last: boolean }[]}
 */
export function wordsFromStream(stream) {
  const n = framesForBits(stream.length);
  const total = FIRST_BITS + NEXT_BITS * (n - 1);
  const padded = (stream + '0').padEnd(total, '1');
  const out = [];
  for (let k = 0; k < n; k++) {
    const body = k === 0 ? '1' + bin(UTX_EXT_TYPE_V1, 3) + padded.slice(0, FIRST_BITS)
      : '0' + padded.slice(FIRST_BITS + NEXT_BITS * (k - 1), FIRST_BITS + NEXT_BITS * k);
    out.push({ word: parseInt(body, 2), first: k === 0, last: k === n - 1 });
  }
  return out;
}

// 一個內容字的位元流部分（第一個 frame 去掉 S＋類型 4 bit，後續去掉 S）
export function streamBitsOfWord(word) {
  const b = bin(word, 32);
  return b[0] === '1' ? b.slice(4) : b.slice(1);
}

/** 第一個 UTX frame？（S＝1 且類型＝001） */
export function isUtxStart(word) {
  return word >>> 28 === (0b1000 | UTX_EXT_TYPE_V1);
}

/** 後續 frame？（S＝0） */
export function isUtxContinuation(word) {
  return word >>> 31 === 0;
}

/** 完整一則的內容字（依序）→ 含 MAGIC、去掉 padding 的位元流；第一個不是 UTX 開頭或沒有 padding 標記回 null */
export function utxBitsFromWords(words) {
  const list = words.map((w) => (typeof w === 'number' ? w : w.word));
  if (list.length === 0 || !isUtxStart(list[0]) || list.slice(1).some((w) => !isUtxContinuation(w))) return null;
  const stream = list.map(streamBitsOfWord).join('');
  const cut = stream.lastIndexOf('0');
  return cut < 0 ? null : MAGIC_BITS + stream.slice(0, cut);
}

/** 文字 → UTX frame 的內容字（只含 UTX 段；呼叫前須已載入字表，否則中文等會退成 literal） */
export function utxWords(text) {
  return wordsFromStream(utxEncode(text).slice(MAGIC_BITS.length));
}

// ===== 整則規劃（U2、U5、U6）=====

/**
 * 規劃一則訊息怎麼送。呼叫端已判斷強化開關開啟且不是巨集。
 * - utx＝false：整則照 JTTY 原樣打包（不需 UTX，或開頭呼號之後的部分都在 TEXT5 內且大小寫一致）
 * - utx＝true：prefixTexts 各打包成一個呼號字 frame（不設 EOM），其後送 utxWords（保留 bit＝1，最後一個設 EOM）
 * frames＝總 frame 數（呼號 frame＋UTX frame）；fits＝frames ≤ maxFrames。
 * capacityChars：UTX 段在上限內估計能放的字數（超過時為實際放得下的前綴字數；未超過時依目前平均每字 bit 數外推）。
 * withCapacity＝false 時不算 capacityChars（自動分則 U12 會規劃很多次，超過時的逐字回退與長度平方成正比）。
 */
export function planUtxMessage(text, { isStandardCall, maxFrames = MAX_FRAMES, withCapacity = true }) {
  const raw = String(text ?? '');
  if (!needsUtxJtty(raw)) return { utx: false, prefixTexts: [], utxText: '', utxWords: [], frames: 0, fits: true };
  const { prefix, rest } = splitLeadingCalls(raw, { isStandardCall });
  const body = utxText(rest);
  if (body === '' || !needsUtxJtty(body)) {
    return { utx: false, prefixTexts: [], utxText: '', utxWords: [], frames: 0, fits: true };
  }
  const prefixTexts = prefix.map((p) => p.text);
  const words = utxWords(body);
  const frames = prefixTexts.length + words.length;
  const fits = frames <= maxFrames;
  if (!withCapacity) return { utx: true, prefixTexts, utxText: body, utxWords: words, frames, fits };
  const capBits = capacityBits(maxFrames - prefixTexts.length);
  const streamLen = (s) => utxEncode(s).length - MAGIC_BITS.length;
  const chars = Array.from(body);
  let capacityChars;
  if (fits) {
    const used = streamLen(body);
    const per = Math.max(1, (used - 2) / chars.length);
    capacityChars = chars.length + Math.max(0, Math.floor((capBits - used) / per));
  } else {
    let n = chars.length - 1;
    while (n > 0 && streamLen(chars.slice(0, n).join('')) > capBits) n--;
    capacityChars = n;
  }
  return { utx: true, prefixTexts, utxText: body, utxWords: words, frames, fits, capacityChars };
}

// ===== 34 bit 酬載 =====

/** 內容字＋保留 bit＋EOM → { hi（內容字最高 2 bit）, lo（其餘 30 bit<<2 | 保留<<1 | EOM） } */
export function toHiLo(word, { reserved = 0, eom = false } = {}) {
  return { hi: word >>> 30, lo: ((word << 2) | ((reserved ? 1 : 0) << 1) | (eom ? 1 : 0)) >>> 0 };
}

/** { hi, lo } → { word, reserved, eom } */
export function fromHiLo(hi, lo) {
  return { word: (((hi & 3) << 30) | (lo >>> 2)) >>> 0, reserved: (lo >>> 1) & 1, eom: (lo & 1) === 1 };
}
