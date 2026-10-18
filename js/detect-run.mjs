// 自動偵測的錄音與解碼流程（design D15）。純邏輯在 detect.mjs；這裡依賴瀏覽器 API，以真瀏覽器檢查驗證。
// 同時開所有輸入、各錄一個依 UTC 對齊的完整 FT8 slot，FT8 解一次、切成兩個 7.5 秒用 FT4 各解一次、
// 補成 JS8 擷取窗用 JS8 解一次。
// 同時開啟被拒（部分瀏覽器不允許同時開多個輸入）的，之後逐一重試。
import { t } from './i18n/index.mjs';
import { AUDIO_CONSTRAINTS } from './audio.mjs';
import { ensureRunning } from './audioctx.mjs';
import { js8WindowFromFt8Slot, rmsOf, splitFt4 } from './detect.mjs';
import { SLOT_MS, SlotCutter, slotStartFor } from './slot.mjs';
import { ContextClock, contextTimeToEpoch, isContinuation } from './timemap.mjs';

const CAPTURE_TIMEOUT_MS = 40_000; // 最長：等到下一個 slot 邊界（≤15 秒）＋錄一個 slot（15 秒）＋餘裕

// 偵測專用的解碼 Worker：promise 介面，用完就關，不影響接收用的那個
function createDecoder() {
  const worker = new Worker(new URL('../worker/decoder-worker.mjs', import.meta.url), { type: 'module' });
  const pending = new Map();
  let nextId = 1;
  let failed = null; // 載入失敗後送出的訊息不會有回應，要直接拒絕，否則偵測永遠等下去
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.results);
  };
  worker.onerror = (e) => {
    failed = new Error(e.message ?? t('page.detect.load_failed'));
    for (const p of pending.values()) p.reject(failed);
    pending.clear();
  };
  return {
    decode(samples, mode) {
      if (failed) return Promise.reject(failed);
      const id = nextId++;
      const copy = Float32Array.from(samples); // 同一段要解兩種模式，不能 transfer 原本的
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, mode, startUtc: 0, samples: copy }, [copy.buffer]);
      });
    },
    close: () => worker.terminate(),
  };
}

// 開一個輸入並錄一個 FT8 slot；回傳 { samples } 或 { error }
// align（只供本機開發測試）：把第一個樣本對齊到下一個 slot 邊界，讓從 slot 邊界錄起的測試音檔解得出來
async function captureOne(ctx, input, { mediaDevices, clockOffsetMs, timeoutMs, notice, align }) {
  let stream;
  try {
    stream = await mediaDevices.getUserMedia(AUDIO_CONSTRAINTS(input.deviceId));
  } catch (err) {
    return { error: err.name === 'NotReadableError' ? t('page.detect.busy') : err.message || err.name, retry: true };
  }
  try {
    await ensureRunning(ctx, { notice });
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'ft8tw-capture', { numberOfOutputs: 1 });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    let contextClock = new ContextClock();
    let prevContextTime = null;
    const samples = await new Promise((resolve) => {
      // 自動播放被擋時 context 停在 suspended、沒有樣本；收到第一段（使用者點了）才重新計時
      let timer = setTimeout(() => resolve(null), timeoutMs);
      const cutter = new SlotCutter({
        mode: 'FT8',
        onSlot: (slot) => {
          clearTimeout(timer);
          resolve(slot.samples);
        },
      });
      let shift = null;
      node.port.onmessage = ({ data }) => {
        // 串流中斷：時間換算重來、緩衝清空（同 main.mjs）
        if (!isContinuation(prevContextTime, data.contextTime)) {
          contextClock = new ContextClock();
          cutter.buffer.clear();
        }
        prevContextTime = data.contextTime;
        const utc = contextTimeToEpoch(ctx, contextClock, data.contextTime) + clockOffsetMs;
        if (shift === null) {
          shift = align ? slotStartFor(utc, 'FT8') + SLOT_MS.FT8 - utc : 0;
          clearTimeout(timer);
          timer = setTimeout(() => resolve(null), timeoutMs);
        }
        cutter.feed(data.samples, utc + shift);
      };
    });
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    return samples ? { samples } : { error: t('page.detect.timeout') };
  } catch (err) {
    // 單一輸入失敗不要讓 Promise.all 整個中斷（其他輸入的麥克風會開到逾時才關）
    return { error: err.message || err.name };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// inputs：[{ deviceId, label }]（已排除別名）。回傳每個輸入的結果，供 detect.mjs 的 pickBest／summarize 使用
export async function runDetection({ inputs, mediaDevices, clockOffsetMs = 0, notice, onProgress = () => {}, timeoutMs = CAPTURE_TIMEOUT_MS, align = false }) {
  const ctx = new AudioContext();
  const decoder = createDecoder();
  try {
    await ctx.audioWorklet.addModule(new URL('../worklet/capture.mjs', import.meta.url));
    const opts = { mediaDevices, clockOffsetMs, timeoutMs, notice, align };

    onProgress(t('page.detect.recording', { n: inputs.length }));
    const captured = await Promise.all(inputs.map((input) => captureOne(ctx, input, opts)));
    // 同時開被拒的，逐一重試
    for (let i = 0; i < inputs.length; i++) {
      if (!captured[i].retry) continue;
      onProgress(t('page.detect.retry', { label: inputs[i].label }));
      captured[i] = await captureOne(ctx, inputs[i], opts);
    }

    onProgress(t('page.detect.decoding'));
    const results = [];
    for (let i = 0; i < inputs.length; i++) {
      const { deviceId, label } = inputs[i];
      const c = captured[i];
      if (c.error) {
        results.push({ deviceId, label, error: c.error });
        continue;
      }
      const ft8 = (await decoder.decode(c.samples, 'FT8')).length;
      let ft4 = 0;
      for (const half of splitFt4(c.samples)) ft4 += (await decoder.decode(half, 'FT4')).length;
      const js8 = (await decoder.decode(js8WindowFromFt8Slot(c.samples), 'JS8')).length;
      results.push({ deviceId, label, ft8, ft4, js8, rms: rmsOf(c.samples) });
    }
    return results;
  } finally {
    decoder.close();
    await ctx.close().catch(() => {});
  }
}
