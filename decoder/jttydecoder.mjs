// JTTY WASM 編解碼的 JS 包裝（add-web-jtty 任務 1.3、1.4、design D3、D5、D7）。瀏覽器（Web Worker）與 Node 測試共用。
// 結果結構的位移必須與 wasm/src/jtty/jtty_decode.h 的 jtty_result_t 一致。
// 酬載 34 bit 以 { hi（bit 33–32）, lo（bit 31–0）} 表示（wasm/src/jtty_web.c 檔頭）。
// 頻率一律是 tone 0（最低 tone）。
// 保留 bit＝1 的 frame（FT8TW 擴充，add-jtty-utx U1、U3、U10）解成 kind 'ext'，附原始內容字 word：
//   ext＝'sender'（發話者 frame，call＝呼號）、'utx'（UTX 第一個或後續 frame，由組合器判斷接不接得上）
//   或 'parity'（糾錯 frame，add-jtty-fec：另附 col、idx、n、sym）
import { fromHiLo } from '../js/jtty/utxframes.mjs';
import { parseParityWord } from '../js/jtty/fec.mjs';

export const JTTY_RATE = 12000;
export const JTTY_FRAME_SAMPLES = 59 * 384;
export const JTTY_MAX_FRAMES = 16;
export const JTTY_MAX_TX_FRAMES = 20; // 一次發射：16 個資料 frame＋最多 4 個糾錯 frame（add-jtty-fec）
export const STRUCT_PLACEHOLDER = '〔比賽交換〕'; // design D7：P1 收到 STRUCT30 顯示的佔位
const KINDS = ['call', 'text', 'struct', 'ext'];
const TEXT_MAX = 2048;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// loadModule：省略＝同站的 ../wasm/ft8tw-jtty.mjs；URL／字串＝模組位置；函式＝回傳 emscripten 工廠（或其模組）
async function loadFactory(loadModule) {
  if (typeof loadModule === 'function') {
    const m = await loadModule();
    return typeof m === 'function' ? m : m.default;
  }
  const url = loadModule ?? new URL('../wasm/ft8tw-jtty.mjs', import.meta.url);
  return (await import(url.href ?? url)).default;
}

export function payloadHex(hi, lo) {
  return hi.toString(16).toUpperCase() + (lo >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export async function createJttyCodec(loadModule) {
  const createModule = await loadFactory(loadModule);
  const mod = await createModule();
  const resultSize = mod._ft8tw_jtty_result_size();
  const maxResults = mod._ft8tw_jtty_max_results();
  const outPtr = mod._malloc(resultSize * maxResults);
  const textPtr = mod._malloc(TEXT_MAX);
  const strPtr = mod._malloc(TEXT_MAX);
  const payPtr = mod._malloc(JTTY_MAX_TX_FRAMES * 8);
  if (!outPtr || !textPtr || !strPtr || !payPtr) throw new Error('JTTY 編解碼器配置記憶體失敗');
  let samplesPtr = 0;
  let samplesCap = 0;

  function ensureSamples(n) {
    if (n <= samplesCap) return;
    if (samplesPtr) mod._free(samplesPtr);
    samplesPtr = mod._malloc(n * 4);
    if (!samplesPtr) {
      samplesCap = 0;
      throw new Error('JTTY 解碼器配置記憶體失敗');
    }
    samplesCap = n;
  }

  // 字串寫進 WASM（UTF-8、NUL 結尾）；太長回 false
  function putString(s) {
    const bytes = encoder.encode(String(s ?? ''));
    if (bytes.length + 1 > TEXT_MAX) return false;
    mod.HEAPU8.set(bytes, strPtr);
    mod.HEAPU8[strPtr + bytes.length] = 0;
    return true;
  }

  function readString(ptr) {
    let end = ptr;
    while (mod.HEAPU8[end] !== 0) end++;
    return decoder.decode(mod.HEAPU8.subarray(ptr, end));
  }

  // 一個 frame → { kind, text, eom }；文法不合回 null。text 含隱含空白（呼號字、STRUCT30 不是最後一個 frame 時）。
  // kind 'ext'：text 為空字串（文字由組合器的 UTX 段解出），另附 word、ext（'sender'｜'utx'｜'parity'），發話者 frame 再附 call；
  // 糾錯 frame 再附 col、idx、n、sym（C 端已驗證 EOM、保留 bit、n、校驗序號）
  function unpack(hi, lo) {
    const kind = mod._ft8tw_jtty_unpack(hi >>> 0, lo >>> 0, textPtr, TEXT_MAX);
    if (kind < 0) return null;
    const eom = (lo & 1) === 1;
    const name = KINDS[kind];
    if (name === 'ext') {
      const { word } = fromHiLo(hi, lo);
      if (word >>> 28 === 0b1011) return { kind: name, text: '', eom, word, ext: 'parity', ...parseParityWord(word) };
      const call = readString(textPtr);
      return call ? { kind: name, text: '', eom, word, ext: 'sender', call } : { kind: name, text: '', eom, word, ext: 'utx' };
    }
    const text = name === 'struct' ? STRUCT_PLACEHOLDER + (eom ? '' : ' ') : readString(textPtr);
    return { kind: name, text, eom };
  }

  // 原始酬載序列 → 整則波形（擴充 frame 用；不檢查文法）。失敗回 { error }
  function encodePayloads(frames, freqHz) {
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > JTTY_MAX_TX_FRAMES) return { error: frames?.length ? 'too-long' : 'empty' };
    for (let i = 0; i < frames.length; i++) {
      const { hi, lo } = frames[i] ?? {};
      if (!Number.isInteger(hi) || hi < 0 || hi > 3 || !Number.isInteger(lo) || lo < 0 || lo > 0xffffffff) return { error: 'bad-frame' };
      mod.HEAPU32[payPtr / 4 + 2 * i] = hi;
      mod.HEAPU32[payPtr / 4 + 2 * i + 1] = lo;
    }
    const n = mod._ft8tw_jtty_encode_samples(frames.length);
    const wavePtr = mod._malloc(n * 4);
    if (!wavePtr) throw new Error('JTTY 編碼器配置記憶體失敗');
    try {
      const got = mod._ft8tw_jtty_encode(payPtr, frames.length, freqHz, wavePtr, n);
      if (got !== n) return { error: 'bad-freq' };
      return mod.HEAPF32.slice(wavePtr / 4, wavePtr / 4 + n);
    } finally {
      mod._free(wavePtr);
    }
  }

  function packFrames(text) {
    if (!putString(text)) return { error: 'too-long' };
    const n = mod._ft8tw_jtty_pack(strPtr, payPtr, JTTY_MAX_FRAMES);
    if (n < 0) return { error: 'too-long' };
    if (n === 0) return { error: 'empty' };
    const frames = [];
    for (let i = 0; i < n; i++) frames.push({ hi: mod.HEAPU32[payPtr / 4 + 2 * i], lo: mod.HEAPU32[payPtr / 4 + 2 * i + 1] });
    return { frames };
  }

  return {
    unpack,

    // 正規化（大寫、~ 與空白壓成一個空白、去頭尾、表外字換 #）
    normalize(text) {
      if (!putString(text)) return null;
      const n = mod._ft8tw_jtty_normalize(strPtr, textPtr, TEXT_MAX);
      return n < 0 ? null : readString(textPtr);
    },

    // 打包：{ frames: [{hi, lo}], text（各 frame 解回接起來＝正規化原文）}；失敗 { error: 'empty'|'too-long' }
    pack(text) {
      const r = packFrames(text);
      if (r.error) return r;
      return { frames: r.frames, text: r.frames.map((f) => unpack(f.hi, f.lo).text).join('') };
    },

    // 整則訊息相位連續的 12 kHz 波形（freqHz＝tone 0）；失敗 { error }
    encode(text, freqHz) {
      const r = packFrames(text);
      if (r.error) return r;
      return encodePayloads(r.frames, freqHz);
    },

    // 原始酬載序列 [{ hi, lo }]（含保留 bit＝1 的擴充 frame）→ 波形；失敗 { error: 'empty'|'too-long'|'bad-frame'|'bad-freq' }
    encodeFrames(frames, freqHz) {
      return encodePayloads(frames, freqHz);
    },

    // 標準呼號 → call28（發話者 frame 用）；不是可收的標準呼號回 -1
    call28(call) {
      if (!putString(String(call ?? '').trim().toUpperCase())) return -1;
      return mod._ft8tw_jtty_call28(strPtr);
    },

    // samples：12 kHz 視窗（StreamCutter 的 4.0 s）；只回起點在視窗前 acceptMs 的 frame。
    // 回傳 [{ t0（UTC ms）, freqHz, snr, text, eom, kind, raw（34 bit 酬載 9 位十六進位）, hi, lo, sync, nsync, nsymerr }]；
    // kind 'ext' 另有 word、ext、call（見 unpack）
    decode(samples, { startUtc = 0, acceptMs = 2000 } = {}) {
      ensureSamples(samples.length);
      mod.HEAPF32.set(samples, samplesPtr / 4);
      const accept = Math.round((acceptMs * JTTY_RATE) / 1000);
      const n = mod._ft8tw_jtty_decode(samplesPtr, samples.length, accept, outPtr, maxResults);
      if (n < 0) throw new Error('JTTY 解碼失敗（參數不合法）');
      const view = new DataView(mod.HEAPU8.buffer);
      const out = [];
      for (let i = 0; i < n; i++) {
        const base = outPtr + i * resultSize;
        const hi = view.getUint32(base + 16, true);
        const lo = view.getUint32(base + 20, true);
        const u = unpack(hi, lo);
        if (!u) continue; // 解碼器已過文法閘門，不會發生
        const ext = u.kind === 'ext' ? { word: u.word, ext: u.ext, ...(u.call ? { call: u.call } : {}), ...(u.ext === 'parity' ? { col: u.col, idx: u.idx, n: u.n, sym: u.sym } : {}) } : {};
        out.push({
          t0: startUtc + view.getFloat32(base, true) * 1000,
          freqHz: view.getFloat32(base + 4, true),
          snr: view.getInt32(base + 8, true),
          text: u.text,
          eom: u.eom,
          kind: u.kind,
          raw: payloadHex(hi, lo),
          hi,
          lo,
          sync: view.getFloat32(base + 12, true),
          nsync: view.getInt32(base + 24, true),
          nsymerr: view.getInt32(base + 28, true),
          ...ext,
        });
      }
      return out;
    },

    // 假解碼閘門（量測工具用）；省略的欄位維持原值
    setParams({ syncMin = -1, maxCand = 0, minSyncMatch = -1, maxSymErr = -1 } = {}) {
      mod._ft8tw_jtty_set_params(syncMin, maxCand, minSyncMatch, maxSymErr);
    },
  };
}
