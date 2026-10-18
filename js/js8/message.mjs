// JS8 跨 frame 訊息組裝：把解碼器每輪輸出的 frame 依「submode＋頻率桶＋First/Last 旗標」組成訊息。
// 行為對照 FT8TW Js8Receiver.handleFrame / emit / flushStalled 與 Js8RxKey.bucketKey；
// Android 端的副作用（聊天紀錄、自動回覆、PSKReporter、iGate、自己回授的判斷）不在此，由呼叫端處理。
import { unpackFrame, isChecksummedCmd, stripChecksum16, TYPE_FIRST, TYPE_LAST } from './varicode.mjs';
import { Js8DataAssembler } from './assembler.mjs';
import { loadJscWords } from './jsc.mjs';
import { loadUtxTable } from './utx.mjs';

/** 未完成訊息超過這麼多輪（該 submode 自己的 slot 數）沒有續 frame 就以不完整送出 */
export const STALL_SLOTS = 3;
/** 頻率桶寬（Hz）：同一台的多個 frame 頻率估計會有一點誤差 */
export const FREQ_BUCKET_HZ = 10;
const SUBMODE_STRIDE = 100000;

/** 組裝緩衝 key：一定要帶 submode，同頻率的 NORMAL 與 TURBO 是不同的兩台（Java float 運算） */
export function bucketKey(submode, freqHz) {
  return submode * SUBMODE_STRIDE + Math.round(Math.fround(Math.fround(freqHz) / FREQ_BUCKET_HZ));
}

/** 解碼前載入 JS8 需要的兩份字表（JSC 詞表、UTX 字表）；重複呼叫無害 */
export function loadJs8Tables(fetchLike = globalThis.fetch) {
  return Promise.all([loadJscWords(fetchLike), loadUtxTable(fetchLike)]);
}

function joinPhraseData(phrase, data) {
  if (phrase === '') return data;
  if (data === '') return phrase;
  return phrase + (phrase.endsWith(' ') ? '' : ' ') + data;
}

function newMessage(frame, submode, utcMs) {
  return {
    text: '', callsignFrom: '', callsignTo: '', grid: '', isCq: false, isHeartbeat: false,
    directedCmd: -1, snr: frame.snr, freqHz: frame.freqHz, complete: false, submode, utcMs,
  };
}

// Java HashMap<Integer,…> 的走訪順序（flushStalled 同輪送出多則時的先後要與 Java 相同）：
// 依 (h ^ h>>>16) & (容量-1) 排，同一格內維持插入順序；容量隨歷史最大筆數倍增、不縮小。
function javaHashOrder(map, maxSize) {
  let cap = 16;
  while (maxSize > cap * 0.75) cap *= 2;
  const slot = (h) => (h ^ (h >>> 16)) & (cap - 1);
  return [...map.entries()].map((e, i) => [slot(e[0]), i, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

/**
 * 用法：每輪解碼完呼叫一次 processCycle(該輪 frames, submode)，即使該輪沒有 frame 也要呼叫（逾時靠輪數計）。
 * frame：{ payload: Uint8Array(9), itype, snr, freqHz }（js8decoder 的輸出即可）。
 */
export class Js8MessageAssembler {
  #now;
  #schedules = new Map(); // submode → { cycleCount, pending: Map<bucket, pm>, maxSize }

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  #schedule(submode) {
    let s = this.#schedules.get(submode);
    if (!s) {
      s = { cycleCount: 0, pending: new Map(), maxSize: 0 };
      this.#schedules.set(submode, s);
    }
    return s;
  }

  /**
   * 處理一輪解碼結果。回傳：
   *   messages：本輪送出的訊息（收到 Last、被新訊息蓋掉、或逾時），依送出先後
   *   frames：[{ frame, up, text }]，每個 frame 的解包結果與本 frame 的顯示文字（即時捲動用）
   *   error：與 Java 相同，某個 frame 解包丟例外時本輪其餘 frame 與逾時檢查都略過，例外放這裡
   */
  processCycle(frames, submode = 0) {
    const s = this.#schedule(submode);
    const messages = [];
    const handled = [];
    let error = null;
    s.cycleCount++;
    try {
      for (const frame of frames) handled.push(this.#handleFrame(frame, s, submode, messages));
      this.#flushStalled(s, messages);
    } catch (e) {
      error = e;
    }
    return { messages, frames: handled, error };
  }

  /** 尚未收齊的訊息快照（即時預覽用；complete 一律 false） */
  pending(submode = 0) {
    const s = this.#schedules.get(submode);
    if (!s) return [];
    return [...s.pending.values()].map((pm) => ({ ...pm.msg }));
  }

  #handleFrame(frame, s, submode, messages) {
    const up = unpackFrame(frame.payload, frame.itype);
    const bucket = bucketKey(submode, frame.freqHz);
    const first = (frame.itype & TYPE_FIRST) !== 0;
    const last = (frame.itype & TYPE_LAST) !== 0;

    let pm = s.pending.get(bucket);
    if (first || !pm) {
      // First 開新訊息；沒有 First 也沒有進行中的訊息（漏收開頭）也開一個
      if (pm && pm.msg.text !== '') messages.push(this.#emit(pm, false)); // 舊的被蓋掉 → 以不完整送出
      pm = {
        msg: newMessage(frame, submode, this.#now()), lastSeenCycle: 0,
        checksummedCmd: -1, phraseText: '', data: new Js8DataAssembler(),
      };
      s.pending.set(bucket, pm);
      s.maxSize = Math.max(s.maxSize, s.pending.size);
    }
    pm.lastSeenCycle = s.cycleCount;

    // 片語（directed/heartbeat）與資料段分開累積：checksum 只驗資料段，顯示時再組合
    let text;
    if (up.isData) {
      text = pm.data.feed(up);
    } else {
      pm.phraseText += (pm.phraseText === '' ? '' : ' ') + up.text;
      text = up.text;
    }
    const m = pm.msg;
    m.text = joinPhraseData(pm.phraseText, pm.data.text);
    if (m.callsignFrom === '') m.callsignFrom = up.callsignFrom;
    if (up.isCq) m.isCq = true;
    if (up.isHeartbeat) m.isHeartbeat = true;
    if (up.directedCmd >= 0) {
      m.directedCmd = up.directedCmd;
      m.callsignTo = up.callsignTo;
      if (isChecksummedCmd(up.directedCmd)) pm.checksummedCmd = up.directedCmd;
    }
    if (m.grid === '' && up.grid !== '') m.grid = up.grid;
    if (frame.snr > m.snr) m.snr = frame.snr;

    if (last) {
      s.pending.delete(bucket);
      messages.push(this.#emit(pm, true));
    }
    return { frame, up, text };
  }

  #flushStalled(s, messages) {
    const stalled = [];
    for (const [bucket, pm] of javaHashOrder(s.pending, s.maxSize)) {
      if (s.cycleCount - pm.lastSeenCycle >= STALL_SLOTS) {
        stalled.push(pm);
        s.pending.delete(bucket);
      }
    }
    for (const pm of stalled) if (pm.msg.text !== '') messages.push(this.#emit(pm, false));
  }

  // 含緩衝指令（MSG／轉發等）的完整訊息：資料段尾端 3 碼 checksum 驗過就剝除，失敗保留原文加註 ✗
  #emit(pm, complete) {
    const m = pm.msg;
    m.complete = complete;
    const dataText = pm.data.text;
    if (complete && pm.checksummedCmd >= 0 && dataText !== '') {
      const stripped = stripChecksum16(dataText);
      m.text = stripped !== null ? joinPhraseData(pm.phraseText, stripped) : joinPhraseData(pm.phraseText, dataText) + ' ✗';
    }
    return { ...m, utx: pm.data.isUtx }; // utx：資料段是強化編碼（iGate 不轉，design D19）
  }
}
