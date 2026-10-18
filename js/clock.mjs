// 時鐘量測與校正（design D4、web-decoder spec「時鐘差」）。
// 向轉送站 /time 取伺服器 UTC：每次量 5 個樣本、取往返最短者，誤差估計＝往返的一半。
// 已校正後量測失敗就沿用上次的時鐘差；從未校正成功時不可回報（解碼照做）。
import { t } from './i18n/index.mjs';

export const MEASURE_INTERVAL_MS = 10 * 60_000;
const SAMPLES = 5;
const SKEW_HINT_MS = 1000;
const UNCERTAIN_MS = 250;
const LATENCY_DT_SEC = 0.8;
const LATENCY_WINDOW = 50;
const LATENCY_MIN_SAMPLES = 10;

export function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class ClockSync {
  constructor({
    fetchTime,
    now = () => Date.now(),
    onChange = () => {},
    // 預設要包一層：瀏覽器的 setInterval 存成物件屬性再呼叫，this 會變成 ClockSync 而丟 Illegal invocation
    setInterval: setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: clearIntervalFn = (id) => globalThis.clearInterval(id),
  }) {
    this.fetchTime = fetchTime;
    this.now = now;
    this.onChange = onChange;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.timer = null;
    this.state = { everSynced: false, offsetMs: 0, uncertaintyMs: null, serverSynced: null, measuredAt: null, lastError: null };
    this.manualMs = 0; // 手動時間偏移（設置 › 時間偏移，同 FT8TW），加在自動校時結果上
    this.rxDelayMs = 0; // 收訊音訊延遲（設置 › 電台與聲音，add-dt-offset-advisor D14）：只影響接收
  }

  // 實際使用的時鐘差＝自動校時＋手動偏移（收發都用）。state.offsetMs 只有自動校時（時鐘警告、回報判斷看它）
  get offsetMs() {
    return this.state.offsetMs + this.manualMs;
  }

  // 接收用的時鐘差：再減掉收訊音訊延遲（音訊晚到 L，樣本的時間戳記往前標 L，切出的 slot 才對得上空中時間）
  get rxOffsetMs() {
    return this.offsetMs - this.rxDelayMs;
  }

  setRxDelay(ms) {
    this.rxDelayMs = Number.isFinite(ms) ? ms : 0;
  }

  // notify:false：頁面載入時套用存的偏移，不觸發 onChange（主程式那時還沒初始化完，render 會碰到還沒宣告的變數）
  setManualOffset(ms, { notify = true } = {}) {
    const v = Number.isFinite(ms) ? ms : 0;
    if (v === this.manualMs) return;
    this.manualMs = v;
    if (notify) this.onChange(this.state);
  }

  async measure() {
    let best = null;
    let lastError = null;
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = this.now();
      try {
        const body = await this.fetchTime();
        const t1 = this.now();
        // 外來資料：格式不對就當這個樣本失敗，免得 NaN 時鐘差讓所有 slot 時間失效
        if (!Number.isFinite(body?.utcMs) || typeof body.synced !== 'boolean') throw new Error(t('page.clock.bad_response'));
        const { utcMs, synced } = body;
        const rtt = t1 - t0;
        if (best === null || rtt < best.rtt) best = { rtt, offset: utcMs - (t0 + t1) / 2, synced };
      } catch (err) {
        lastError = err.message;
      }
    }
    if (best) {
      this.state = {
        everSynced: true,
        offsetMs: best.offset,
        uncertaintyMs: best.rtt / 2,
        serverSynced: best.synced,
        measuredAt: this.now(),
        lastError: null,
      };
    } else {
      this.state = { ...this.state, lastError };
    }
    this.onChange(this.state);
    return this.state;
  }

  correctedNow() {
    return this.now() + this.offsetMs;
  }

  async start() {
    await this.measure();
    this.timer = this.setIntervalFn(() => this.measure(), MEASURE_INTERVAL_MS);
  }

  stop() {
    if (this.timer !== null) this.clearIntervalFn(this.timer);
    this.timer = null;
  }
}

// recentDt：依時間順序的解碼 Δt（秒）。回傳要顯示的警告與能否回報。
export function evaluateClock(state, recentDt) {
  const warnings = [];
  if (!state.everSynced) {
    warnings.push('never-synced');
    return { canReport: false, warnings };
  }
  if (Math.abs(state.offsetMs) > SKEW_HINT_MS) warnings.push('clock-skew');
  if (state.uncertaintyMs > UNCERTAIN_MS) warnings.push('uncertain');
  if (state.serverSynced === false) warnings.push('server-unsynced');
  const window = recentDt.slice(-LATENCY_WINDOW);
  if (window.length >= LATENCY_MIN_SAMPLES && Math.abs(median(window)) > LATENCY_DT_SEC) warnings.push('audio-latency');
  return { canReport: true, warnings };
}
