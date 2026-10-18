// 一則 JS8 訊息的資料段組裝：依序餵入 data frame 的解包結果，
// 自動判別 legacy（逐 frame 文字串接）或 UTX（累積位元流、整串重解的增量解碼）。
// 移植自 FT8TW Js8DataAssembler.java。
import { looksLikeUtx, decode } from './utx.mjs';

export class Js8DataAssembler {
  #bits = '';
  #utx = false; // 第一個資料 frame 以 UTX magic 判定後鎖定
  #text = '';

  /** 餵入一個資料 frame 的解包結果；回傳本 frame 新增的顯示文字（UTX 邊界 frame 沒解出新字時回「…」） */
  feed(up) {
    if (!this.#utx && this.#bits.length === 0 && looksLikeUtx(up.dataBits)) this.#utx = true;
    if (this.#utx && up.dataBits != null) {
      this.#bits += up.dataBits;
      const decoded = decode(this.#bits);
      // decode 對前綴穩定（token 齊了才輸出），只會變長不會改寫
      if (decoded != null && decoded.length > this.#text.length) {
        const delta = decoded.slice(this.#text.length);
        this.#text = decoded;
        return delta;
      }
      return '…';
    }
    this.#text += up.text;
    return up.text;
  }

  /** 資料段是不是 UTX（強化編碼）：iGate 不轉（design D19） */
  get isUtx() {
    return this.#utx;
  }

  /** 目前組裝出的完整資料段文字 */
  get text() {
    return this.#text;
  }
}
