// 頻譜／瀑布圖的純邏輯（add-web-transmit D21、tasks 6.1～6.2）：分幀、自動增益、配色、頻率↔像素、
// 列時間索引、標籤文字。不碰 DOM，Node 可測；畫圖在 waterfall.mjs。
import { parseMessage } from '../ft8parse.mjs';

export const SAMPLE_RATE = 12000;
export const FFT_SIZE = 2048; // 5.86 Hz／bin
export const HOP = 1920; // 160 ms 一列（同 FT8TW：一列＝一個 FT8 symbol）
export const BIN_HZ = SAMPLE_RATE / FFT_SIZE;
export const PICK_MIN_HZ = 100; // spec：點選限制在 100–3000 Hz
export const PICK_MAX_HZ = 3000;

// 0..maxHz 需要幾個 bin（含 maxHz 所在的那個）
export function binsFor(maxHz) {
  return Math.min(FFT_SIZE / 2, Math.ceil(maxHz / BIN_HZ) + 1);
}

// ── 頻率 ↔ 像素（0 Hz 在左邊緣，maxHz 在右邊緣）──
export function freqToX(hz, width, maxHz) {
  return (hz / maxHz) * width;
}

export function xToFreq(x, width, maxHz) {
  return width > 0 ? (x / width) * maxHz : 0;
}

// 點選位置 → 發射聲音頻率：四捨五入到 1 Hz、限制在 [min, max]
export function pickFreq(x, width, maxHz, { min = PICK_MIN_HZ, max = PICK_MAX_HZ } = {}) {
  const hz = Math.round(xToFreq(x, width, maxHz));
  return Math.min(max, Math.max(min, hz));
}

// ── 配色：FT8TW WaterfallColorScheme.CLASSIC（黑→藍→青→白）──
// 原版用位移拼色，在段落交界會溢位到隔壁色版；這裡改成各段線性內插，外觀相同、端點正確。
export function classicColor(v) {
  const x = Math.min(255, Math.max(0, Math.round(v)));
  if (x < 128) return [0, 0, Math.round((x * 255) / 127)];
  if (x < 192) return [0, Math.round(((x - 128) * 255) / 63), 255];
  return [Math.round(((x - 192) * 255) / 63), 255, 255];
}

// 256 階 RGBA 查表（ImageData 直接用）
export function buildLut(color = classicColor) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let v = 0; v < 256; v++) {
    const [r, g, b] = color(v);
    lut.set([r, g, b, 255], v * 4);
  }
  return lut;
}

export function median(values, count = values.length) {
  if (count <= 0) return NaN;
  const a = Array.from(values.subarray ? values.subarray(0, count) : values.slice(0, count)).sort((p, q) => p - q);
  const m = count >> 1;
  return count % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ── 自動增益：黑點錨定雜訊地板（以每幀 dB 的中位數估計，強訊號拉不動），白點追蹤峰值 ──
// 範圍限制在 [minRangeDb, maxRangeDb]：沒訊號時不把雜訊放大成一片白，有強訊號時不把弱訊號壓成全黑。
export class Agc {
  constructor({ marginDb = 3, minRangeDb = 20, maxRangeDb = 45, floorAlpha = 0.2, peakAlpha = 0.05 } = {}) {
    Object.assign(this, { marginDb, minRangeDb, maxRangeDb, floorAlpha, peakAlpha });
    this.floor = null;
    this.peak = null;
  }

  // 用一幀 dB 更新，回傳 { lo, hi }
  update(db, count = db.length) {
    const med = median(db, count);
    let max = -Infinity;
    for (let i = 0; i < count; i++) if (db[i] > max) max = db[i];
    if (this.floor === null) {
      this.floor = med; // 第一幀直接就位，不要從固定初值慢慢爬（FT8TW 的教訓）
      this.peak = max;
    } else {
      this.floor += (med - this.floor) * this.floorAlpha;
      this.peak = max > this.peak ? max : this.peak + (max - this.peak) * this.peakAlpha;
    }
    return this.range();
  }

  range() {
    const lo = this.floor + this.marginDb;
    const hi = Math.min(lo + this.maxRangeDb, Math.max(lo + this.minRangeDb, this.peak));
    return { lo, hi };
  }

  reset() {
    this.floor = null;
    this.peak = null;
  }
}

// 使用者調整（同 FT8TW WaterfallAdjustDialog）：相對自動 AGC 的偏移，0／0＝完全照自動。
// 基準 zeroDb：黑點上移（往右把更多底噪壓黑）；對比 gainDb：動態範圍變窄（往右對比更強），最窄 6 dB
export const ADJUST_RANGE_DB = 20;
const MIN_ADJUSTED_RANGE_DB = 6;
export function adjustRange({ lo, hi }, { zeroDb = 0, gainDb = 0 } = {}) {
  const l = lo + zeroDb;
  return { lo: l, hi: l + Math.max(MIN_ADJUSTED_RANGE_DB, hi - lo - gainDb) };
}

// dB → 0..255 強度
export function toLevels(db, { lo, hi }, out = new Uint8Array(db.length), count = db.length) {
  const k = 255 / (hi - lo);
  for (let i = 0; i < count; i++) {
    const v = (db[i] - lo) * k;
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
  }
  return out;
}

// ── 分幀：worklet 每 40 ms 一段，湊滿 HOP 個新樣本才出一幀（含最近 FFT_SIZE 個樣本）──
// 時間不連續（掉音、重新開始）就重新累積，免得把兩段不相干的音訊接在同一幀。
export class Framer {
  constructor({ size = FFT_SIZE, hop = HOP, rate = SAMPLE_RATE, gapMs = 100 } = {}) {
    Object.assign(this, { size, hop, rate, gapMs });
    this.buf = new Float32Array(size);
    this.reset();
  }

  reset() {
    this.write = 0; // 環狀緩衝下一個寫入位置
    this.filled = 0; // 已累積的有效樣本（最多 size）
    this.sinceEmit = 0;
    this.endUtc = null; // 最後一個樣本之後的時刻
  }

  // samples 的第一個樣本在 utc；回傳這次湊出的幀 [{ samples, utc（幀最後一個樣本之後的時刻）}]
  push(samples, utc) {
    if (this.endUtc !== null && Math.abs(utc - this.endUtc) > this.gapMs) this.reset();
    const frames = [];
    const msPer = 1000 / this.rate;
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.write] = samples[i];
      this.write = (this.write + 1) % this.size;
      if (this.filled < this.size) this.filled++;
      this.sinceEmit++;
      if (this.filled === this.size && this.sinceEmit >= this.hop) {
        this.sinceEmit = 0;
        // 依時間順序攤平：write 指向最舊的樣本
        const frame = new Float32Array(this.size);
        frame.set(this.buf.subarray(this.write));
        frame.set(this.buf.subarray(0, this.write), this.size - this.write);
        frames.push({ samples: frame, utc: utc + (i + 1) * msPer });
      }
    }
    this.endUtc = utc + samples.length * msPer;
    return frames;
  }
}

// ── 列時間索引：瀑布圖每一列的 UTC（環狀），slot 線與訊息標記都以 UTC 對應到列 ──
export class RowClock {
  constructor(capacity) {
    this.capacity = capacity;
    this.utc = new Float64Array(capacity);
    this.count = 0; // 累計寫過幾列；第 r 列（絕對編號）存在 r % capacity
  }

  add(utc) {
    this.utc[this.count % this.capacity] = utc;
    return this.count++;
  }

  get oldest() {
    return Math.max(0, this.count - this.capacity);
  }

  at(row) {
    return this.utc[row % this.capacity];
  }

  // 第一個 UTC ≥ utc 的列（絕對編號）；比最新一列還晚 → null。列時間須遞增（新列一律在後）
  rowAtOrAfter(utc) {
    let lo = this.oldest;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.at(mid) < utc) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.count ? lo : null;
  }

  clear() {
    this.count = 0;
  }
}

// ── 頻譜頁的偏好（localStorage）：標記訊息開關、顯示調整（基準、對比） ──
const PREFS_KEY = 'ft8tw.spectrum';
export function loadSpectrumPrefs(storage) {
  let saved = {};
  try {
    saved = JSON.parse(storage.getItem(PREFS_KEY) ?? '{}') ?? {};
  } catch {
    saved = {};
  }
  const adjust = (v) => (Number.isInteger(v) && Math.abs(v) <= ADJUST_RANGE_DB ? v : 0);
  return {
    markMessages: typeof saved.markMessages === 'boolean' ? saved.markMessages : true,
    zeroDb: adjust(saved.zeroDb),
    gainDb: adjust(saved.gainDb),
  };
}

export function saveSpectrumPrefs(storage, prefs) {
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 無痕模式等：只是下次不會記得
  }
}

// ── 標籤 ──
const pad = (n) => String(n).padStart(2, '0');

// FT8TW：slot 分隔線下方印「UTC : hh:mm:ss ↑ 時序 ↑」（邊界時間，不是畫的當下）
export function slotLabel(utcStart, parity) {
  const d = new Date(utcStart);
  return `UTC : ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ↑ ${parity} ↑`;
}

// 時序（0／1）：slot 起點除以週期的奇偶
export function slotParity(utcStart, periodMs) {
  return Math.floor(utcStart / periodMs) % 2 === 0 ? 0 : 1;
}

// 標在瀑布圖上的文字：能判斷發送者就標呼號，否則標原訊息（自由文字等）
export function markLabel(text) {
  return parseMessage(text)?.sender ?? String(text).trim();
}

// 標記顏色（FT8TW colors.xml）：呼叫我 calling_me_dark、CQ cq_callsign、其他 calling_callsign
export const MARK_COLORS = { me: '#ff8ad8', cq: '#00ff00', other: '#ffcc66' };
export function markColor(text, myCall = '') {
  const tokens = String(text).trim().toUpperCase().split(/\s+/);
  if (myCall && tokens[0] === myCall.toUpperCase()) return MARK_COLORS.me;
  if (tokens[0] === 'CQ') return MARK_COLORS.cq;
  return MARK_COLORS.other;
}

// 頻率尺：每 step Hz 一個刻度，major 的倍數印 "500Hz"
export function rulerTicks(maxHz, { step = 100, major = 500 } = {}) {
  const ticks = [];
  for (let hz = 0; hz <= maxHz; hz += step) ticks.push({ hz, major: hz % major === 0, label: hz % major === 0 ? `${hz}Hz` : null });
  return ticks;
}

// 頻率標籤間隔：窄畫面（手機、左欄）標籤會擠在一起，依寬度放大到每 1000／1500 Hz 一個
export function labelStep(width, maxHz, { minGapPx = 56, steps = [500, 1000, 1500, 3000] } = {}) {
  return steps.find((s) => (s / maxHz) * width >= minGapPx) ?? steps[steps.length - 1];
}
