// JTTY 串流切窗（add-web-jtty jtty-receiver「串流解碼」、design D4）：不依 UTC 時槽，
// 每 2.0 s 從 SampleBuffer 取最近 4.0 s 送解碼。視窗起點對齊 2 s 格點、每次恰好前進 2000 ms（與 poll 的時機無關），
// 逾時（JttyAssembler.tick）以視窗前 2.0 s 為準；解碼器的接受區再往後多 OVERLAP_MS（2.1＋1.888≤4.0）：
// 細調後的起點在相鄰視窗會差幾個樣本，落在 2 s 格點上的 frame 原本可能兩個視窗都不收（2026-10-09 code review 實測）。
// 放寬後格點附近的 frame 可能兩個視窗都收到，由 JttyReceiver 去重。
// 佇列：一筆在 Worker 解碼中，最多 2 筆等待；再多就丟最舊的等待並計數（規格「解碼跟不上」）。

export const STEP_MS = 2000;
export const WINDOW_MS = 4000;
export const ACCEPT_MS = 2000;
export const MAX_WAITING = 2;
export const OVERLAP_MS = 100;

export class StreamCutter {
  // buffer：{ startUtc, endUtc, extract(startUtc, ms) → Float32Array|null }（SampleBuffer）
  // send(job)：交給 Worker（job.samples 是新配置的陣列，可轉移）；onDropped(job)：等待中的被丟掉
  // onDropped(job|null)：null 表示落後太多、沒切就跳過的視窗（計數已加進 dropped）
  // 收訊診斷（jtty/diag.mjs，只觀測）：onSkip(startUtc) 緩衝有空洞切不出的視窗；onRealign({ fromUtc, toUtc }) 緩衝清空後重新對齊、跳過的範圍
  constructor({ buffer, send, onDropped = () => {}, onSkip = () => {}, onRealign = () => {}, stepMs = STEP_MS, windowMs = WINDOW_MS, acceptMs = ACCEPT_MS, overlapMs = OVERLAP_MS, maxWaiting = MAX_WAITING }) {
    Object.assign(this, { buffer, send, onDropped, onSkip, onRealign, stepMs, windowMs, acceptMs, overlapMs, maxWaiting });
    this.nextId = 1;
    this.dropped = 0; // 來不及解而丟掉的視窗（給狀態列）
    this.skipped = 0; // 緩衝有空洞切不出來的視窗
    this.reset();
  }

  reset() {
    this.nextStart = null;
    this.waiting = [];
    this.inFlight = null;
  }

  get busy() {
    return this.inFlight !== null;
  }

  // 有新樣本進緩衝後呼叫：切出所有已湊滿的視窗
  poll() {
    const { startUtc, endUtc } = this.buffer;
    if (startUtc === null || endUtc === null) return;
    // 第一次（含 reset 後）、或緩衝清空（掉音）後起點已不在緩衝內：重新對齊格點，從最近一個湊滿的視窗開始
    // （切到 JTTY 時緩衝裡已有的舊音訊不回頭解，也不算丟棄）
    if (this.nextStart === null || this.nextStart < startUtc) {
      const prev = this.nextStart;
      const first = Math.ceil(startUtc / this.stepMs) * this.stepMs;
      this.nextStart = Math.max(first, Math.floor((endUtc - this.windowMs) / this.stepMs) * this.stepMs);
      if (prev !== null) this.onRealign({ fromUtc: prev, toUtc: this.nextStart });
    }
    const ready = Math.floor((endUtc - this.windowMs - this.nextStart) / this.stepMs) + 1;
    if (ready <= 0) return;
    // 落後很多（背景分頁）時只切最近的「解碼中＋等待上限」個，其餘反正會被丟，直接計入丟棄
    const keep = this.maxWaiting + 1;
    if (ready > keep) {
      this.dropped += ready - keep;
      this.nextStart += (ready - keep) * this.stepMs;
      this.onDropped(null);
    }
    for (let i = Math.min(ready, keep); i > 0; i--) {
      const start = this.nextStart;
      this.nextStart += this.stepMs;
      const samples = this.buffer.extract(start, this.windowMs);
      if (!samples) {
        this.skipped++;
        this.onSkip(start);
        continue;
      }
      this.enqueue({
        id: this.nextId++, mode: 'JTTY', startUtc: start, samples,
        windowMs: this.windowMs, acceptMs: this.acceptMs, decodeAcceptMs: this.acceptMs + this.overlapMs, acceptUntilUtc: start + this.acceptMs,
        timeShiftMs: 0,
      });
    }
  }

  // 時鐘修正（SampleBuffer.shift 之後）：已收的樣本改了時間標記，視窗跟著移，接續前一個視窗（不重新對齊格點、不丟視窗）。
  // 等待中的還沒送 Worker：直接改起點；解碼中的 Worker 用舊起點算 t0，記下修正量，回來時由 JttyReceiver 加上
  shift(deltaMs) {
    if (this.nextStart !== null) this.nextStart += deltaMs;
    for (const job of this.waiting) {
      job.startUtc += deltaMs;
      job.acceptUntilUtc += deltaMs;
    }
    if (this.inFlight) {
      this.inFlight.timeShiftMs += deltaMs;
      this.inFlight.acceptUntilUtc += deltaMs;
    }
  }

  enqueue(job) {
    if (!this.inFlight) {
      this.dispatch(job);
      return;
    }
    this.waiting.push(job);
    while (this.waiting.length > this.maxWaiting) {
      this.dropped++;
      this.onDropped(this.waiting.shift());
    }
  }

  dispatch(job) {
    this.inFlight = job;
    this.send(job);
  }

  // Worker 回覆（解完或失敗）：出佇列、送下一筆。回傳那筆 job（job.acceptUntilUtc 之前起點的 frame 都已送達，
  // 可交給 JttyAssembler.tick）；不認得的 id（reset 前的回覆）回 null
  done(id) {
    if (!this.inFlight || this.inFlight.id !== id) return null;
    const job = this.inFlight;
    this.inFlight = null;
    const next = this.waiting.shift();
    if (next) this.dispatch(next);
    return job;
  }
}
