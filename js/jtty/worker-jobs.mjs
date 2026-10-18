// 解碼 Worker 裡的 JTTY 工作（add-web-jtty design D3、D4、D9）：解碼器首次用到才載入、載入失敗下次重試（同 JS8 的 js8Ready）。
// load() → codec（Wave C 的 createJttyCodec()，可為 Promise）：
//   decode(samples, { startUtc, acceptMs }) → [{ t0, freqHz, snr, text, eom, kind, raw }]
//   encode(text, freqHz) → Float32Array | { error }；encodeFrames(frames, freqHz)（原始酬載序列）同
// 回覆格式同既有：解碼 { id, mode, startUtc, results, ms } 或 { id, mode, startUtc, error }；編碼（{ text } 或 { frames }）回 { id, samples } 或 { id, error }
export function createJttyJobs(load, { now = () => performance.now() } = {}) {
  let ready = null;
  const codec = () => {
    ready ??= Promise.resolve().then(load).catch((err) => {
      ready = null; // 只有載入失敗才重試
      throw err;
    });
    return ready;
  };

  async function decode({ id, startUtc, samples, acceptMs }) {
    try {
      const t0 = now();
      const results = await (await codec()).decode(samples, { startUtc, acceptMs });
      return { id, mode: 'JTTY', startUtc, results: Array.isArray(results) ? results : [], ms: now() - t0 };
    } catch (err) {
      return { id, mode: 'JTTY', startUtc, error: err.message };
    }
  }

  // 回 { reply, transfer }：樣本以 transferable 送回
  // frames：原始酬載序列（add-jtty-utx：發話者 frame、UTX frame），有給就照序列編碼
  async function encode({ id, text, frames, freqHz }) {
    try {
      const c = await codec();
      const out = Array.isArray(frames) ? await c.encodeFrames(frames, freqHz) : await c.encode(text, freqHz);
      if (!(out instanceof Float32Array)) return { reply: { id, error: String(out?.error ?? 'encode failed') }, transfer: [] };
      return { reply: { id, samples: out }, transfer: [out.buffer] };
    } catch (err) {
      return { reply: { id, error: err.message }, transfer: [] };
    }
  }

  return { decode, encode };
}
