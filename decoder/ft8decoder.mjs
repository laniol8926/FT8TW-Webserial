// FT8／FT4 WASM 解碼器的 JS 包裝。瀏覽器（Web Worker）與 Node 測試共用。
// 結果結構的位移必須與 wasm/src/decode_web.c 的 ft8tw_result_t 一致。

const PROTOCOLS = { FT8: 0, FT4: 1 };
// 發射波形（add-web-transmit D2、D3）：模式編號與 wasm/src/encode_web.h 一致
const ENCODE_MODES = { FT8: 0, FT4: 1, FT2: 2 };
const ENCODE_ERRORS = { [-1]: '參數不合法', [-2]: '訊息無法編碼（呼號、網格、字元或長度不合規則）', [-3]: '記憶體不足' };
const MAX_RESULTS = 256;
const TEXT_OFFSET = 16;

// moduleUrl：emscripten 產生的 ES module（web/wasm/ft8tw-decoder.mjs）
export async function createFt8Decoder(moduleUrl) {
  const { default: createModule } = await import(moduleUrl.href ?? moduleUrl);
  const mod = await createModule();
  const resultSize = mod._ft8tw_result_size();
  const textBytes = resultSize - TEXT_OFFSET;
  const outPtr = mod._malloc(resultSize * MAX_RESULTS);
  let samplesPtr = 0;
  let samplesCap = 0;
  const textDecoder = new TextDecoder();

  function ensureSamples(n) {
    if (n <= samplesCap) return;
    if (samplesPtr) mod._free(samplesPtr);
    samplesPtr = mod._malloc(n * 4);
    samplesCap = n;
  }

  function readText(ptr) {
    const bytes = mod.HEAPU8.subarray(ptr, ptr + textBytes);
    const end = bytes.indexOf(0);
    return textDecoder.decode(bytes.subarray(0, end < 0 ? bytes.length : end));
  }

  return {
    // samples：12 kHz 的一個 slot（Float32Array，−1～1）
    decode(samples, { protocol = 'FT8', useHash = true } = {}) {
      const p = PROTOCOLS[protocol];
      if (p === undefined) throw new Error(`不支援的 protocol：${protocol}`);
      ensureSamples(samples.length);
      mod.HEAPF32.set(samples, samplesPtr / 4);
      const n = mod._ft8tw_decode(samplesPtr, samples.length, p, useHash ? 1 : 0, outPtr, MAX_RESULTS);
      if (n < 0) throw new Error('WASM 解碼失敗');
      const view = new DataView(mod.HEAPU8.buffer);
      const out = [];
      for (let i = 0; i < n; i++) {
        const base = outPtr + i * resultSize;
        out.push({
          timeSec: view.getFloat32(base, true),
          freqHz: view.getFloat32(base + 4, true),
          snr: Math.round(view.getFloat32(base + 8, true)),
          score: view.getInt32(base + 12, true),
          text: readText(base + TEXT_OFFSET),
        });
      }
      return out;
    },
    resetHashTable() {
      mod._ft8tw_reset_hashtable();
    },
    // 產生發射波形（Float32Array，振幅 ±1、頭尾 ramp）。freeText：自由文字（i3=0、n3=0）
    encode(text, { mode = 'FT8', freqHz = 1000, sampleRate = 12000, freeText = false } = {}) {
      const m = ENCODE_MODES[mode];
      if (m === undefined) throw new Error(`不支援的發射模式：${mode}`);
      const n = mod._ft8tw_encode_samples(m, sampleRate);
      if (n <= 0) throw new Error(ENCODE_ERRORS[-1]);
      const bytes = new TextEncoder().encode(String(text));
      const textPtr = mod._malloc(bytes.length + 1);
      const outPtr = mod._malloc(n * 4);
      if (!textPtr || !outPtr) {
        mod._free(textPtr);
        mod._free(outPtr);
        throw new Error(ENCODE_ERRORS[-3]);
      }
      try {
        mod.HEAPU8.set(bytes, textPtr);
        mod.HEAPU8[textPtr + bytes.length] = 0;
        const got = mod._ft8tw_encode(textPtr, freeText ? 1 : 0, freqHz, m, sampleRate, outPtr, n);
        if (got < 0) throw new Error(ENCODE_ERRORS[got] ?? `編碼失敗（${got}）`);
        return mod.HEAPF32.slice(outPtr / 4, outPtr / 4 + got);
      } finally {
        mod._free(textPtr);
        mod._free(outPtr);
      }
    },
  };
}
