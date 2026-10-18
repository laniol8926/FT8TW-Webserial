// UTX（Unicode Text eXtension）解碼：FT8TW 對 JS8 data frame 的全 Unicode 擴充（中文等）。
// 移植自 FT8TW Js8Utx.java：接收端（looksLikeUtx、decode）與發射端（encode）。
// 位元流 = MAGIC(24) + 初始模式(2) [+ 視窗描述] + token 串；三種模式：
//   A：大寫 ASCII（JS8 huffman 表，'"' 的碼字挪作 ESC）
//   H：分層字表 web/data/utx_rank_table.txt（13/16/19 bits）
//   W：128 字元對齊的 Unicode 視窗（每字 8 bits）
// 字表首次用到才載入：await loadUtxTable(fetch)。未載入時 H 模式字元解成 U+FFFD 並停止（同 Java）。
import { HUFF_TABLE } from './varicode.mjs';
import { t } from '../i18n/index.mjs';

export const MAGIC_BITS = '101010110101011010100011';

const TIER1_SIZE = 4096;
const TIER2_SIZE = 16384;
const TIER3_SIZE = 65536;
const TIER2_BASE = TIER1_SIZE;
const TIER3_BASE = TIER1_SIZE + TIER2_SIZE;

const MODE_A = 0;
const MODE_H = 1;
const MODE_W = 2;

const REPLACEMENT = '�';
const DEFAULT_URL = new URL('../../data/utx_rank_table.txt', import.meta.url);

// 預定義視窗（5-bit index）
const PREDEF_WINDOWS = [
  0x0000, 0x0080, 0x0100, 0x0180, 0x0380, 0x0400, 0x0480, 0x0500,
  0x0580, 0x0600, 0x0680, 0x0900, 0x0980, 0x0a00, 0x0a80, 0x0b00,
  0x0b80, 0x0c00, 0x0c80, 0x0d00, 0x0d80, 0x0e00, 0x0e80, 0x0f00,
  0x1000, 0x1080, 0x1e00, 0x1e80, 0x2000, 0x3000, 0x3080, 0x1f600,
];

let rankToCp = null;
let cpToRank = null; // code point → rank（encode 用；同字重複出現取第一個 rank，同 Java）
let loading = null;

/** 由字表文字載入（一行一個字元，行號=rank，空行=空槽；行尾規則同 Java readLine） */
export function loadUtxTableFromText(text) {
  const cap = TIER3_BASE + TIER3_SIZE;
  const table = new Int32Array(cap).fill(-1);
  const map = new Map();
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // 結尾換行不算一行
  for (let rank = 0; rank < lines.length && rank < cap; rank++) {
    if (lines[rank] !== '') {
      const cp = lines[rank].codePointAt(0);
      table[rank] = cp;
      if (!map.has(cp)) map.set(cp, rank);
    }
  }
  rankToCp = table;
  cpToRank = map;
}

/** 非同步載入字表（只載一次；失敗後可重試）。fetchLike(url) 需回傳 { ok, arrayBuffer() } */
export function loadUtxTable(fetchLike = globalThis.fetch, url = DEFAULT_URL) {
  if (rankToCp) return Promise.resolve();
  loading ??= (async () => {
    const res = await fetchLike(url);
    if (!res.ok) throw new Error(t('js8.utxDownloadFailed', { status: res.status }));
    loadUtxTableFromText(new TextDecoder('utf-8').decode(await res.arrayBuffer()));
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export const isUtxLoaded = () => rankToCp !== null;

/** 測試用：清掉已載入的字表 */
export function unloadUtx() {
  rankToCp = null;
  cpToRank = null;
}

function readBits(bits, pos, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | (bits[pos + i] === '1' ? 1 : 0);
  return v;
}

/** 位元流是否以 UTX 魔術碼開頭（訊息第一個 data frame 用來判別） */
export function looksLikeUtx(bits) {
  return bits != null && bits.length >= MAGIC_BITS.length + 2 && bits.startsWith(MAGIC_BITS);
}

// 讀視窗描述；位元不足回 null，否則 [base, 新pos]
function readWindowSpec(bits, pos) {
  if (bits.length - pos < 6) return null;
  if (bits[pos] === '0') return [PREDEF_WINDOWS[readBits(bits, pos + 1, 5)], pos + 6];
  if (bits.length - pos < 15) return null;
  return [readBits(bits, pos + 1, 14) << 7, pos + 15];
}

/**
 * UTX 位元流 → 文字。可增量呼叫：位元不足一個完整 token 時回傳已解出的前綴。
 * 遇到非法內容附 U+FFFD 後停止；不是 UTX 位元流回 null。
 * 與 Java 不同：自訂視窗使 code point 超過 0x10FFFF 時，Java 丟例外；這裡附 U+FFFD 後停止（code review 2026-10-06）。
 */
export function decode(bits) {
  if (!looksLikeUtx(bits)) return null;
  const out = [];
  const text = () => out.join('');
  let pos = MAGIC_BITS.length;
  let mode = readBits(bits, pos, 2);
  pos += 2;
  let wBase = -1;
  if (mode === 3) return '';
  if (mode === MODE_W) {
    const r = readWindowSpec(bits, pos);
    if (r === null) return '';
    [wBase, pos] = r;
  }

  // 讀 21-bit literal；非法 code point 附 U+FFFD 並回 -1
  const literal = () => {
    const cp = readBits(bits, pos, 21);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out.push(REPLACEMENT);
      return -1;
    }
    out.push(String.fromCodePoint(cp));
    return pos + 21;
  };
  // rank → 字元；空槽/字表未載入附 U+FFFD 並回 false
  const rank = (r) => {
    if (!rankToCp || r >= rankToCp.length || rankToCp[r] < 0) {
      out.push(REPLACEMENT);
      return false;
    }
    out.push(String.fromCodePoint(rankToCp[r]));
    return true;
  };

  while (pos < bits.length) {
    const remain = bits.length - pos;
    if (mode === MODE_A) {
      let matched = null;
      let matchedChar = '';
      for (const [ch, code] of HUFF_TABLE) {
        if (code.length <= remain && bits.startsWith(code, pos)) {
          matched = code;
          matchedChar = ch;
          break;
        }
      }
      if (matched === null) {
        if (remain >= 8) out.push(REPLACEMENT); // 不是任何合法碼字
        break; // remain<8 視為 token 未收齊
      }
      if (matchedChar !== '"') {
        out.push(matchedChar);
        pos += matched.length;
        continue;
      }
      // ESC + 3-bit op
      if (remain < matched.length + 3) break;
      pos += matched.length;
      const op = readBits(bits, pos, 3);
      pos += 3;
      if (op === 0) mode = MODE_H;
      else if (op === 1) {
        const r = readWindowSpec(bits, pos);
        if (r === null) break;
        [wBase, pos] = r;
        mode = MODE_W;
      } else if (op === 2) {
        if (bits.length - pos < 21) break;
        pos = literal();
        if (pos < 0) return text();
      } else if (op === 3) out.push('"');
      else {
        out.push(REPLACEMENT);
        return text();
      }
    } else if (mode === MODE_H) {
      if (bits[pos] === '0') {
        if (remain < 13) break;
        const r = readBits(bits, pos + 1, 12);
        pos += 13;
        if (!rank(r)) return text();
      } else if (remain >= 2 && bits[pos + 1] === '0') {
        if (remain < 16) break;
        const r = TIER2_BASE + readBits(bits, pos + 2, 14);
        pos += 16;
        if (!rank(r)) return text();
      } else if (remain >= 3 && bits[pos + 2] === '0') {
        if (remain < 19) break;
        const r = TIER3_BASE + readBits(bits, pos + 3, 16);
        pos += 19;
        if (!rank(r)) return text();
      } else {
        // `111`+op：控制
        if (remain < 6) break;
        const op = readBits(bits, pos + 3, 3);
        pos += 6;
        if (op === 0) mode = MODE_A;
        else if (op === 1) {
          const r = readWindowSpec(bits, pos);
          if (r === null) break;
          [wBase, pos] = r;
          mode = MODE_W;
        } else if (op === 2) {
          if (bits.length - pos < 21) break;
          pos = literal();
          if (pos < 0) return text();
        } else if (op === 3) out.push(' ');
        else {
          out.push(REPLACEMENT);
          return text();
        }
      }
    } else if (bits[pos] === '0') {
      // MODE_W `0`+7：視窗內字元
      if (remain < 8) break;
      const cp = wBase + readBits(bits, pos + 1, 7);
      pos += 8;
      // Java 在此丟例外，會讓整輪其餘 frame 都被略過、且同一訊息每個續 frame 重丟；網頁改為附 U+FFFD 後停止
      if (cp > 0x10ffff) {
        out.push(REPLACEMENT);
        return text();
      }
      out.push(String.fromCodePoint(cp));
    } else if (remain >= 2 && bits[pos + 1] === '1') {
      out.push(' ');
      pos += 2;
    } else {
      // MODE_W `10`+op
      if (remain < 5) break;
      const op = readBits(bits, pos + 2, 3);
      pos += 5;
      if (op === 0) mode = MODE_A;
      else if (op === 1) {
        const r = readWindowSpec(bits, pos);
        if (r === null) break;
        [wBase, pos] = r;
      } else if (op === 2) {
        if (bits.length - pos < 21) break;
        pos = literal();
        if (pos < 0) return text();
      } else if (op === 3) mode = MODE_H;
      else {
        out.push(REPLACEMENT);
        return text();
      }
    }
  }
  return text();
}

// ===== 編碼（TX 方向）=====

const ESC_A = '1010101'; // Mode A 的 ESC：原 huffman 表中 '"' 的碼字
const OP_TO_A = '000';
const OP_TO_W = '001';
const OP_LITERAL = '010';
const OP_EXTRA = '011'; // A：literal '"'；H：空白；W：切到 H
const HUFF_MAP = new Map(HUFF_TABLE);

const bitsOf = (v, n) => v.toString(2).padStart(n, '0');
const rankOf = (cp) => cpToRank?.get(cp) ?? -1;
const isHuffChar = (cp) => cp < 128 && HUFF_MAP.has(String.fromCharCode(cp));
const windowBaseOf = (cp) => cp & ~0x7f;

function inMode(cp, mode, wBase) {
  if (mode === MODE_A) return isHuffChar(cp);
  if (mode === MODE_H) return rankOf(cp) >= 0;
  return cp >= wBase && cp < wBase + 128;
}

// 從 cps[i] 起同模式連續長度（空白不中斷也不計數），只需分辨 1 與 ≥2
function runLength(cps, i, mode, wBase) {
  let run = 0;
  for (let k = i; k < cps.length; k++) {
    if (cps[k] === 0x20) continue;
    if (!inMode(cps[k], mode, wBase)) break;
    if (++run >= 2) break;
  }
  return run;
}

function windowSpec(wBase) {
  const i = PREDEF_WINDOWS.indexOf(wBase);
  return i >= 0 ? '0' + bitsOf(i, 5) : '1' + bitsOf(wBase >> 7, 14);
}

const ctrlPrefix = (mode) => (mode === MODE_A ? ESC_A : mode === MODE_H ? '111' : '10');

// 目前模式下「切到 target」的控制碼（W 附視窗描述；切到 H：從 A 是 000、從 W 是 011）
function switchBits(from, target, wBase) {
  if (target === MODE_A) return ctrlPrefix(from) + OP_TO_A;
  if (target === MODE_W) return ctrlPrefix(from) + OP_TO_W + windowSpec(wBase);
  return ctrlPrefix(from) + (from === MODE_W ? OP_EXTRA : '000');
}

const literalBits = (mode, cp) => ctrlPrefix(mode) + OP_LITERAL + bitsOf(cp, 21);

function spaceBits(mode) {
  if (mode === MODE_A) return HUFF_MAP.get(' ');
  return mode === MODE_H ? '111' + OP_EXTRA : '11';
}

function charBits(mode, wBase, cp) {
  if (mode === MODE_A) return cp === 0x22 ? ESC_A + OP_EXTRA : HUFF_MAP.get(String.fromCharCode(cp));
  if (mode === MODE_H) {
    const rank = rankOf(cp);
    if (rank < TIER2_BASE) return '0' + bitsOf(rank, 12);
    if (rank < TIER3_BASE) return '10' + bitsOf(rank - TIER2_BASE, 14);
    return '110' + bitsOf(rank - TIER3_BASE, 16);
  }
  return '0' + bitsOf(cp - wBase, 7);
}

/**
 * 文字 → UTX 位元流（含魔術碼與初始模式），任何字元都能編碼（21-bit literal 兜底）。
 * 與 Java 相同以 code point 走訪（落單 surrogate 視為一個 code point）。
 * 字表未載入時 H 模式不可用，退到視窗／literal（同 Java）；發射端應先載入字表。
 */
export function encode(text) {
  const cps = Array.from(text, (ch) => ch.codePointAt(0));
  let bits = MAGIC_BITS;
  let mode = MODE_A;
  let wBase = -1;
  const first = cps.find((cp) => cp !== 0x20);
  if (first === undefined || isHuffChar(first)) bits += '00';
  else if (rankOf(first) >= 0) {
    mode = MODE_H;
    bits += '01';
  } else {
    mode = MODE_W;
    wBase = windowBaseOf(first);
    bits += '10' + windowSpec(wBase);
  }

  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === 0x20) {
      bits += spaceBits(mode);
    } else if (inMode(cp, mode, wBase)) {
      bits += charBits(mode, wBase, cp);
    } else if (isHuffChar(cp)) {
      // 切到 A 很便宜（大寫／數字／呼號常成串出現），一律切換
      bits += switchBits(mode, MODE_A, -1);
      mode = MODE_A;
      bits += charBits(mode, -1, cp);
    } else if (rankOf(cp) >= 0) {
      if (runLength(cps, i, MODE_H, -1) >= 2) {
        bits += switchBits(mode, MODE_H, -1);
        mode = MODE_H;
        bits += charBits(mode, -1, cp);
      } else bits += literalBits(mode, cp);
    } else {
      const nb = windowBaseOf(cp);
      if (runLength(cps, i, MODE_W, nb) >= 2) {
        bits += switchBits(mode, MODE_W, nb);
        mode = MODE_W;
        wBase = nb;
        bits += charBits(mode, wBase, cp);
      } else bits += literalBits(mode, cp);
    }
  }
  return bits;
}
