// JTTY 糾錯 frame（add-jtty-fec design E1～E8）：GF(2^16) 運算、Reed–Solomon 抹除碼、校驗 frame 打包解包、位置推算。純函式。
//
// GF(2^16)：原始多項式 x^16＋x^12＋x^3＋x＋1（0x1100B），α＝x（＝2）為原根（測試以 α^(65535/p)≠1，p∈{3,5,17,257} 驗證）。
//
// Reed–Solomon（校驗矩陣形式，RS 的 Vandermonde／求值寫法）：資料符號 d_0…d_{n−1}（n≤17），第 j 個校驗符號
//   p_j ＝ Σ_i d_i·α^(j·i)（j＝0…r−1）
// r＝1 時 p_0 就是 XOR；r＝2 時多一個 p_1。p_j 與 r 無關：標準（r＝1）的 2 個校驗 frame 恰好是加強（r＝2）4 個中的前 2 個，
// 接收端不必知道對方選了哪個等級。r≤2 時 [I | V] 的每個方陣子矩陣都可逆（1×1：α^(j·i)≠0；2×2：α^i2−α^i1≠0，i<65535）→ MDS：
// 收到的校驗符號數 ≥ 缺的資料符號數就解得出（任何位置組合）。
//
// 校驗 frame（E5）：內容字＝S＝1（bit31）＋類型 011（bit30–28）＋欄 col（bit27；0＝資料內容字高 16 bit、1＝低 16 bit）
//   ＋校驗序號 idx（bit26–24，即上式的 j）＋資料 frame 數 n（bit23–19）＋保留 3 bit（bit18–16，0）＋符號（bit15–0）；
//   保留 bit＝1、EOM＝0。
// 發射順序（E4）：EOM 之後依 (idx0,col0)、(idx0,col1)、(idx1,col0)、(idx1,col1)；第 k 個校驗 frame 的位置（slot）＝n＋2·idx＋col
//   （資料 frame 為 slot 0…n−1，每 slot 1888 ms）。加強的尾巴漏掉時，前面那組仍可各欄補 1 個。
// 資料 frame 數 n 含發話者 frame；是否加校驗 frame 只看發話者 frame 以外的資料 frame 數（≥3，E2）。
import { toHiLo } from './utxframes.mjs';

export const GF_POLY = 0x1100b;
export const GF_SIZE = 65536;
export const PARITY_EXT_TYPE = 0b011;
export const FEC_LEVELS = Object.freeze({ off: 0, standard: 1, strong: 2 }); // r：每欄幾個校驗符號
export const FEC_DEFAULT = 'standard';
export const FEC_MIN_DATA = 3; // 發話者 frame 以外 ≥3 個資料 frame 才加（E2）
export const PARITY_N_MIN = 3;
export const PARITY_N_MAX = 17; // WASM 閘門同（n 含發話者 frame；每則上限 16，留 1 的餘裕）
export const PARITY_IDX_MAX = 3; // 校驗序號 < 4（3 bit 欄位，目前只用 0、1）
export const SLOT_MS = 1888;
export const SLOT_TOL_MS = 100;

const EXP = new Uint16Array(2 * GF_SIZE);
const LOG = new Int32Array(GF_SIZE);
{
  let x = 1;
  for (let i = 0; i < GF_SIZE - 1; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & GF_SIZE) x ^= GF_POLY;
  }
  for (let i = GF_SIZE - 1; i < EXP.length; i++) EXP[i] = EXP[i - (GF_SIZE - 1)];
  LOG[0] = -1;
}

/** GF(2^16) 乘法 */
export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** GF(2^16) 除法（b≠0） */
export function gfDiv(a, b) {
  if (b === 0) throw new RangeError('GF 除以 0');
  if (a === 0) return 0;
  return EXP[LOG[a] - LOG[b] + (GF_SIZE - 1)];
}

/** α^e（e≥0） */
export function gfPow(e) {
  return EXP[e % (GF_SIZE - 1)];
}

/** 一般元素的次方（測試原根用） */
export function gfPowOf(a, e) {
  if (a === 0) return e === 0 ? 1 : 0;
  return EXP[(LOG[a] * e) % (GF_SIZE - 1)];
}

const coef = (j, i) => gfPow(j * i);

/**
 * 校驗符號 p_0…p_{r−1}
 * @param {number[]} data 16 bit 符號
 */
export function paritySymbols(data, r) {
  const out = [];
  for (let j = 0; j < r; j++) {
    let p = 0;
    data.forEach((d, i) => { p ^= gfMul(d & 0xffff, coef(j, i)); });
    out.push(p);
  }
  return out;
}

/**
 * 抹除解碼：data 中 null＝缺；parity[j]＝p_j 或 null（沒收到）。
 * 收到的校驗符號數 ≥ 缺的數量就解出，回補齊的陣列；否則回 null。沒有缺就原樣回傳（不驗證）。
 */
export function recoverErasures(data, parity) {
  const missing = [];
  data.forEach((d, i) => { if (d === null || d === undefined) missing.push(i); });
  if (missing.length === 0) return [...data];
  const rows = [];
  parity.forEach((p, j) => { if (p !== null && p !== undefined) rows.push(j); });
  const e = missing.length;
  if (rows.length < e) return null;
  const use = rows.slice(0, e);
  // A·x＝b：A[k][m]＝α^(j_k·i_m)，b_k＝p_{j_k} − Σ_{已知} d_i·α^(j_k·i)
  const A = use.map((j) => missing.map((i) => coef(j, i)));
  const b = use.map((j) => {
    let s = parity[j];
    data.forEach((d, i) => { if (d !== null && d !== undefined) s ^= gfMul(d, coef(j, i)); });
    return s;
  });
  // 高斯消去（GF 加減＝XOR）
  for (let c = 0; c < e; c++) {
    let piv = c;
    while (piv < e && A[piv][c] === 0) piv++;
    if (piv === e) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    const inv = gfDiv(1, A[c][c]);
    for (let m = c; m < e; m++) A[c][m] = gfMul(A[c][m], inv);
    b[c] = gfMul(b[c], inv);
    for (let k = 0; k < e; k++) {
      if (k === c || A[k][c] === 0) continue;
      const f = A[k][c];
      for (let m = c; m < e; m++) A[k][m] ^= gfMul(f, A[c][m]);
      b[k] ^= gfMul(f, b[c]);
    }
  }
  const out = [...data];
  missing.forEach((i, k) => { out[i] = b[k]; });
  return out;
}

// ===== 校驗 frame =====

/** 校驗 frame 的內容字 */
export function parityWord({ col, idx, n, sym }) {
  return ((1 << 31) | (PARITY_EXT_TYPE << 28) | ((col & 1) << 27) | ((idx & 7) << 24) | ((n & 31) << 19) | (sym & 0xffff)) >>> 0;
}

/** 內容字 → { col, idx, n, sym }；不是合法的校驗 frame 內容字回 null（規則同 WASM 閘門，EOM 由呼叫端檢查） */
export function parseParityWord(word) {
  const w = word >>> 0;
  if (w >>> 28 !== (0b1000 | PARITY_EXT_TYPE)) return null;
  const col = (w >>> 27) & 1;
  const idx = (w >>> 24) & 7;
  const n = (w >>> 19) & 31;
  if (((w >>> 16) & 7) !== 0 || n < PARITY_N_MIN || n > PARITY_N_MAX || idx > PARITY_IDX_MAX) return null;
  return { col, idx, n, sym: w & 0xffff };
}

/** 校驗 frame 在第幾個 slot（資料 frame 為 0…n−1） */
export function paritySlot({ n, idx, col }) {
  return n + 2 * idx + col;
}

/** 校驗 frame 起點 → 資料 slot 0 的起點 */
export function baseT0(parity) {
  return parity.t0 - paritySlot(parity) * SLOT_MS;
}

/** 起點 t0 在以 base 為 slot 0 時是第幾個 slot（±100 ms）；對不上回 null */
export function slotOf(t0, base) {
  const k = Math.round((t0 - base) / SLOT_MS);
  return Math.abs(t0 - base - k * SLOT_MS) <= SLOT_TOL_MS ? k : null;
}

/** 設定值 → r（不認得的當預設） */
export function fecLevel(setting) {
  return FEC_LEVELS[setting] ?? FEC_LEVELS[FEC_DEFAULT];
}

/** 設定值正規化（存 localStorage 用） */
export function normalizeFecSetting(v) {
  return Object.hasOwn(FEC_LEVELS, v) ? v : FEC_DEFAULT;
}

/**
 * 一則訊息（資料 frame 的內容字，依序，含發話者 frame）→ 校驗 frame 酬載 [{ hi, lo }]（保留 bit 1、EOM 0），依發射順序。
 * contentFrames：發話者 frame 以外的資料 frame 數（< 3 不加，E2）；r＝0 不加。
 */
export function parityFrames(words, r, { contentFrames = words.length } = {}) {
  const n = words.length;
  if (r <= 0 || contentFrames < FEC_MIN_DATA || n < PARITY_N_MIN || n > PARITY_N_MAX) return [];
  const cols = [words.map((w) => (w >>> 16) & 0xffff), words.map((w) => w & 0xffff)];
  const p = cols.map((c) => paritySymbols(c, r));
  const out = [];
  for (let idx = 0; idx < r; idx++) {
    for (let col = 0; col < 2; col++) out.push(toHiLo(parityWord({ col, idx, n, sym: p[col][idx] }), { reserved: 1 }));
  }
  return out;
}

/**
 * 兩欄抹除解碼：words 中 null＝缺；parity：[{ col, idx, sym }]。各欄收到的校驗符號數都 ≥ 缺的數量才解，回補齊的內容字；否則 null。
 * 收到的校驗符號比缺的多時，多的拿來驗算（對不上＝資料或校驗有誤，回 null）
 */
export function recoverWords(words, parity) {
  const cols = [0, 1].map((col) => {
    const data = words.map((w) => (w === null || w === undefined ? null : col === 0 ? (w >>> 16) & 0xffff : w & 0xffff));
    const ps = [];
    for (const p of parity) if (p.col === col) ps[p.idx] = p.sym;
    const rows = Array.from({ length: ps.length }, (_, j) => ps[j] ?? null);
    const full = recoverErasures(data, rows);
    if (!full) return null;
    const check = paritySymbols(full, rows.length);
    return rows.every((p, j) => p === null || p === check[j]) ? full : null;
  });
  if (!cols[0] || !cols[1]) return null;
  return cols[0].map((hi, i) => (((hi << 16) | cols[1][i]) >>> 0));
}
