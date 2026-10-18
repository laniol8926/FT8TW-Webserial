// JS8Call 的 JSC 字典壓縮（(s,c)-dense coding，s=7、c=9）壓縮與解壓。
// 移植自 FT8TW Js8Jsc.java（decompress、詞表載入，以及發射端的 compress）。
// 詞表 web/data/js8_jsc_words.txt：latin1，每行一詞，反斜線與換行以 \\ \n \r 跳脫；
// 存成單一 byte blob + offset 索引，取詞時才建字串（26 萬個字串物件太占記憶體）。
// 首次用到 JS8 才載入：await loadJscWords(fetch)。未載入時 decompress 回空字串（同 Java 載入失敗）。
import { t } from '../i18n/index.mjs';

const SIZE = 262144;
const S = 7;
const C = 9;
const DEFAULT_URL = new URL('../../data/js8_jsc_words.txt', import.meta.url);

let blob = null;
let offsets = null;
let loading = null;
let sortedIdx = null; // 字典序排序的詞 index（compress 用，惰性建立）

// base[k]：k 個前綴 nibble 時的索引底
const BASE = [0, S];
for (let k = 2; k < 8; k++) BASE[k] = BASE[k - 1] + S * C ** (k - 1);

const NL = 0x0a;
const BACKSLASH = 0x5c;

/** 由原始位元組載入詞表（Node 測試直接讀檔餵進來）；條目數不對就丟錯 */
export function loadJscWordsFromBytes(data) {
  const outBlob = new Uint8Array(data.length);
  const outOffsets = new Int32Array(SIZE + 1);
  let word = 0;
  let bp = 0;
  for (let i = 0; i < data.length && word < SIZE; i++) {
    const b = data[i];
    if (b === NL) {
      outOffsets[++word] = bp;
    } else if (b === BACKSLASH && i + 1 < data.length) {
      const e = data[++i];
      outBlob[bp++] = e === 0x6e ? NL : e === 0x72 ? 0x0d : e; // \n、\r，其餘（\\）原字
    } else {
      outBlob[bp++] = b;
    }
  }
  if (word !== SIZE) throw new Error(`JSC 詞表條目數錯誤: ${word} != ${SIZE}`);
  blob = outBlob;
  sortedIdx = null;
  offsets = outOffsets;
}

/**
 * 非同步載入詞表（只載一次；並行呼叫共用同一個 Promise，失敗後可重試）。
 * fetchLike(url) 需回傳 { ok, arrayBuffer() }，瀏覽器直接傳 fetch。
 */
export function loadJscWords(fetchLike = globalThis.fetch, url = DEFAULT_URL) {
  if (blob) return Promise.resolve();
  loading ??= (async () => {
    const res = await fetchLike(url);
    if (!res.ok) throw new Error(t('js8.jscDownloadFailed', { status: res.status }));
    loadJscWordsFromBytes(new Uint8Array(await res.arrayBuffer()));
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export const isJscLoaded = () => blob !== null;

/** 測試用：清掉已載入的詞表 */
export function unloadJsc() {
  blob = null;
  offsets = null;
  sortedIdx = null;
}

// latin1 一 byte 一字元（不可用 TextDecoder('latin1')：WHATWG 會當成 windows-1252）
function wordAt(index) {
  let s = '';
  for (let i = offsets[index]; i < offsets[index + 1]; i++) s += String.fromCharCode(blob[i]);
  return s;
}

/**
 * 解壓 JSC dense-coding 位元流（'0'/'1' 字串，已去掉 data 旗標與 padding）。
 * 詞表未載入或流無法解讀時回空字串。
 * 與 Java 一致：連續 8 個以上前綴 nibble 且索引仍在範圍內時，Java 會 base[8] 越界丟例外；
 * 這裡明確丟 RangeError（JS 陣列越界只會得到 undefined，靜默產生垃圾）。
 */
export function decompress(bits) {
  if (!blob) return '';
  const count = bits.length;
  const bytes = [];
  const separators = [];
  let i = 0;
  while (i + 4 <= count) {
    let v = 0;
    for (let k = 0; k < 4; k++) v = (v << 1) | (bits[i + k] === '1' ? 1 : 0);
    bytes.push(v);
    i += 4;
    if (v < S) {
      if (count - i > 0 && bits[i] === '1') separators.push(bytes.length - 1);
      i += 1;
    }
  }

  let out = '';
  let sep = 0;
  let start = 0;
  const len = bytes.length;
  while (start < len) {
    let k = 0;
    let j = 0;
    while (start + k < len && bytes[start + k] >= S) {
      j = j * C + (bytes[start + k] - S);
      k++;
    }
    if (j >= SIZE) break;
    if (start + k >= len) break;
    if (k >= BASE.length) throw new RangeError(`JSC 前綴 nibble 過多: ${k}`);
    j = j * S + bytes[start + k] + BASE[k];
    if (j >= SIZE) break;
    out += wordAt(j);
    if (sep < separators.length && separators[sep] === start + k) {
      out += ' ';
      sep++;
    }
    start = start + k + 1;
  }
  return out;
}

// ===== 壓縮（TX 方向）=====

const MAX_WORD_LEN = 26;

function compareWords(x, y) {
  const a1 = offsets[x];
  const a2 = offsets[y];
  const l1 = offsets[x + 1] - a1;
  const l2 = offsets[y + 1] - a2;
  const n = Math.min(l1, l2);
  for (let i = 0; i < n; i++) {
    const d = blob[a1 + i] - blob[a2 + i];
    if (d !== 0) return d;
  }
  return l1 - l2 || x - y; // 同詞以 index 排序 = Java Arrays.sort（穩定排序）的結果
}

function ensureSorted() {
  if (sortedIdx) return;
  const idx = Array.from({ length: SIZE }, (_, i) => i);
  idx.sort(compareWords);
  sortedIdx = Int32Array.from(idx);
}

function compareWordToKey(wordIndex, key, keyOff, keyLen) {
  const a = offsets[wordIndex];
  const wl = offsets[wordIndex + 1] - a;
  const n = Math.min(wl, keyLen);
  for (let i = 0; i < n; i++) {
    const d = blob[a + i] - key[keyOff + i];
    if (d !== 0) return d;
  }
  return wl - keyLen;
}

// 二分找完全相等的詞（與 Java 同一演算法，重複詞時命中同一個 index）；找不到回 -1
function lookupExact(key, keyOff, keyLen) {
  let lo = 0;
  let hi = SIZE - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = compareWordToKey(sortedIdx[mid], key, keyOff, keyLen);
    if (cmp === 0) return sortedIdx[mid];
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// jsc.cpp codeword()：index → dense coding 位元串（s=7、c=9、b=4）
function codewordBits(index, separate) {
  const tail = (((index % S) << 1) + (separate ? 1 : 0)).toString(2).padStart(5, '0');
  let head = '';
  let x = Math.floor(index / S);
  while (x > 0) {
    x -= 1;
    head = ((x % C) + S).toString(2).padStart(4, '0') + head;
    x = Math.floor(x / C);
  }
  return head + tail;
}

/**
 * JSC 壓縮（Js8Jsc.compress：最長前綴匹配）。回傳依序的片段 [{ bits, chars }]，
 * chars 是該片段涵蓋的原文字元數（含附帶的分隔空白）。詞表未載入回空陣列（同 Java）。
 * 超出 latin1 的字元以 '?' 頂替。
 */
export function compress(text) {
  const out = [];
  if (!blob) return out;
  ensureSorted();
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes[i] = c <= 0xff ? c : 0x3f;
  }
  const words = text.split(' ');
  let pos = 0; // bytes 中的位置（split 吃掉的空白要自行補算）
  for (let wi = 0; wi < words.length; wi++) {
    const w = words[wi];
    const isLastWord = wi === words.length - 1;
    let isSpaceChar = false;
    const wOff = pos;
    let wLen = w.length;
    if (wLen === 0 && !isLastWord) {
      // 連續空白：這個空段代表一個空白字元詞
      wLen = 1;
      isSpaceChar = true;
    }
    let consumed = 0;
    while (consumed < wLen) {
      const remain = wLen - consumed;
      let found = -1;
      let foundLen = 0;
      for (let l = Math.min(remain, MAX_WORD_LEN); l >= 1; l--) {
        const idx = lookupExact(bytes, wOff + consumed, l);
        if (idx >= 0) {
          found = idx;
          foundLen = l;
          break;
        }
      }
      if (found < 0) {
        // 詞表涵蓋所有可列印 latin1 單字元；控制字元等防禦性跳過（同 Java）
        consumed++;
        continue;
      }
      consumed += foundLen;
      const appendSpace = consumed >= wLen && !isSpaceChar && !isLastWord;
      out.push({ bits: codewordBits(found, appendSpace), chars: foundLen + (appendSpace ? 1 : 0) });
    }
    pos += w.length + 1;
  }
  return out;
}
