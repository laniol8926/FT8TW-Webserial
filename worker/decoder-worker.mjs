// 解碼 Worker（tasks 3.2、6.5）：在背景執行 WASM，不阻塞畫面。
// 收 { id, mode, startUtc, samples, probe? }，回 { id, mode, startUtc, results, ms } 或 { id, error }（JS8 探測忙碌時回 { id, busy: true }）。
// 發射（add-web-transmit D1）：收 { id, kind: 'encode', text, mode, freqHz, freeText }（JS8 改帶 frame: { payload, itype }），
// 回 { id, samples } 或 { id, error }。
// JTTY（add-web-jtty）：解碼收 { id, mode:'JTTY', samples, startUtc, acceptMs }，回 { id, mode, startUtc, results:[{ t0, freqHz, snr, text, eom, kind, raw }], ms }；
// 編碼收 { id, kind:'encode', mode:'JTTY', text, freqHz }（一則訊息的所有 frame 一段相位連續音訊），回 { id, samples } 或 { id, error }；
// 強化編碼／發話者 frame（add-jtty-utx）改帶 frames:[{ hi, lo }]（原始酬載序列）取代 text。
// FT8／FT4 的 results 是文字訊息；JS8 的 results 是 frame（payload 轉文字在主執行緒組訊息，tasks 6.4）。
import { createFt8Decoder } from '../decoder/ft8decoder.mjs';
import { createJs8Decoder, js8Dt, payloadHex } from '../decoder/js8decoder.mjs';
import { createJttyJobs } from '../js/jtty/worker-jobs.mjs';

const ready = createFt8Decoder(new URL('../wasm/ft8tw-decoder.mjs', import.meta.url));
let js8Ready = null; // 第一次收到 JS8 才載入（多數人只用 FT8／FT4）

async function decodeJs8(samples, submode = 0) {
  js8Ready ??= createJs8Decoder(new URL('../wasm/ft8tw-js8.mjs', import.meta.url)).catch((err) => {
    js8Ready = null; // 只有載入失敗才重試；解碼失敗不必重載 WASM
    throw err;
  });
  const decoder = await js8Ready;
  return decoder.decode(samples, { submode }).map((f) => ({
    timeSec: js8Dt(f.timeSec, submode), // 與 FT8 的 DT 同義：相對名目發射起點（各速度起始延遲不同）
    freqHz: f.freqHz,
    snr: f.snr,
    itype: f.itype,
    payload: payloadHex(f.payload),
  }));
}

// FT2（FT8TW 自訂，add-web-transmit D3）：每個樣本重複一次（2× 拉伸）交 FT4 解碼器，再把頻率×2、時間÷2 還原（同 FT8TW）
async function decodeFt2(samples) {
  const stretched = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) stretched[2 * i] = stretched[2 * i + 1] = samples[i];
  return (await ready).decode(stretched, { protocol: 'FT4', useHash: true })
    .map((r) => ({ ...r, freqHz: r.freqHz * 2, timeSec: r.timeSec / 2 }));
}

// JTTY（add-web-jtty D3）：第一次選 JTTY 才載入解碼器模組；佇列由主執行緒的 StreamCutter 控制（一次一筆）
const jtty = createJttyJobs(() => import('../decoder/jttydecoder.mjs').then((m) => m.createJttyCodec()));

self.onmessage = async ({ data }) => {
  if (data.mode === 'JTTY') {
    if (data.kind === 'encode') {
      const { reply, transfer } = await jtty.encode(data);
      self.postMessage(reply, transfer);
    } else self.postMessage(await jtty.decode(data));
    return;
  }
  if (data.kind === 'encode') {
    try {
      let samples;
      if (data.mode === 'JS8') {
        js8Ready ??= createJs8Decoder(new URL('../wasm/ft8tw-js8.mjs', import.meta.url)).catch((err) => {
          js8Ready = null;
          throw err;
        });
        samples = (await js8Ready).encode(Uint8Array.from(data.frame.payload), data.frame.itype, { freqHz: data.freqHz, submode: data.submode ?? 0 });
      } else {
        samples = (await ready).encode(data.text, { mode: data.mode, freqHz: data.freqHz, freeText: data.freeText });
      }
      self.postMessage({ id: data.id, samples }, [samples.buffer]);
    } catch (err) {
      self.postMessage({ id: data.id, error: err.message });
    }
    return;
  }
  if (data.mode === 'JS8') return data.probe ? probeJs8(data) : enqueueJs8(data);
  await decodeOne(data);
};

// probe：時間偏差掃描的探測（add-dt-offset-advisor D6）。假設的延遲多半是錯的，解出的呼號不寫回雜湊表（useHash:false：
// WASM 改用空的雜湊介面，不查也不存、不淘汰），免得錯位音訊的誤解碼污染一般解碼的 <...> 呼號還原
async function decodeOne({ id, mode, startUtc, samples, submode, probe = false }) {
  try {
    const t0 = performance.now();
    let results;
    if (mode === 'JS8') results = await decodeJs8(samples, submode ?? 0);
    else if (mode === 'FT2') results = await decodeFt2(samples);
    else results = (await ready).decode(samples, { protocol: mode, useHash: !probe });
    self.postMessage({ id, mode, startUtc, submode, results, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, mode, startUtc, submode, error: err.message });
  }
}

// JS8 多速度（design D5）：所有速度依序解（WASM 內 g_wf 依 nsps 重建，是全域狀態），佇列上限 3，滿了丟最舊的並回報
export const JS8_QUEUE_LIMIT = 3;
const js8Queue = [];
let js8Busy = false;
function enqueueJs8(job) {
  js8Queue.push(job);
  while (js8Queue.length > JS8_QUEUE_LIMIT) {
    const old = js8Queue.shift();
    self.postMessage({ id: old.id, mode: 'JS8', startUtc: old.startUtc, submode: old.submode, dropped: true });
  }
  if (!js8Busy) runJs8();
}
// 時間偏差掃描的 JS8 探測（add-dt-offset-advisor D23）：不進佇列（上限 3 會擠掉一般週期、觸發 dropped）。
// 佇列有工作或正在解就回 busy，主執行緒下一個 NOR 週期再試；空閒時直接解（WASM 解碼是同步的，不會和佇列交錯）
function probeJs8(job) {
  if (js8Busy || js8Queue.length) {
    self.postMessage({ id: job.id, mode: 'JS8', startUtc: job.startUtc, submode: job.submode, busy: true });
    return undefined;
  }
  return decodeOne(job);
}
// 每筆之前讓出一次事件迴圈（macrotask）：WASM 解碼是同步的，不讓出的話新進的 postMessage 進不了 js8Queue，上限 3 永遠不會生效
const yieldToEvents = () => new Promise((r) => setTimeout(r, 0));
async function runJs8() {
  js8Busy = true;
  for (;;) {
    await yieldToEvents();
    const job = js8Queue.shift();
    if (!job) break;
    await decodeOne(job);
  }
  js8Busy = false;
}
