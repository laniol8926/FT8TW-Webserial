// 發射控制（add-web-transmit 1.5～1.7）：按下發射後，在每個所選奇偶的 slot 發射目前的訊息，
// 直到按停止、安全防護擋下（每個 slot 重新檢查，含發射監管 15 分鐘）或編碼失敗。
// 時間一律用校正後 UTC；提前 PREPARE_MS 編碼並交給 AudioContext 排程，實際起點由 AudioContext 時間軸決定（D5）。
import { nextTxSlot, txTiming } from './scheduler.mjs';
import { txBlockReason } from './guard.mjs';
import { t } from '../i18n/index.mjs';
import { rigErrorText } from '../rig/errors.mjs';

export const PREPARE_MS = 1500;
// 播放看門狗（同 FT8TW：音訊長度＋1500 ms）：onended 沒來（裝置拔除、AudioContext 被系統暫停）就強制停止
export const PLAY_WATCHDOG_EXTRA_MS = 1500;
// 音訊結尾離 slot 結束至少留這麼多：輸出延遲估計不準時，尾巴才不會越界進到對方時序
export const END_MARGIN_MS = 500;
// JS8 一則訊息最多幾個 frame（40×15 s＝10 分鐘，在發射監管 15 分鐘內）
export const MAX_JS8_FRAMES = 40;
const RATE = 12000;
const MODES = ['FT8', 'FT4', 'FT2'];
// JS8 多 frame 訊息在連續 slot 依序發完就停（不分奇偶、不重複），由 buildJs8Frames 把文字拆成 frame

export class TxController {
  // encode(text 或 { frame }, { mode, freqHz, freeText }) → Promise<{ samples }>；output：TxOutput（play／stop）
  // buildJs8Frames(text) → [{ payload, itype }]（沒有提供時 JS8 不能發射）
  // ptt（add-web-rig-control D12、D13，可省略＝VOX）：{ active() 這次要不要控制 PTT, on({ expectedMs }), off(), delayMs(), leadMs(mode) }
  constructor({ utcNow, utcToPerf, getParams, encode, output, buildJs8Frames = null, onState = () => {}, ptt = null,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (id) => clearTimeout(id) }) {
    Object.assign(this, { utcNow, utcToPerf, getParams, encode, output, buildJs8Frames, onState, ptt, setTimeoutFn, clearTimeoutFn });
    this.pttEngaged = false;
    this.wakeup = null;
    this.js8 = null; // { frames, index }
    // 通聯驅動（2.5）：driver(slot) → { text } 本輪要發的訊息、null 本輪不發、{ stop, reason } 結束、
    // { retryMs } 上一輪還沒解碼完，稍後再問（遲到發射仍受截止與結尾餘量限制）；沒有 driver 時發固定訊息
    this.driver = null;
    this.active = false;
    this.startedAt = null;
    this.timer = null;
    this.generation = 0;
    this.endedNormally = false; // 上一次發射是否正常發完（JS8 多 frame 全部送完）；中途停止、防護停止為 false
  }

  blockReason(p, startedAt) {
    const supported = MODES.includes(p.mode) || (p.mode === 'JS8' && this.buildJs8Frames);
    if (!supported) return t('tx.notSupported', { mode: p.mode });
    return txBlockReason({ ...p, startedAt, now: this.utcNow() });
  }

  // 回傳不能開始的原因，可以開始時回 null
  start() {
    if (this.active) return t('tx.alreadyActive');
    const p = this.getParams();
    let reason = this.blockReason(p, null);
    this.js8 = null;
    if (!reason && p.mode === 'JS8') {
      try {
        const frames = this.buildJs8Frames(p.text);
        // 上限：發射監管時間內發得完（Slow 30 s slot × 40 會超過 15 分鐘監管，發到一半被停）
        const slotMs = txTiming('JS8', p.submode ?? 0).slotMs;
        const max = p.supervisionMs > 0 ? Math.min(MAX_JS8_FRAMES, Math.floor(p.supervisionMs / slotMs)) : MAX_JS8_FRAMES;
        if (frames.length > max) reason = t('tx.js8TooLong', { n: frames.length, max });
        else if (frames.length) this.js8 = { frames, index: 0 };
        else reason = t('tx.js8NoFrames');
      } catch (err) {
        reason = t('tx.js8Error', { msg: err.message });
      }
    }
    if (reason) {
      this.onState({ active: false, transmitting: false, error: reason });
      return reason;
    }
    this.active = true;
    this.endedNormally = false;
    this.startedAt = this.utcNow();
    this.locked = { mode: p.mode, audioHz: p.audioHz, submode: p.submode ?? 0 }; // 發射中模式不可變；JS8 多 frame 的聲音頻率、速度也不可變
    this.generation += 1;
    this.onState({ active: true, transmitting: false, error: null });
    this.scheduleNext();
    return null;
  }

  // done：正常發完（不是被停止）；在 onState 之前設好，onActiveChange 讀得到
  stop(error = null, { done = false } = {}) {
    this.endedNormally = done;
    this.active = false;
    this.generation += 1;
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.wakeup?.(); // 正在等 PTT 時刻：叫醒，讓 fire() 結束
    this.wakeup = null;
    this.output.stop();
    this.releasePtt();
    this.onState({ active: false, transmitting: false, error });
  }

  // minUtc：至少從這個時間之後找 slot（剛放棄的 slot 不能再選到）
  scheduleNext(minUtc = 0) {
    if (!this.active) return;
    const p = this.getParams();
    const slot = nextTxSlot({ nowUtc: Math.max(this.utcNow(), minUtc), mode: p.mode, parity: this.js8 ? null : p.parity, submode: p.submode ?? 0 });
    const gen = this.generation;
    this.onState({ active: true, transmitting: false, error: null, nextSlot: slot.slotStart });
    this.timer = this.setTimeoutFn(() => this.fire(slot, gen), Math.max(0, slot.startUtc - PREPARE_MS - this.utcNow()));
  }

  async fire(slot, gen) {
    this.timer = null;
    if (!this.active || gen !== this.generation) return;
    const p = this.getParams();
    const reason = this.blockReason(p, this.startedAt);
    if (reason) return this.stop(reason);
    if (p.mode !== this.locked.mode) return this.stop(t('tx.modeChanged'));
    if (this.js8 && p.audioHz !== this.locked.audioHz) return this.stop(t('tx.js8FreqChanged'));
    if (this.js8 && (p.submode ?? 0) !== this.locked.submode) return this.stop(t('tx.js8SpeedChanged'));
    let text = p.text;
    if (this.driver && !this.js8) {
      let m;
      try {
        m = this.driver(slot);
      } catch (err) {
        return this.stop(t('tx.qsoFlowError', { msg: err.message }));
      }
      if (m?.retryMs) {
        // 過了截止就不再等：當作本輪不發
        if (this.utcNow() + m.retryMs <= slot.slotStart + txTiming(p.mode, p.submode ?? 0).cutoffMs) {
          this.timer = this.setTimeoutFn(() => this.fire(slot, gen), m.retryMs);
          return;
        }
        m = null;
      }
      if (m?.stop) {
        this.stop();
        this.onState({ active: false, transmitting: false, error: null, message: m.reason ?? t('tx.qsoEnded') });
        return;
      }
      if (!m) {
        this.onState({ active: true, transmitting: false, error: null });
        return this.scheduleNext(slot.slotStart + txTiming(p.mode, p.submode ?? 0).slotMs); // 本輪不發，等下一個同奇偶 slot
      }
      text = m.text;
    }
    let wave;
    try {
      wave = this.js8
        ? await this.encode({ frame: this.js8.frames[this.js8.index] }, { mode: 'JS8', freqHz: p.audioHz, submode: p.submode ?? 0 })
        : await this.encode(text, { mode: p.mode, freqHz: p.audioHz, freeText: this.driver ? false : p.freeText });
    } catch (err) {
      return this.stop(t('tx.cannotTx', { msg: err.message }));
    }
    if (!this.active || gen !== this.generation) return;
    // 編碼完成時重新檢查時間：整段音訊必須在本 slot 結束前播完，否則會延伸到對方的時序（等於時槽外發射）
    const startUtc = Math.max(slot.startUtc, this.utcNow());
    const durationMs = (wave.samples.length / RATE) * 1000;
    if (startUtc + durationMs + END_MARGIN_MS > slot.slotStart + txTiming(p.mode, p.submode ?? 0).slotMs) {
      this.onState({ active: true, transmitting: false, error: t('tx.tooLate') });
      return this.scheduleNext(slot.slotStart + txTiming(p.mode, p.submode ?? 0).cutoffMs + 1);
    }
    // CAT／RTS／DTR（D12）：PTT 開在音訊起點前「PTT 延遲＋模式提前量」；送出後至少等 PTT 延遲才播
    const ptt = this.ptt?.active?.() ? this.ptt : null;
    let audioStart = startUtc;
    try {
      if (ptt) {
        const delay = Math.max(0, ptt.delayMs());
        const wait = startUtc - delay - ptt.leadMs(p.mode) - this.utcNow();
        if (wait > 0) {
          await new Promise((resolve) => {
            this.wakeup = resolve;
            this.timer = this.setTimeoutFn(() => { this.timer = null; resolve(); }, wait);
          });
          this.wakeup = null;
          if (!this.active || gen !== this.generation) return;
        }
        // 遲到時鍵 PTT 之前就把 PTT 延遲＋提前量算進去：播不完就不鍵（不會鍵一下又放開，安全審查 #6）
        const earliest = Math.max(startUtc, this.utcNow() + delay + ptt.leadMs(p.mode));
        if (earliest + durationMs + END_MARGIN_MS > slot.slotStart + txTiming(p.mode, p.submode ?? 0).slotMs) {
          this.onState({ active: true, transmitting: false, error: t('tx.tooLate') });
          return this.scheduleNext(slot.slotStart + txTiming(p.mode, p.submode ?? 0).cutoffMs + 1);
        }
        this.pttEngaged = true;
        try {
          await ptt.on({ expectedMs: Math.max(0, startUtc - this.utcNow()) + delay + durationMs });
        } catch (err) {
          if (!this.active || gen !== this.generation) return; // 已停止（或已重新開始）：不蓋掉原因、不停掉新的發射（#7）
          return this.stop(t('tx.pttFailed', { msg: rigErrorText(err) }));
        }
        if (!this.active || gen !== this.generation) return;
        audioStart = Math.max(startUtc, this.utcNow() + delay);
        if (audioStart + durationMs + END_MARGIN_MS > slot.slotStart + txTiming(p.mode, p.submode ?? 0).slotMs) {
          await this.releasePtt();
          this.onState({ active: true, transmitting: false, error: t('tx.tooLate') });
          return this.scheduleNext(slot.slotStart + txTiming(p.mode, p.submode ?? 0).cutoffMs + 1);
        }
      }
      let done;
      try {
        done = this.output.play(wave.samples, { sampleRate: RATE, startPerfMs: this.utcToPerf(audioStart) });
      } catch (err) {
        return this.stop(t('tx.cannotTx', { msg: err.message }));
      }
      const frame = this.js8?.frames[this.js8.index];
      const part = this.js8 ? t('tx.part', { i: this.js8.index + 1, n: this.js8.frames.length }) : '';
      // JS8 顯示正在送的 frame 文字（不是輸入框目前的內容）
      const shown = frame ? (frame.text ?? p.text) : text;
      this.onState({ active: true, transmitting: true, error: null, slotStart: slot.slotStart, text: shown, mode: p.mode, audioHz: p.audioHz, part });
      const watchdog = this.setTimeoutFn(() => {
        if (this.active && gen === this.generation) this.stop(t('tx.watchdog'));
      }, audioStart - this.utcNow() + durationMs + PLAY_WATCHDOG_EXTRA_MS);
      await done;
      this.clearTimeoutFn(watchdog);
    } finally {
      // 音訊播完或任何中途離開：PTT 一定關（D13）。世代變了＝stop() 已經關過，不能關到新一輪的 PTT
      if (gen === this.generation) await this.releasePtt();
    }
    if (!this.active || gen !== this.generation) return;
    if (this.js8 && ++this.js8.index >= this.js8.frames.length) {
      this.stop(null, { done: true });
      this.onState({ active: false, transmitting: false, error: null, message: t('tx.js8Done') });
      return;
    }
    this.onState({ active: true, transmitting: false, error: null });
    this.scheduleNext();
  }

  // PTT 關（只在這次真的開過時送；stop() 與 fire() 的 finally 都會呼叫，不重複送）
  releasePtt() {
    if (!this.pttEngaged) return Promise.resolve();
    this.pttEngaged = false;
    return Promise.resolve().then(() => this.ptt.off()).catch(() => {});
  }
}
