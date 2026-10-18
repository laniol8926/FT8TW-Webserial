// JTTY 糾錯 frame 接收端（add-jtty-fec E6～E8）：收集校驗 frame、依時間排位、補回缺的資料 frame 並還原保留 bit 與 EOM。
// 純函式（unpack 由呼叫端注入，實際接 WASM codec.unpack），組合與重播由 assembler.mjs 負責。
//
// 保留 bit 與 EOM 不傳（E6），由位置決定：EOM 只在第 n−1 個；保留 bit 的結構是
//   [發話者 frame（1）]？＋保留 0 的 frame（UTX 訊息時只能是開頭呼號字）＋保留 1 的 UTX 段（第一個是 S＝1 類型 001，其後 S＝0）。
// 缺的 frame 剛好在邊界時（最後一個呼號字或 UTX 開頭、第一個是發話者或一般 frame）有歧義：列出所有結構上可能的解讀，
// 以收到的 frame 的保留 bit、每個 frame 的文法、UTX 位元流能完整解出且確實需要 UTX 篩選；**剩下不只一種就不修復**（寧可顯示「…」）。
import { toHiLo, isUtxStart, isUtxContinuation, utxBitsFromWords, needsUtxJtty } from './utxframes.mjs';
import { decode as utxDecode } from '../js8/utx.mjs';
import { SLOT_MS } from './fec.mjs';

const isSenderWord = (w) => w >>> 28 === 0b1010;

/** 解碼器輸出的 frame → { word, reserved, eom }（有 hi/lo 用 hi/lo，否則用 raw 十六進位；都沒有回 null） */
export function payloadOf(f) {
  let hi;
  let lo;
  if (Number.isInteger(f.hi) && Number.isInteger(f.lo)) {
    hi = f.hi;
    lo = f.lo >>> 0;
  } else if (typeof f.raw === 'string' && /^[0-3]?[0-9A-Fa-f]{8}$/u.test(f.raw)) {
    hi = f.raw.length > 8 ? parseInt(f.raw.slice(0, -8), 16) : 0;
    lo = parseInt(f.raw.slice(-8), 16) >>> 0;
  } else {
    return null;
  }
  return { word: (((hi & 3) << 30) | (lo >>> 2)) >>> 0, reserved: (lo >>> 1) & 1, eom: (lo & 1) === 1 };
}

/**
 * 補齊的內容字 → 可能的解讀（每個都是可以依序推進組合器的 frame 列）。
 * @param {{ words: number[], received: (null|{ reserved: number, snr?: number|null })[], base: number, freqHz: number,
 *   unpack: (hi: number, lo: number) => object|null }} o
 * @returns {{ frames: object[], utx: boolean, sender: boolean }[]}
 */
export function interpretations({ words, received, base, freqHz, unpack }) {
  const n = words.length;
  const out = [];
  for (const sender of [true, false]) {
    if (sender && !isSenderWord(words[0])) continue;
    const start = sender ? 1 : 0;
    for (let b = start; b <= n; b++) {
      const resv = (k) => ((k === 0 && sender) || k >= b ? 1 : 0);
      if (received.some((r, k) => r && r.reserved !== resv(k))) continue;
      if (b < n && (!isUtxStart(words[b]) || words.slice(b + 1).some((w) => !isUtxContinuation(w)))) continue;
      const frames = [];
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        const eom = k === n - 1;
        const { hi, lo } = toHiLo(words[k], { reserved: resv(k), eom });
        const u = unpack(hi, lo);
        if (!u) ok = false;
        else if (k === 0 && sender) ok = u.kind === 'ext' && u.ext === 'sender';
        else if (k < b) ok = u.kind !== 'ext' && (b === n || u.kind === 'call');
        else ok = u.kind === 'ext' && u.ext === 'utx';
        if (!ok) break;
        frames.push({ ...u, t0: base + k * SLOT_MS, freqHz, snr: received[k]?.snr ?? null, eom, ...(received[k] ? {} : { repaired: true }) });
      }
      if (!ok) continue;
      if (b < n) {
        // UTX 段要完整解得出（padding、沒有 U+FFFD），且確實需要 UTX（發送端只在需要時才走 UTX，U5）
        const bits = utxBitsFromWords(words.slice(b));
        const text = bits ? utxDecode(bits) : null;
        if (!text || text.includes('�') || !needsUtxJtty(text)) continue;
      }
      out.push({ frames, utx: b < n, sender });
    }
  }
  return out;
}
