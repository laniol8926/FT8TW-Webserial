// JTTY 接收接線（add-web-jtty jtty-receiver「串流解碼」、design D4）：StreamCutter 切窗 → Worker 解碼 → 組合器。
// 主程式只要：音訊塊進 SampleBuffer 後 poll()、SampleBuffer.shift() 後 reset()、Worker 回覆交給 onResult()。
// Worker 的訊息 id 與其他解碼工作共用一個流水號（nextWorkerId），這裡對照回 StreamCutter 自己的 id。
import { StreamCutter } from './stream.mjs';
import { JttyAssembler } from './assembler.mjs';
import { audioLevel } from './diag.mjs';

// 相鄰視窗的重疊區（StreamCutter OVERLAP_MS）可能解出同一個 frame：起點差 ≤100 ms、頻率差 <16 Hz、內容相同（有 raw 比 raw，
// 否則比文字與 EOM）就是重複
export const DUP_TIME_MS = 100;
export const DUP_FREQ_HZ = 16;
export function sameFrame(a, b) {
  if (Math.abs(a.t0 - b.t0) > DUP_TIME_MS || Math.abs(a.freqHz - b.freqHz) >= DUP_FREQ_HZ) return false;
  if (a.raw !== undefined && b.raw !== undefined) return a.raw === b.raw;
  return a.text === b.text && a.eom === b.eom && a.kind === b.kind;
}

// 解碼器輸出的 frame 只留介面約定的欄位（Wave C：{ t0, freqHz, snr, text, eom, kind, raw }；
// 擴充 frame（kind 'ext'，add-jtty-utx）另留 ext、word、call 給組合器）
export function cleanFrame(f) {
  if (!f || !Number.isFinite(f.t0) || !Number.isFinite(f.freqHz) || typeof f.text !== 'string') return null;
  const kind = f.kind ?? 'text';
  const ext = kind === 'ext'
    ? { ext: f.ext, ...(typeof f.call === 'string' && f.call ? { call: f.call } : {}), ...(Number.isInteger(f.word) ? { word: f.word >>> 0 } : {}) }
    : {};
  return {
    t0: f.t0, freqHz: f.freqHz, snr: Number.isFinite(f.snr) ? f.snr : null, text: f.text, eom: Boolean(f.eom),
    kind, ...ext, ...(f.raw !== undefined ? { raw: f.raw } : {}),
  };
}

const hasUtxFrame = (frames) => frames.some((f) => f.kind === 'ext' && f.ext === 'utx');
const hasParityFrame = (frames) => frames.some((f) => f.kind === 'ext' && f.ext === 'parity');

// 解碼列表的內容欄：P1 不解 STRUCT30（D7），附上原始酬載供 P2 對照；
// 擴充 frame：UTX 顯示這個 frame 解出的字（組合器寫的 utxText）＋標籤、發話者 frame 顯示呼號（標籤由呼叫端依語系給）
// 糾錯 frame（add-jtty-fec）顯示 parityTag
export function frameText(f, { utxTag = '[UTX]', senderText = (call) => `[DE ${call}]`, parityTag = '[FEC]' } = {}) {
  if (f.kind === 'ext') {
    if (f.ext === 'sender') return senderText(f.call ?? '');
    if (f.ext === 'parity') return parityTag;
    return f.utxText ? `${f.utxText} ${utxTag}` : utxTag;
  }
  if (f.kind !== 'struct' || f.raw === undefined || f.raw === null) return f.text;
  const raw = typeof f.raw === 'number' ? `0x${f.raw.toString(16).toUpperCase()}` : String(f.raw);
  return `${f.text} ${raw}`;
}

export class JttyReceiver {
  // buffer：主程式共用的 SampleBuffer；post(job, transfer)：送 Worker；nextWorkerId()：主程式的流水號
  // onMessage(snapshot)：組合器的訊息更新（泡泡）；onFrames(frames, job)：每個視窗解出的 frame（解碼列表）
  // onDropped(count)：來不及解而丟掉視窗；onError(message, job)：Worker 回錯誤
  // utxReady()：UTX 字表已載入回 true，否則回載入中的 Promise（add-jtty-utx：含 UTX frame 的結果等字表載入後才組合，
  //   之後到的結果排在後面依序處理；載入失敗也照常處理，UTX 段解不出字就以不完整結束）
  // diag：收訊診斷（jtty/diag.mjs 的 JttyDiag，只觀測）；now()：量 Worker 往返用的單調時鐘
  // loadCodec()：載入主執行緒的 WASM codec（Promise；糾錯修復 add-jtty-fec 用 unpack 檢查文法）。建立時就開始載入；
  //   含糾錯 frame 的結果等它載入後才組合（同 utxReady）；沒給或載入失敗就不修復
  constructor({ buffer, post, nextWorkerId, onMessage = () => {}, onFrames = () => {}, onDropped = () => {}, onError = () => {}, utxReady = () => true,
    diag = null, now = () => performance.now(), loadCodec = null, ...opts }) {
    Object.assign(this, { post, nextWorkerId, onFrames, onError, utxReady, diag, now });
    this.codec = null;
    this.codecLoading = loadCodec ? Promise.resolve().then(loadCodec).then((c) => { this.codec = c; }).catch(() => {}) : null;
    this.pending = []; // 等字表的結果：{ frames, job, tickUtc }
    this.generation = 0; // stop() 加 1：等字表的流程醒來後看到世代變了就不處理
    this.ids = new Map(); // Worker id → StreamCutter id
    this.cutter = new StreamCutter({
      buffer,
      send: (job) => this.dispatch(job),
      onDropped: (job) => {
        this.noteDropped(job);
        onDropped(this.cutter.dropped);
      },
      onSkip: (startUtc) => diag?.event('skipped', { startUtc }),
      onRealign: (range) => diag?.event('realign', range),
      ...opts,
    });
    this.droppedSeen = 0; // 診斷：上次記到的丟棄數（落後太多一次丟好幾個時算出個數）
    this.asm = new JttyAssembler({ onUpdate: onMessage, unpack: loadCodec ? (hi, lo) => this.codec?.unpack(hi, lo) ?? null : null });
    this.recent = []; // 最近視窗收過的 frame（去重用）
  }

  // 診斷：丟掉的視窗（等待中被擠掉的有起點；落後太多沒切的，起點從 nextStart 往回推）
  noteDropped(job) {
    const n = this.cutter.dropped - this.droppedSeen;
    this.droppedSeen = this.cutter.dropped;
    if (!this.diag) return;
    const startUtc = job ? job.startUtc : this.cutter.nextStart - n * this.cutter.stepMs;
    this.diag.event('dropped', { startUtc, n });
  }

  dispatch(job) {
    const id = this.nextWorkerId();
    this.ids.set(id, job.id);
    const { samples, startUtc, decodeAcceptMs, windowMs } = job;
    if (this.diag) {
      job.sentAt = this.now(); // 樣本轉移給 Worker 之前量電平
      job.level = audioLevel(samples);
    }
    this.post({ id, mode: 'JTTY', samples, startUtc, acceptMs: decodeAcceptMs, windowMs }, [samples.buffer]);
  }

  get dropped() {
    return this.cutter.dropped;
  }

  owns(workerId) {
    return this.ids.has(workerId);
  }

  poll() {
    this.cutter.poll();
  }

  // 緩衝改了時間標記（時鐘修正，SampleBuffer.shift 之後）：視窗接續、解碼中與等待中的都保留，
  // 接收中的訊息與去重紀錄一起改用新時間（不再像 reset 那樣丟掉，免得每次重新校時都漏收）
  shift(deltaMs) {
    if (!deltaMs) return;
    this.diag?.event('clockShift', { ms: Math.round(deltaMs), utc: this.cutter.nextStart });
    this.cutter.shift(deltaMs);
    this.asm.shift(deltaMs);
    for (const f of this.recent) f.t0 += deltaMs;
  }

  // 視窗重新對齊；還在 Worker 的那筆回來時對不上 id，丟掉
  reset() {
    this.cutter.reset();
    this.ids.clear();
    this.recent = [];
  }

  // 去掉與前一個視窗重複的 frame，並記下這個視窗的（只留起點在這個視窗前一個視窗之後的）
  dedup(frames, job) {
    const out = [];
    for (const f of frames) if (!this.recent.some((g) => sameFrame(f, g)) && !out.some((g) => sameFrame(f, g))) out.push(f);
    const since = job.startUtc + job.timeShiftMs - job.windowMs;
    this.recent = [...this.recent.filter((g) => g.t0 >= since), ...out];
    return out;
  }

  // Worker 回覆：{ id, results?, error? }。不是這個接收器的（或 reset 前的）回 false
  onResult(data) {
    const cutterId = this.ids.get(data.id);
    if (cutterId === undefined) return false;
    this.ids.delete(data.id);
    const job = this.cutter.done(cutterId);
    if (!job) return false;
    let frames = [];
    let pairs = [];
    if (data.error) this.onError(data.error, job);
    else {
      const shiftMs = job.timeShiftMs ?? 0; // Worker 送出後時鐘修正過：t0 改用新時間
      pairs = (data.results ?? []).map((r) => [r, cleanFrame(r)]).filter(([, f]) => f).map(([r, f]) => [r, shiftMs ? { ...f, t0: f.t0 + shiftMs } : f]);
      frames = this.dedup(pairs.map(([, f]) => f), job);
    }
    if (this.diag) this.noteWindow(job, data, pairs, frames);
    this.handle({ frames, job, tickUtc: job.acceptUntilUtc }); // 逾時用資料時間（Wave B 約定）
    return true;
  }

  // 診斷：每個視窗的摘要（解碼器的 sync／nsync／nsymerr 在 cleanFrame 前取）
  noteWindow(job, data, pairs, frames) {
    const kept = new Set(frames);
    this.diag.window({
      startUtc: job.startUtc + (job.timeShiftMs ?? 0),
      roundTripMs: Number.isFinite(job.sentAt) ? this.now() - job.sentAt : null,
      workerMs: data.ms,
      candidates: (data.results ?? []).length,
      frames: pairs.map(([r, f]) => ({ t0: f.t0, freqHz: f.freqHz, snr: f.snr, sync: r.sync, nsync: r.nsync, nsymerr: r.nsymerr, kind: f.kind, dup: !kept.has(f) })),
      dropped: this.cutter.dropped,
      skipped: this.cutter.skipped,
      ...(job.level ?? {}),
      ...(data.error ? { error: data.error } : {}),
    });
  }

  // 組合（ext frame 由組合器標出 dropped／utxText）→ 解碼列表只列沒被丟棄的 → 推進逾時。
  // 字表還沒載入且有 UTX frame（或糾錯 frame 而 codec 還沒載入），或前面還有暫存的：排進暫存，載入後依序處理
  handle(item) {
    if (this.pending.length) {
      this.pending.push(item); // 已在等
      return;
    }
    // 糾錯 frame 可能補回 UTX frame：也要字表；另外要 codec
    const parity = hasParityFrame(item.frames);
    const waits = [];
    if (hasUtxFrame(item.frames) || parity) {
      const u = this.utxReady();
      if (u !== true) waits.push(Promise.resolve(u).catch(() => {}));
    }
    if (parity && !this.codec && this.codecLoading) waits.push(this.codecLoading);
    if (!waits.length) {
      this.process(item);
      return;
    }
    this.pending.push(item);
    const gen = this.generation;
    Promise.all(waits).catch(() => {}).then(() => {
      if (gen !== this.generation) return;
      const items = this.pending;
      this.pending = [];
      for (const it of items) this.process(it);
    });
  }

  process({ frames, job, tickUtc }) {
    if (frames.length) {
      this.asm.pushAll(frames);
      const shown = frames.filter((f) => f.dropped !== true);
      if (shown.length || job) this.onFrames(shown, job);
    } else if (job) this.onFrames(frames, job);
    if (tickUtc !== null && tickUtc !== undefined) this.asm.tick(tickUtc);
  }

  // 本機開發掛鉤：不經 Worker 直接餵 frame（瀏覽器檢查用）
  inject(frames, upToUtc = null) {
    this.handle({ frames: frames.map(cleanFrame).filter(Boolean), job: null, tickUtc: upToUtc });
  }

  // 離開 JTTY、停止接收：接收中的訊息不再完成（不通知），視窗不再切，等字表的結果丟掉
  stop() {
    this.generation++;
    this.pending = [];
    this.cutter.reset();
    this.ids.clear();
    this.asm.clear();
    this.recent = [];
  }
}
