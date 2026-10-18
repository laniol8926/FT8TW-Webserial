// JTTY 強化編碼（UTX）接收端：一則訊息的 UTX 段增量解碼（add-jtty-utx design U3、U4）。純邏輯，不碰 DOM、不碰 WASM。
// 內容字配置與 padding 見 utxframes.mjs 檔頭。規則：
//   - 只有 S＝1 且類型＝001 的 frame 能開始一段；S＝1 但類型不是 001（保留）一律不收
//   - S＝0 只能接到進行中的段；段還沒開始（漏了第一個 frame）就不收
//   - 中間漏 frame（gap＞1）無法對齊位元流 → 停止、不完整
//   - 解出 U+FFFD（非法內容、保留控制碼、字表未載入）→ 停止、不完整；只保留 U+FFFD 之前的文字
//   - EOM 到時才以 lastIndexOf('0') 去掉 padding（之前去會吃掉資料結尾的 0）
// 呼叫前須已載入 UTX 字表（isUtxLoaded()），否則中文等會解成 U+FFFD 而停止。
import { MAGIC_BITS, decode as utxDecode } from '../js8/utx.mjs';
import { isUtxStart, isUtxContinuation, streamBitsOfWord } from './utxframes.mjs';

const REPLACEMENT = '�';

export class JttyUtxSegment {
  #stream = '';
  #text = '';
  #state = 'idle'; // idle → receiving → complete／incomplete

  /** 這個內容字能不能開始一段 UTX（S＝1、類型＝001） */
  static isStart(word) {
    return isUtxStart(word);
  }

  get state() {
    return this.#state;
  }

  get text() {
    return this.#text;
  }

  /** 已結束（完整或不完整）：之後的 frame 不再解 */
  get done() {
    return this.#state === 'complete' || this.#state === 'incomplete';
  }

  /**
   * 餵入一個保留 bit＝1 的 frame。
   * @param {{ word: number, eom?: boolean, gap?: number }} f gap：與前一個 frame 相隔幾個週期（assembler 的 frameGap，預設 1）
   * @returns {{ accepted: boolean, delta: string, state: string }} accepted＝false 表示這個 frame 不屬於本段（呼叫端另行處理或丟棄）
   */
  feed({ word, eom = false, gap = 1 }) {
    const w = word >>> 0;
    const reject = () => ({ accepted: false, delta: '', state: this.#state });
    if (this.#state === 'idle') {
      if (!isUtxStart(w)) return reject();
      this.#state = 'receiving';
    } else if (!isUtxContinuation(w)) {
      return reject(); // S＝1：另一則的開頭
    } else if (this.done) {
      return { accepted: true, delta: '', state: this.#state }; // 已停止：屬於本段但不再解
    } else if (gap > 1) {
      return this.#stop();
    }
    this.#stream += streamBitsOfWord(w);
    let bits = this.#stream;
    if (eom) {
      const cut = bits.lastIndexOf('0');
      if (cut < 0) return this.#stop();
      bits = bits.slice(0, cut);
    }
    if (bits.startsWith('11')) return this.#stop(); // 初始模式 3 保留
    const decoded = utxDecode(MAGIC_BITS + bits) ?? '';
    const bad = decoded.indexOf(REPLACEMENT);
    if (bad >= 0) return this.#stop(decoded.slice(0, bad));
    const delta = decoded.length > this.#text.length ? decoded.slice(this.#text.length) : '';
    this.#text = decoded.length > this.#text.length ? decoded : this.#text;
    if (eom) this.#state = 'complete';
    return { accepted: true, delta, state: this.#state };
  }

  /** 外部判定不完整（例如 assembler 逾時） */
  abort() {
    if (this.#state === 'receiving') this.#state = 'incomplete';
    return this.#state;
  }

  #stop(goodText = '') {
    let delta = '';
    if (goodText.length > this.#text.length) {
      delta = goodText.slice(this.#text.length);
      this.#text = goodText;
    }
    this.#state = 'incomplete';
    return { accepted: true, delta, state: this.#state };
  }
}

/**
 * 一個保留 bit＝1 的 frame 能不能被接受（給 assembler 用）。
 * openSegments：時間／頻率吻合、可接續的候選訊息上的 UTX 段（或 null＝該訊息只有呼號字、還沒有 UTX 段）。
 * @returns {'start'|'continue'|'drop'} start＝開新段（新訊息，或接在呼號字之後）；continue＝接到進行中的段；drop＝丟棄
 */
export function acceptsExtFrame(openSegments, frame) {
  const w = frame.word >>> 0;
  if (isUtxStart(w)) return 'start';
  if (!isUtxContinuation(w)) return 'drop';
  return (openSegments ?? []).some((s) => s && s.state === 'receiving') ? 'continue' : 'drop';
}
