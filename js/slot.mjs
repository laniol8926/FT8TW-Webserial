// 依 UTC 把 12 kHz 樣本切成 slot（tasks 3.2）。每段樣本都帶自己的 UTC 時間戳記，
// 切割時以涵蓋該時刻的那一段定位，所以音效卡時脈與系統時鐘的漂移不會累積。
// JS8 多速度（add-web-js8-chat D4）：每個速度一個 SlotCutter，共用同一個 SampleBuffer，由 MultiCutter 只 push 一次。
import { periodMs as js8PeriodMs, captureWindow as js8CaptureWindow, startDelayMs as js8StartDelayMs, submodeInfo } from './js8/submodes.mjs';

export const SLOT_MS = { FT8: 15000, FT4: 7500, JS8: 15000, FT2: 3750 }; // FT2：FT8TW 自訂（add-web-transmit D3）；JS8 為 Normal

// slot 長度：JS8 依 submode（省略＝0 Normal，即 SLOT_MS.JS8），其他模式不看 submode
// 依 UTC 時槽切音訊的模式；JTTY 是串流模式（add-web-jtty D4、D15），不建 SlotCutter
export function isSlotMode(mode) {
  return Object.hasOwn(SLOT_MS, mode);
}

// 開始接收、接收中換模式時狀態列的「等待中」文字（i18n key）：時槽模式等第一個完整 slot，JTTY 等第一個串流視窗
export function waitingStateKey(mode) {
  return isSlotMode(mode) ? 'page.state.waiting_slot' : 'page.state.waiting_stream';
}

export function slotMsFor(mode, submode = 0) {
  return mode === 'JS8' ? js8PeriodMs(submode) : SLOT_MS[mode];
}

// 每個 slot 送解碼的擷取窗：預設就是 slot 本身；JS8 同 FT8TW Js8Receiver，自 slot 起點前 1 秒起擷取
// 「1 秒提前量＋起始延遲＋79 符號音訊＋0.7 秒餘裕」（Normal 14.84 秒），送出時 startUtc 仍是 slot 起點
export function captureWindow(mode, submode = 0) {
  return mode === 'JS8' ? js8CaptureWindow(submode) : { leadMs: 0, durationMs: SLOT_MS[mode] };
}
const RATE = 12000;

export function slotStartFor(utcMs, mode, submode = 0) {
  const period = slotMsFor(mode, submode);
  return Math.floor(utcMs / period) * period;
}

export class SampleBuffer {
  constructor({ capacitySeconds = 60, rate = RATE, gapToleranceMs = 50 } = {}) {
    this.capacityMs = capacitySeconds * 1000;
    this.rate = rate;
    this.gapToleranceMs = gapToleranceMs;
    this.clear();
  }

  clear() {
    this.chunks = []; // { utc, samples }，時間上連續
  }

  durationOf(n) {
    return (n * 1000) / this.rate;
  }

  endUtcOf(i) {
    const c = this.chunks[i];
    return c.utc + this.durationOf(c.samples.length);
  }

  get startUtc() {
    return this.chunks.length ? this.chunks[0].utc : null;
  }

  get endUtc() {
    const last = this.chunks[this.chunks.length - 1];
    return last ? last.utc + this.durationOf(last.samples.length) : null;
  }

  // 與上一段接不起來（掉音、裝置重啟）就清空：寧可少解一個 slot，也不要拼出錯位的資料
  push(samples, utc) {
    if (this.chunks.length && Math.abs(utc - this.endUtc) > this.gapToleranceMs) this.clear();
    this.chunks.push({ utc, samples: Float32Array.from(samples) });
    while (this.chunks.length > 1 && this.endUtc - this.chunks[1].utc >= this.capacityMs) this.chunks.shift();
  }

  // 時鐘差重新量測後，把已收的樣本改用新的時鐘差標記，與之後的段落接得上
  shift(deltaMs) {
    for (const c of this.chunks) c.utc += deltaMs;
  }

  // 切出 [startUtc, startUtc+durationMs) 的樣本；沒有完整涵蓋就回傳 null
  extract(startUtc, durationMs) {
    const need = Math.round((durationMs * this.rate) / 1000);
    // 起點之前的最後一段。每段的時間戳記各自換算、有幾 ms 抖動，段與段之間可能有小空隙；
    // 起點落在空隙時不能當成「沒涵蓋」（瀏覽器實測因此整個 slot 被跳過），改從下一段開頭接
    let i = -1;
    for (let k = 0; k < this.chunks.length && this.chunks[k].utc <= startUtc; k++) i = k;
    if (i < 0) return null;
    let offset = Math.round(((startUtc - this.chunks[i].utc) * this.rate) / 1000);
    if (offset >= this.chunks[i].samples.length) {
      if (startUtc - this.endUtcOf(i) > this.gapToleranceMs || i + 1 >= this.chunks.length) return null;
      i += 1;
      offset = 0;
    }
    const out = new Float32Array(need);
    let filled = 0;
    for (let k = i; k < this.chunks.length && filled < need; k++) {
      const part = this.chunks[k].samples.subarray(offset, offset + (need - filled));
      out.set(part, filled);
      filled += part.length;
      offset = 0;
    }
    return filled === need ? out : null;
  }
}

export class SlotCutter {
  // leadPadMs：slot 開頭缺多少以內仍補 0 照解（FT8 訊號在 slot 開始 0.5 秒後才出現）；JS8 另加擷取窗的 1 秒提前量。
  // submode：只有 mode 'JS8' 時有意義（省略＝0 Normal，行為與單一速度時相同）
  constructor({ mode, submode = 0, onSlot, onSkip = () => {}, leadPadMs = 400, buffer = new SampleBuffer() }) {
    submodeInfo(submode); // 非法 submode 建構時就丟錯
    this.mode = mode;
    this.submode = submode;
    this.onSlot = onSlot;
    this.onSkip = onSkip;
    this.leadPadMs = leadPadMs;
    this.buffer = buffer;
    this.next = null;
  }

  get period() {
    return slotMsFor(this.mode, this.submode);
  }

  get window() {
    return captureWindow(this.mode, this.submode);
  }

  // 開頭可補 0 的上限（不含擷取窗提前量）。JS8 不超過該速度的起始延遲：Fast 200、Turbo／4S 100 ms
  // 之後就有訊號，補 0 會蓋掉訊號開頭；Normal／Slow 的 500 ms 大於預設 400，維持原本的 400
  get padMs() {
    return this.mode === 'JS8' ? Math.min(this.leadPadMs, js8StartDelayMs(this.submode)) : this.leadPadMs;
  }

  // 回呼帶的 slot 資訊：JS8 多帶 submode，讓解碼結果分速度組訊息
  tag(startUtc) {
    return this.mode === 'JS8' ? { mode: this.mode, submode: this.submode, startUtc } : { mode: this.mode, startUtc };
  }

  setMode(mode, submode = this.submode) {
    submodeInfo(submode);
    this.mode = mode;
    this.submode = submode;
    const end = this.buffer.endUtc;
    if (end === null) {
      this.next = null;
      return;
    }
    // 切換模式通常也換了頻率：之前的音訊屬於舊模式，從下一個擷取窗完整落在之後的 slot 開始
    const { leadMs } = this.window;
    const s = slotStartFor(end + leadMs, mode, submode);
    this.next = s - leadMs === end ? s : s + this.period;
  }

  feed(samples, utc) {
    this.buffer.push(samples, utc);
    this.drain();
  }

  // 依緩衝現有的樣本切出所有已收齊的擷取窗。多個速度共用緩衝時由 MultiCutter push 一次後逐一呼叫
  drain() {
    if (this.buffer.endUtc === null) return;
    const { leadMs, durationMs } = this.window;
    if (this.next === null) {
      const start = this.buffer.startUtc;
      const s = slotStartFor(start + leadMs, this.mode, this.submode);
      this.next = start - (s - leadMs) <= this.padMs + leadMs ? s : s + this.period;
    }
    while (this.buffer.endUtc >= this.next - leadMs + durationMs) {
      const samples = this.cut(this.next - leadMs, durationMs);
      if (samples) this.onSlot({ ...this.tag(this.next), samples });
      // 時間戳記說已涵蓋、樣本數卻還差一點（段間小空隙累積）：再等最多 gapToleranceMs，不要直接放棄
      else if (this.buffer.endUtc < this.next - leadMs + durationMs + this.buffer.gapToleranceMs) break;
      else this.onSkip({ ...this.tag(this.next), reason: 'not-covered', bufferStart: this.buffer.startUtc, bufferEnd: this.buffer.endUtc });
      this.next += this.period;
    }
  }

  // 切出 [windowStart, windowStart+durationMs)；開頭缺 padMs 以內補 0
  cut(windowStart, durationMs) {
    const whole = this.buffer.extract(windowStart, durationMs);
    if (whole) return whole;
    const bufStart = this.buffer.startUtc;
    const missing = bufStart - windowStart;
    // 擷取窗的提前量（JS8 1 秒）內本來就沒有訊號，可以補 0
    if (missing <= 0 || missing > this.padMs + this.window.leadMs) return null;
    const tail = this.buffer.extract(bufStart, durationMs - missing);
    if (!tail) return null;
    const out = new Float32Array(Math.round((durationMs * RATE) / 1000));
    out.set(tail, out.length - tail.length);
    return out;
  }
}

// 多個速度共用一個 SampleBuffer（design D4）：每段樣本只 push 一次，再讓每個 SlotCutter 各自依自己的 slot 與擷取窗切。
// 介面與 SlotCutter 相同的部分（feed、buffer）讓呼叫端可以照舊 clear／shift 緩衝
export class MultiCutter {
  constructor({ buffer = new SampleBuffer(), cutters = [] } = {}) {
    this.buffer = buffer;
    this.list = [];
    this.setCutters(cutters);
  }

  get cutters() {
    return [...this.list];
  }

  // 換啟用的速度（「同時解碼其他速度」開關、換發射速度）。原有的 cutter 保留進度；
  // 新加入的若緩衝已有音訊，從緩衝結尾之後第一個完整的擷取窗開始，不重解加入前就收到的舊音訊
  setCutters(cutters) {
    for (const c of cutters) if (c.buffer !== this.buffer) throw new Error('SlotCutter must use the shared SampleBuffer');
    const old = new Set(this.list);
    for (const c of cutters) if (!old.has(c) && this.buffer.endUtc !== null) c.setMode(c.mode, c.submode);
    this.list = [...cutters];
  }

  feed(samples, utc) {
    this.buffer.push(samples, utc);
    for (const c of this.list) c.drain();
  }
}
