// JS8 WASM 解碼器的 JS 包裝（tasks 6.2、add-web-js8-chat D2／D3）。瀏覽器（Web Worker）與 Node 測試共用。
// 結果結構的位移必須與 wasm/src/decode_js8_web.c 的 ft8tw_js8_result_t 一致。
// 五種速度（submode 0 Normal、1 Fast、2 Turbo、4 Slow、8 FT8TW 4S）；不給 submode＝Normal。
// 輸入是自 slot 起點前 1 秒起的 12 kHz 樣本，長度＝該速度的擷取窗（Normal 14.84 秒，同 FT8TW Js8Receiver）。

import { SUBMODES, SUBMODE_LIST, captureWindow } from '../js/js8/submodes.mjs';

export const JS8_LEAD_MS = 1000;

// 各速度參數（design D2、D4）：全部 79 符號、tone spacing＝12000/nsps；擷取窗＝1000＋起始延遲＋79×nsps/12＋700 ms。
// timeBiasSec：解碼器回報的時間比實際起點晚的量，剛好約一個符號（＝nsps/12000）。
// 2026-10-07 實測：js8ref synth 每速度 seed 1～8 × 5 訊號（雜訊 0.1）＝40 則，全解、無多餘，WASM 解碼：
//   速度    符號長    偏差範圍            平均      平均／符號長
//   Normal  0.160 s   0.1240～0.2040 s    0.1616 s  1.010（舊版另測 48 則平均 0.169）
//   Fast    0.100 s   0.0750～0.1250 s    0.0998 s  0.998
//   Turbo   0.050 s   0.0375～0.0625 s    0.0505 s  1.010
//   Slow    0.320 s   0.2440～0.3880 s    0.3152 s  0.985
//   4S      0.025 s   0.0187～0.0312 s    0.0256 s  1.022
// 與符號長成比例，故取一個符號長
// 速度參數只在 web/js/js8/submodes.mjs 一份（code review 2026-10-07：兩份會漂移），這裡只加解碼器自己的名稱與時間偏差
const DECODER_NAMES = { 0: 'NORMAL', 1: 'FAST', 2: 'TURBO', 4: 'SLOW', 8: 'FT8TW_4S' };
export const JS8_SUBMODES = Object.freeze(Object.fromEntries(SUBMODE_LIST.map((n) => {
  const { nsps, startDelayMs, periodMs } = SUBMODES[n];
  return [n, Object.freeze({ name: DECODER_NAMES[n], nsps, startDelayMs, periodMs, captureMs: captureWindow(n).durationMs, timeBiasSec: nsps / 12000 })];
})));

export function js8Submode(submode) {
  const p = Object.hasOwn(JS8_SUBMODES, submode) && Number.isInteger(submode) ? JS8_SUBMODES[submode] : null;
  if (!p) throw new Error(`JS8 submode 不合法：${submode}`);
  return p;
}

// Normal 的舊常數（既有呼叫端沿用）
export const JS8_CAPTURE_MS = JS8_SUBMODES[0].captureMs;
export const JS8_START_DELAY_MS = JS8_SUBMODES[0].startDelayMs; // JS8Call Normal：slot 起點後 0.5 秒才開始發
export const JS8_TIME_BIAS_SEC = JS8_SUBMODES[0].timeBiasSec;

// 相對「名目發射起點」（slot 起點＋該速度起始延遲）的時間差，與 FT8 的 DT 意義相同
export function js8Dt(timeSec, submode = 0) {
  const p = js8Submode(submode);
  return timeSec - p.timeBiasSec - (JS8_LEAD_MS + p.startDelayMs) / 1000;
}

export async function createJs8Decoder(moduleUrl) {
  const { default: createModule } = await import(moduleUrl.href ?? moduleUrl);
  const mod = await createModule();
  const resultSize = mod._ft8tw_js8_result_size();
  const maxFrames = mod._ft8tw_js8_max_frames();
  const outPtr = mod._malloc(resultSize * maxFrames);
  if (!outPtr) throw new Error('JS8 解碼器配置記憶體失敗');
  let samplesPtr = 0;
  let samplesCap = 0;

  function ensureSamples(n) {
    if (n <= samplesCap) return;
    if (samplesPtr) mod._free(samplesPtr);
    samplesPtr = mod._malloc(n * 4);
    if (!samplesPtr) {
      samplesCap = 0;
      throw new Error('JS8 解碼器配置記憶體失敗');
    }
    samplesCap = n;
  }

  return {
    // 一個 frame 的發射波形（add-web-transmit 1.4）：Float32Array 12 kHz、79×nsps 樣本；起始延遲由排程處理
    encode(payload, itype, { freqHz = 1000, submode = 0 } = {}) {
      js8Submode(submode);
      if (!(payload instanceof Uint8Array) || payload.length !== 9) throw new Error('JS8 payload 必須是 9 bytes');
      const n = mod._ft8tw_js8_encode_samples(submode);
      const payloadPtr = mod._malloc(9);
      const wavePtr = mod._malloc(n * 4);
      if (!payloadPtr || !wavePtr) {
        mod._free(payloadPtr);
        mod._free(wavePtr);
        throw new Error('JS8 編碼器配置記憶體失敗');
      }
      try {
        mod.HEAPU8.set(payload, payloadPtr);
        const got = mod._ft8tw_js8_encode(payloadPtr, itype, freqHz, submode, wavePtr, n);
        if (got !== n) throw new Error('JS8 編碼失敗（參數不合法）');
        return mod.HEAPF32.slice(wavePtr / 4, wavePtr / 4 + n);
      } finally {
        mod._free(payloadPtr);
        mod._free(wavePtr);
      }
    },
    // 回傳 frame：{ timeSec（相對擷取起點）, freqHz, snr, score, itype, payload: Uint8Array(9) }
    decode(samples, { submode = 0 } = {}) {
      js8Submode(submode);
      ensureSamples(samples.length);
      mod.HEAPF32.set(samples, samplesPtr / 4);
      const n = mod._ft8tw_js8_decode(samplesPtr, samples.length, submode, outPtr, maxFrames);
      if (n < 0) throw new Error(`JS8 解碼失敗（submode ${submode}）`);
      const view = new DataView(mod.HEAPU8.buffer);
      const out = [];
      for (let i = 0; i < n; i++) {
        const base = outPtr + i * resultSize;
        out.push({
          timeSec: view.getFloat32(base, true),
          freqHz: view.getFloat32(base + 4, true),
          snr: view.getInt32(base + 8, true),
          score: view.getInt32(base + 12, true),
          itype: mod.HEAPU8[base + 16],
          payload: mod.HEAPU8.slice(base + 17, base + 26),
        });
      }
      return out;
    },
  };
}

export function payloadHex(payload) {
  return Array.from(payload, (b) => b.toString(16).padStart(2, '0')).join('');
}
