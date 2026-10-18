// 自動偵測時間偏差（add-dt-offset-advisor）：統計 FT8／FT4／JS8 解碼的 Δt，偏差太大時建議「收訊音訊延遲」；完全解不到時用已錄的音訊掃描延遲。
// 純邏輯（不碰 DOM）。方向（design D1、D14）：接收的時間戳記＝擷取時刻＋時鐘差−收訊音訊延遲，Δt 為正（音訊晚到）要加大延遲：
// 建議＝目前收訊音訊延遲＋Δt。只影響接收，不動發射時間（D14）。
// 時間一律用校正後的 UTC（與 slot 的 startUtc 同一個時鐘），由呼叫端傳入。
import { median } from './clock.mjs';
import { RX_DELAY_OPTIONS } from './config/model.mjs';
import { formatOffset } from './format.mjs';
import { t } from './i18n/index.mjs';

export const DT_THRESHOLD_SEC = 1.0; // 延遲（Δt 中位數）絕對值超過才提醒
export const MIN_SLOTS = 3; // 至少幾個時槽
export const MIN_SAMPLES = 10; // 剔除離群值後至少幾則
export const WINDOW_SLOTS = 8; // 只看最近幾個有解碼的時槽
export const MAX_AGE_MS = 10 * 60_000; // 時槽太舊不算
export const OUTLIER_SEC = 0.5; // 與中位數相差超過就當離群值
export const SNOOZE_MS = 30 * 60_000; // 「忽略」後多久不提醒
// 掃描偵測（design D6）
export const SCAN_ZERO_SLOTS = 4; // 連續幾個解不到（0 或 1 則、有聲音）的時槽才開始
export const SCAN_DELAYS_SEC = Object.freeze([1, 2, 3, 4, 5, 6, 8, -1, -2]); // 解碼器容忍約 ±2 秒，+7 已被 +6／+8 涵蓋
export const SCAN_MIN_DECODES = 3;
// JS8（使用者 2026-10-09）：訊號稀疏、每則有 CRC → 解出 2 則就算找到；連續 8 個 NOR 週期（約 2 分鐘）解不到才掃描
export const JS8_SCAN_MIN_DECODES = 2;
export const JS8_SCAN_ZERO_SLOTS = 8;
export const SILENT_RMS = 10 ** (-70 / 20); // −70 dBFS（同 detect.mjs 的靜音門檻）
export const SCAN_RECOVER_DECODES = 2; // 一般時槽至少解出幾則才算「恢復有解碼」（1 則可能是誤解碼，不讓掃描重來）
export const PROBE_MAX_DECODE_FRACTION = 1 / 3; // 上一筆正常解碼花了時槽的 1/3 以上就不送探測（留到下一個時槽）
export const RESIDUAL_LIMIT_SEC = 0.3; // 套用後仍剩這麼多偏差才算「已達上限」
export const FT4_MAX_DELAY_SEC = 3.75; // FT4 時槽 7.5 秒：延遲 ≥ 半個時槽會與相鄰時槽混疊，掃描與建議都限制在這之內（D16）
export const CLOCK_RESET_MS = 200; // 自動校時的時鐘差變動超過就清空統計（D17）
export const JS8_MAX_DELAY_SEC = 7.5; // JS8 以 NOR 15 秒週期掃描與估計：延遲 ≥ 半週期分不清是哪個週期（D24）
const MAX_DELAY_SEC = { FT4: FT4_MAX_DELAY_SEC, JS8: JS8_MAX_DELAY_SEC };
const ADVISED_MODES = new Set(['FT8', 'FT4', 'JS8']); // FT2 是 FT8TW 自訂模式：不偵測（design D3）
// JS8（design D22、D23）：解碼結果的 Δt 已由 js8Dt() 換算成相對各速度名目發射起點（slot＋起始延遲），
// 實測各速度準時訊號的 Δt 基準都 ≈ 0（|平均| ≤ 0.06 秒，wasm/test/dt-offset-js8.test.mjs），不另扣基準。
// 只有週期 ≥ 15 秒的 NOR、SLO 列入 Δt 統計：FST 10 秒、TUR 6 秒、FTW 4S 4 秒在延遲 8／4／2 秒起就混疊
// （實測延遲 +4 秒時 TUR 解出 Δt −2.0、FTW 4S 解出 0.0），會給出反方向或「沒問題」的結果
export const JS8_DT_SUBMODES = Object.freeze([0, 4]);
export const JS8_SCAN_SUBMODE = 0; // 掃描與「連續解不到」只看 NOR 的週期（D23）
export const JS8_MIN_SLOTS = 3; // JS8 訊號稀疏：至少 3 個週期、5 則就判斷
export const JS8_MIN_SAMPLES = 5;

const round1 = (x) => Math.round(x * 10) / 10 || 0; // 取到 0.1，不出現 −0

// 剔除與中位數相差超過 OUTLIER_SEC 的值後再取中位數
export function robustMedian(values) {
  if (values.length === 0) return { median: null, kept: 0 };
  const m = median(values);
  const kept = values.filter((v) => Math.abs(v - m) <= OUTLIER_SEC);
  return { median: median(kept), kept: kept.length };
}

// 該模式可用的延遲（ms）：FT4 只到 |延遲| < 3.75 秒、JS8 只到 < 7.5 秒
const delayOptions = (mode) => (MAX_DELAY_SEC[mode] ? RX_DELAY_OPTIONS.filter((o) => Math.abs(o) < MAX_DELAY_SEC[mode] * 1000) : RX_DELAY_OPTIONS);
// 掃描要試的 d（秒）：FT4 只試 |d| < 3.75、JS8 只試 |d| < 7.5
export const scanDelaysFor = (mode) => SCAN_DELAYS_SEC.filter((d) => !MAX_DELAY_SEC[mode] || Math.abs(d) < MAX_DELAY_SEC[mode]);

// 建議的收訊音訊延遲：目前延遲＋偵測到的偏差，取最接近的合法選項（範圍 −2～+10 秒，FT4 再限 |延遲| < 3.75 秒、JS8 < 7.5 秒；
// 同距離取絕對值小的）。剩餘偏差＝套用後仍會有的偏差，≥ 0.3 秒才算被夾住（clamped）
export function suggestDelay(currentMs, delaySec, mode = 'FT8') {
  const target = currentMs + delaySec * 1000;
  let suggestedMs = 0;
  for (const o of delayOptions(mode)) {
    const d = Math.abs(o - target) - Math.abs(suggestedMs - target);
    if (d < 0 || (d === 0 && Math.abs(o) < Math.abs(suggestedMs))) suggestedMs = o;
  }
  const residualSec = round1(delaySec - (suggestedMs - currentMs) / 1000);
  return { suggestedMs, clamped: Math.abs(residualSec) >= RESIDUAL_LIMIT_SEC, residualSec };
}

export class DtAdvisor {
  constructor() {
    this.enabled = true;
    this.gen = 0;
    this.contextKey = undefined;
    this.snoozedUntil = -Infinity;
    this.mode = 'FT8';
    this.clockOffsetMs = 0; // 目前統計所依據的自動校時時鐘差
    this.clear();
  }

  // 送去解碼時記下，結果回來時一起交給 addSlot；清空後加一，舊結果就不列入（design D7）
  get generation() {
    return this.gen;
  }

  clear() {
    this.slots = []; // { startUtc, dts }
    this.zeroRun = 0;
    this.clearScan();
  }

  clearScan() {
    this.scanIndex = 0;
    this.scanDelays = scanDelaysFor(this.mode);
    this.scanResults = [];
    this.pending = null;
    this.exhausted = false;
    this.found = null;
  }

  reset() {
    this.gen += 1;
    this.clear();
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    this.reset();
  }

  // key：波段、模式、音訊輸入、時間偏移、是否接收中…組成的字串；變了就清空（回傳是否清空）
  setContext(key) {
    if (key === this.contextKey) return false;
    this.contextKey = key;
    this.reset();
    return true;
  }

  // 自動校時的時鐘差（clock.state.offsetMs）：與統計依據的值相差 > 200 ms 就清空（回傳是否清空）。
  // 小變動不更新依據，所以累積的漂移也會觸發（D17）
  noteClockOffset(ms) {
    if (Math.abs(ms - this.clockOffsetMs) <= CLOCK_RESET_MS) return false;
    this.clockOffsetMs = ms;
    this.reset();
    return true;
  }

  // 模式（決定掃描的 d 與建議範圍）；換模式時 setContext 本來就會清空，這裡只保險
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.clearScan();
  }

  // 一個正常解碼的時槽：dts＝各則 Δt（秒），rms＝該時槽音訊的 RMS；JS8 另帶 submode（速度）。回傳是否列入
  addSlot({ mode, submode = 0, startUtc, dts, rms, generation }) {
    if (!this.enabled || !ADVISED_MODES.has(mode) || generation !== this.gen) return false;
    if (mode === 'JS8' && !JS8_DT_SUBMODES.includes(submode)) return false; // 短週期速度會混疊（D22）
    this.setMode(mode);
    if (dts.length) {
      this.slots.push({ startUtc, dts: [...dts] });
      if (this.slots.length > WINDOW_SLOTS) this.slots.shift();
    }
    if (mode === 'JS8' && submode !== JS8_SCAN_SUBMODE) return true; // 掃描只看 NOR 的週期（D23）
    if (dts.length >= SCAN_RECOVER_DECODES) {
      this.zeroRun = 0;
      this.clearScan(); // 恢復有解碼：掃描重來
    } else {
      this.zeroRun = rms >= SILENT_RMS ? this.zeroRun + 1 : 0; // 0 或 1 則（可能是誤解碼）算「解不到」；靜音不算
    }
    return true;
  }

  // 該送的探測：{ delaySec, generation }；不需要（條件不足、冷卻中、上一筆解碼太慢、正在等結果、已找到、已試完）回 null。
  // now：校正後的 UTC（冷卻期間不掃描，免得冷卻結束時拿出冷卻中的結果）；decodeMs／periodMs：上一筆正常解碼花的時間與時槽長度
  nextProbe(mode, { now, decodeMs, periodMs } = {}) {
    if (!this.enabled || !ADVISED_MODES.has(mode) || this.zeroRun < (mode === 'JS8' ? JS8_SCAN_ZERO_SLOTS : SCAN_ZERO_SLOTS)) return null;
    if (now < this.snoozedUntil) return null;
    if (decodeMs >= periodMs * PROBE_MAX_DECODE_FRACTION) return null;
    if (this.pending || this.found || this.exhausted) return null;
    this.setMode(mode);
    this.pending = { delaySec: this.scanDelays[this.scanIndex], generation: this.gen };
    return { ...this.pending };
  }

  matches(probe) {
    return Boolean(this.pending) && probe.generation === this.gen && probe.delaySec === this.pending.delaySec;
  }

  // 探測沒送成（緩衝還沒涵蓋）：下一個時槽再試同一個 d
  probeFailed(probe) {
    if (!this.matches(probe)) return false;
    this.pending = null;
    return true;
  }

  probeResult(probe, dts) {
    if (!this.matches(probe)) return false;
    this.pending = null;
    const { median: m } = robustMedian(dts);
    this.scanResults.push({ delaySec: probe.delaySec, count: dts.length, estimateSec: m === null ? null : probe.delaySec + m });
    this.scanIndex += 1;
    if (this.scanIndex < this.scanDelays.length) return true;
    // 全部試完：取解得最多（同數取先試的）且達門檻、估計又超過提醒門檻者；
    // 都沒有就停止（exhausted，不卡在用不到的 found），等條件改變或恢復有解碼
    const best = this.scanResults.reduce((a, b) => (b.count > a.count ? b : a));
    const minDecodes = this.mode === 'JS8' ? JS8_SCAN_MIN_DECODES : SCAN_MIN_DECODES;
    if (best.count >= minDecodes && Math.abs(best.estimateSec) > DT_THRESHOLD_SEC) this.found = best;
    else this.exhausted = true;
    return true;
  }

  // Δt 路徑的延遲估計：{ delaySec, count } 或 null（資料不足）
  dtEstimate(now) {
    const slots = this.slots.filter((s) => s.startUtc >= now - MAX_AGE_MS);
    const all = slots.flatMap((s) => s.dts);
    const { median: m } = robustMedian(all);
    if (m === null) return null;
    const kept = slots.map((s) => s.dts.filter((v) => Math.abs(v - median(all)) <= OUTLIER_SEC).length);
    const count = kept.reduce((a, b) => a + b, 0);
    const [minSamples, minSlots] = this.mode === 'JS8' ? [JS8_MIN_SAMPLES, JS8_MIN_SLOTS] : [MIN_SAMPLES, MIN_SLOTS];
    if (count < minSamples || kept.filter((n) => n > 0).length < minSlots) return null;
    return { delaySec: m, count };
  }

  // 要提醒的建議：{ kind: 'dt'|'scan', mode, delaySec, count, suggestedMs, clamped, residualSec, limit? }、
  // { kind: 'unsynced', delaySec, count }（時鐘還沒校準：偏差可能是電腦時鐘，不建議收訊延遲，D17）或 null
  evaluate({ currentDelayMs, now, clockSynced = true }) {
    if (!this.enabled || now < this.snoozedUntil) return null;
    const est = this.found ? { kind: 'scan', mode: this.mode, delaySec: this.found.estimateSec, count: this.found.count }
      : (() => { const e = this.dtEstimate(now); return e && { kind: 'dt', mode: this.mode, ...e }; })();
    if (!est || Math.abs(est.delaySec) <= DT_THRESHOLD_SEC) return null;
    if (!clockSynced) return { kind: 'unsynced', mode: this.mode, delaySec: est.delaySec, count: est.count };
    const s = suggestDelay(currentDelayMs, est.delaySec, this.mode);
    // 已在上限（沒有可套用的），或夾住後反而往反方向（例如 FT4 時延遲已手動設在 3.75 秒以外）：不提醒
    if (Math.sign(s.suggestedMs - currentDelayMs) !== Math.sign(est.delaySec)) return null;
    if (!s.clamped) return { ...est, ...s };
    // 被模式的上限夾住（FT4 半時槽、JS8 NOR 半週期）還是整個範圍的上限
    const modeMax = MAX_DELAY_SEC[this.mode] && s.suggestedMs === Math.max(...delayOptions(this.mode));
    return { ...est, ...s, limit: modeMax ? this.mode.toLowerCase() : 'range' };
  }

  // 忽略：冷卻期間不提醒、不掃描；掃描結果作廢（冷卻後要重新掃過才再提醒，不拿半小時前的結果）
  snooze(now) {
    this.snoozedUntil = now + SNOOZE_MS;
    this.clearScan();
  }
}

// 探測的擷取窗：假設音訊晚 delaySec 秒，取緩衝已涵蓋（結尾 endUtc）的最新 slot S，樣本範圍 [S−lead＋d, S−lead＋d＋duration)。
// FT8／FT4 擷取窗就是 slot 本身（lead 0、duration＝slot）；JS8 NOR 自 slot 前 1 秒起 14.84 秒（captureWindow）。
// 回傳 { startUtc: S, fromUtc: S−lead＋d }
export function probeWindow(endUtc, periodMs, delaySec, { leadMs = 0, durationMs = periodMs } = {}) {
  const shift = delaySec * 1000 - leadMs;
  const startUtc = Math.floor((endUtc - durationMs - shift) / periodMs) * periodMs;
  return { startUtc, fromUtc: startUtc + shift };
}

const sec = (s) => formatOffset(Math.round(s * 10) * 100);

// 橫幅文字（i18n dtadvisor.*）。負的偏差（音訊早到）用「提早」的說法、數字取絕對值（英文 early）；JS8 開頭註明依 JS8 訊號估計
const LIMIT_KEYS = { ft4: 'dtadvisor.limitFt4', js8: 'dtadvisor.limitJs8', range: 'dtadvisor.limit' };
export function adviceText(advice) {
  const note = advice.mode === 'JS8' ? t('dtadvisor.js8Note') : '';
  return note + adviceBody(advice);
}

function adviceBody(advice) {
  if (advice.kind === 'unsynced') return t('dtadvisor.unsynced', { dt: sec(advice.delaySec) });
  const delay = formatOffset(advice.suggestedMs);
  const early = advice.delaySec < 0;
  const v = sec(Math.abs(advice.delaySec));
  const main = advice.kind === 'scan'
    ? t(early ? 'dtadvisor.scanEarly' : 'dtadvisor.scan', { found: v, n: advice.count, delay })
    : t(early ? 'dtadvisor.dtEarly' : 'dtadvisor.dt', { dt: v, delay });
  const limit = advice.clamped ? t(LIMIT_KEYS[advice.limit] ?? LIMIT_KEYS.range, { residual: sec(advice.residualSec) }) : '';
  return main + limit + t('dtadvisor.rxOnly');
}
