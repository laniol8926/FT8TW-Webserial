// 時槽的撥號頻率快照（add-web-frequency-list D12、D13，code review 2026-10-09）。
// 回報與 SWL Log 的頻率要是「錄這個時槽時」的頻率，不是解碼完成那一刻的：收訊中換頻率，正在收的時槽不能用新頻率回報。
// main.mjs 在選的頻率、模式、CAT 實際頻率可能改變時 note()（時間用與樣本相同的接收 UTC），切出時槽時 slot() 取快照；
// 錄音期間頻率變了（時槽跨兩個頻率）→ freqChanged，該時槽只顯示、不回報 PSKReporter、不記 SWL Log。
import { bandOf } from './bands.mjs';

// 撥號頻率與波段（add-web-rig-control D14）：CAT 讀回的實際頻率優先，波段由它推得；
// 實際頻率不在業餘波段內 → 波段、頻率都是 null（回報暫停、SWL／ADIF 不寫 BAND，免得寫成選的頻率的波段）。
// 沒有 CAT 頻率 → 選的頻率（add-web-frequency-list D2）
export function dialInfoOf({ actualHz = null, band, selectedHz }) {
  if (!actualHz) return { band, dialHz: selectedHz };
  const b = bandOf(actualHz);
  return b ? { band: b, dialHz: actualHz } : { band: null, dialHz: null };
}

// 頻率世代的鍵：模式、選的頻率、CAT 實際頻率任何一個變了就不同
export function freqKey({ mode, selectedHz, actualHz = null }) {
  return `${mode}|${selectedHz ?? ''}|${actualHz ?? ''}`;
}

// 頻率變化的時間線：entries＝[{ at, key, info, gen }]（at 為接收 UTC，ms）
export class FreqTimeline {
  constructor({ keepMs = 120_000 } = {}) {
    this.keepMs = keepMs; // JS8 Slow 30 秒，留兩分鐘足夠
    this.entries = [];
    this.gen = 0;
  }

  get generation() {
    return this.gen;
  }

  // 目前的鍵與 dialInfo；與上一筆相同就不記（CAT 每 2 秒讀回同一個頻率不算改變）
  note(key, info, at) {
    const last = this.entries.at(-1);
    if (last && last.key === key) return false;
    if (last) this.gen += 1;
    this.entries.push({ at, key, info: { ...info }, gen: this.gen });
    // 清掉太舊的，但留 keepMs 之前的最後一筆當起點
    const cut = at - this.keepMs;
    while (this.entries.length > 1 && this.entries[1].at <= cut) this.entries.shift();
    return true;
  }

  // 錄音期間 [fromUtc, toUtc) 的快照：錄音開始時有效的頻率與世代；期間內有變化 → freqChanged
  slot(fromUtc, toUtc) {
    if (!this.entries.length) return { freq: null, freqGen: this.gen, freqChanged: false };
    let start = this.entries[0];
    for (const e of this.entries) if (e.at <= fromUtc) start = e;
    const freqChanged = this.entries.some((e, i) => i > 0 && e.at > fromUtc && e.at < toUtc); // 第一筆是起點，不是變化
    return { freq: { ...start.info }, freqGen: start.gen, freqChanged };
  }
}

// 這個時槽可以回報 PSKReporter、記 SWL Log 嗎（沒有快照＝開發掛鉤注入的結果，照舊）
export function slotRecordable(meta) {
  return !meta?.freqChanged;
}
