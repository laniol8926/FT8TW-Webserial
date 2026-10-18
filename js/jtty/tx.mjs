// JTTY 隨時發射（add-web-jtty jtty-chat「隨時發射」、design D9）：不經時槽。
// send(text | { text, frames })：編碼 → PTT on → PTT 延遲＋前置量（leadMs('JTTY')）後由 AudioContext 準時開始播 → 播完 PTT off。
// stop()：立即停音訊、放 PTT、清掉佇列。發射中送出的新訊息排在後面（上限 3）。
// 防護（15 分鐘監督、呼號允許清單）由注入的 guard 判斷：送出時與輪到發射時各查一次。
// 多則（add-jtty-utx U12 自動分則）：send({ parts: [{ text, frames }], restMs })——依序發射，第 2 則起先休息 restMs（PTT 放開，
//   狀態 resting）；休息前、休息後各查一次防護。一組只占 1 個佇列名額；stop() 連休息中與剩下的一起取消。
// PTT 介面同 tx/controller.mjs：{ active(), on({ expectedMs }), off(), delayMs(), leadMs(mode) }；沒有＝VOX。

export const MAX_QUEUE = 3;
export const PLAY_WATCHDOG_EXTRA_MS = 1500; // 同 tx/controller.mjs：onended 沒來就強制停止
const RATE = 12000;

const nonNeg = (v) => Math.max(0, Number(v) || 0);

export class JttyTxController {
  // encode(text, frames?) → Promise<Float32Array>（12 kHz、所有 frame 相位連續的一段）；
  //   frames：原始酬載序列（add-jtty-utx：發話者 frame、UTX frame），有給就照序列編碼，text 只用於顯示與防護
  // output：{ play(samples, { sampleRate, startPerfMs }) → Promise（播完或被停止時 resolve）, stop() }
  // guard({ text, now }) → 不能發的原因（字串）或 null；now()：校正後 UTC（ms）；utcToPerf(utc) → performance 時刻
  // onState(state, detail)：state ∈ queued／encoding／transmitting／resting／done／aborted／error／rejected；
  //   detail：{ text, queued, part?（{ i, n }）, error?, startUtc?, durationMs?, untilUtc?（resting：休息到何時）}
  constructor({ encode, output, ptt = null, guard = () => null, now = () => Date.now(), utcToPerf = null, onState = () => {},
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (id) => clearTimeout(id), sampleRate = RATE, maxQueue = MAX_QUEUE }) {
    Object.assign(this, { encode, output, ptt, guard, now, onState, setTimeoutFn, clearTimeoutFn, sampleRate, maxQueue });
    this.utcToPerf = utcToPerf ?? ((u) => performance.now() + (u - this.now()));
    this.queue = [];
    this.current = null; // 正在處理（編碼、發射或休息）的文字
    this.part = undefined; // 正在處理的是多則的第幾則（{ i, n }）
    this.restTimer = null;
    this.generation = 0; // stop() 加 1：還在 await 的舊流程醒來後看到世代變了就不再動作
    this.pttEngaged = false;
    this.watchdog = null;
  }

  get busy() {
    return this.current !== null;
  }

  get queued() {
    return this.queue.length;
  }

  // 畫面回呼出錯不能打斷發射流程（否則看門狗沒設、PTT 可能一直鍵著；code review 2026-10-09）
  emit(state, detail) {
    try {
      this.onState(state, { ...detail, queued: this.queue.length });
    } catch (err) {
      console.error('JTTY onState', err);
    }
  }

  // 佇列裡的「則」數（多則的第 2 則起不另外算）
  get queuedGroups() {
    return this.queue.filter((e) => !(e.part?.i > 1)).length;
  }

  // 回 null（已開始或已排隊）或不能發的原因：'empty'、'queueFull'、guard 的原因
  send(what) {
    const obj = what !== null && typeof what === 'object';
    if (obj && Array.isArray(what.parts)) return this.sendParts(what.parts, what.restMs);
    const msg = String((obj ? what.text : what) ?? '').trim();
    const frames = obj ? what.frames : undefined;
    return this.enqueue([{ text: msg, frames }]);
  }

  // 多則：parts 依序發，第 2 則起先休息 restMs
  sendParts(parts, restMs = 0) {
    const n = parts.length;
    const items = parts.map((p, k) => ({ text: String(p.text ?? '').trim(), frames: p.frames, ...(n > 1 ? { part: { i: k + 1, n } } : {}), restMs: k > 0 ? nonNeg(restMs) : 0 }));
    return this.enqueue(items);
  }

  enqueue(items) {
    if (!items.length || items.some((x) => !x.text)) return 'empty';
    const reason = this.guard({ text: items[0].text, now: this.now() });
    if (reason) return reason;
    if (this.busy) {
      if (this.queuedGroups >= this.maxQueue) return 'queueFull';
      this.queue.push(...items);
      for (const x of items) this.emit('queued', { text: x.text, part: x.part });
      return null;
    }
    const [first, ...rest] = items;
    this.queue.push(...rest);
    this.run(first.text, first.frames, first.part);
    return null;
  }

  // 停止：音訊與 PTT 立刻放，佇列一併清掉（Esc＝全部停）。沒在發射回 false
  stop(state = 'aborted', error = undefined) {
    if (!this.busy) return false;
    const text = this.current;
    const part = this.part;
    this.generation++;
    this.current = null;
    this.part = undefined;
    this.queue = [];
    this.clearWatchdog();
    if (this.restTimer !== null) this.clearTimeoutFn(this.restTimer);
    this.restTimer = null;
    this.output.stop();
    this.releasePtt();
    this.emit(state, { text, ...(part ? { part } : {}), ...(error === undefined ? {} : { error }) });
    return true;
  }

  async run(text, frames = undefined, part = undefined) {
    const gen = this.generation;
    this.current = text;
    this.part = part;
    const p = part ? { part } : {};
    this.emit('encoding', { text, ...p });
    let samples;
    try {
      const wave = await this.encode(text, frames);
      samples = wave instanceof Float32Array ? wave : wave.samples;
    } catch (err) {
      if (gen !== this.generation) return;
      this.current = null;
      this.part = undefined;
      this.emit('error', { text, ...p, error: err.message });
      this.next();
      return;
    }
    if (gen !== this.generation) return; // 編碼中被停止：不鍵 PTT
    const durationMs = (samples.length / this.sampleRate) * 1000;
    const ptt = this.ptt?.active?.() ? this.ptt : null;
    let startUtc = this.now();
    if (ptt) {
      const pre = nonNeg(ptt.delayMs?.()) + nonNeg(ptt.leadMs?.('JTTY'));
      this.pttEngaged = true;
      try {
        await ptt.on({ expectedMs: pre + durationMs });
      } catch (err) {
        if (gen === this.generation) this.stop('error', err.message);
        return;
      }
      if (gen !== this.generation) {
        // on 還在途中就按了停止：stop() 送的 off 可能比 on 早到電台，這裡再送一次確保放開
        Promise.resolve().then(() => ptt.off()).catch(() => {});
        return;
      }
      startUtc = this.now() + pre;
    }
    let done;
    try {
      done = this.output.play(samples, { sampleRate: this.sampleRate, startPerfMs: this.utcToPerf(startUtc) });
    } catch (err) {
      this.stop('error', err.message);
      return;
    }
    this.watchdog = this.setTimeoutFn(() => {
      if (gen === this.generation) this.stop('error', 'watchdog');
    }, startUtc - this.now() + durationMs + PLAY_WATCHDOG_EXTRA_MS);
    this.emit('transmitting', { text, ...p, startUtc, durationMs });
    await done;
    if (gen !== this.generation) return; // stop() 讓 play 提早 resolve：已處理過
    this.clearWatchdog();
    // 等 PTT off 送出再發下一則：否則下一則的 on 可能比這次的 off 先到電台（同 tx/controller.mjs 的 await releasePtt）
    await this.releasePtt();
    if (gen !== this.generation) return;
    this.current = null;
    this.part = undefined;
    this.emit('done', { text, ...p });
    this.next();
  }

  // 輪到佇列下一則：防護重新檢查（排隊時監督時間可能已到），不允許的逐則回報 rejected。
  // 多則的第 2 則起先休息（休息中算忙碌：Esc、關分頁都會停）；休息完再查一次防護
  next() {
    while (this.queue.length) {
      const item = this.queue.shift();
      const { text, frames, part } = item;
      const reason = this.guard({ text, now: this.now() });
      if (reason) {
        this.emit('rejected', { text, ...(part ? { part } : {}), error: reason });
        continue;
      }
      if (item.restMs > 0) this.rest(item);
      else this.run(text, frames, part);
      return;
    }
  }

  rest({ text, frames, part, restMs }) {
    const gen = this.generation;
    this.current = text;
    this.part = part;
    this.emit('resting', { text, ...(part ? { part } : {}), restMs, untilUtc: this.now() + restMs });
    this.restTimer = this.setTimeoutFn(() => {
      this.restTimer = null;
      if (gen !== this.generation) return;
      const reason = this.guard({ text, now: this.now() });
      if (!reason) {
        this.run(text, frames, part);
        return;
      }
      this.current = null;
      this.part = undefined;
      this.emit('rejected', { text, ...(part ? { part } : {}), error: reason });
      this.next();
    }, restMs);
  }

  clearWatchdog() {
    if (this.watchdog !== null) this.clearTimeoutFn(this.watchdog);
    this.watchdog = null;
  }

  // 回傳 off 送完時 resolve 的 Promise（失敗也 resolve）；stop() 不等它，正常發完會等
  releasePtt() {
    if (!this.pttEngaged) return Promise.resolve();
    this.pttEngaged = false;
    const ptt = this.ptt;
    return Promise.resolve().then(() => ptt.off()).catch(() => {});
  }
}
