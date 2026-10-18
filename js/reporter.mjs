// 回報（tasks 4.2、spot-relay spec、design D1／D14）：把解碼變成 spot、累積、送給轉送站。
// - 能確定發送者的標準訊息才回報；同「呼號＋波段＋模式」5 分鐘只報一次（pskdev 硬性規定）
// - 滿 100 筆或距上次 45～75 秒（隨機，避免所有使用者同時送）就送；暫存最多 1000 筆
// - 沒設定呼號／網格、從未取得時間校正、撥號頻率不明時不收集（之後補送的時間戳記不可信）
import { t } from './i18n/index.mjs';
import { parseMessage } from './ft8parse.mjs';

export const MAX_BATCH = 100;
export const MAX_QUEUE = 1000;
export const DEDUP_MS = 5 * 60_000;
const INTERVAL_MIN_MS = 45_000;
const INTERVAL_SPAN_MS = 30_000;
const TRIAL_BACKOFF_MS = 10 * 60_000;
// 轉送站的轉發控制（add-relay-forward-control F7）：全站暫停（503 forward-paused）或呼號被封鎖（403 forward-blocked）、
// 或心跳回應表示不能轉發 → 停送、丟佇列、暫停期間不累積；10 分鐘後或心跳顯示恢復才再收集與送出
export const FORWARD_PAUSE_MS = 10 * 60_000;
const FORWARD_PAUSES = new Set(['forward-paused', 'forward-blocked']);
// 轉送站決定的暫停：本機條件（沒呼號、沒時間校正、撥號頻率不明）不覆蓋它們
const RELAY_PAUSES = new Set(['trial', ...FORWARD_PAUSES]);
const DEFAULT_RETRY_AFTER_S = 60;
// 轉送站每個接收者 30 秒只收一批（relay/src/ratelimit.js receiverIntervalMs）；
// 兩次送出至少隔這麼久，免得滿 100 筆或失敗時每秒重送、被 429
const MIN_GAP_MS = 30_000;

export class Reporter {
  // send(payload) → { status, retryAfter?, reason? }（reason＝轉送站回應的 error 欄位）；getReceiver() → { id, callsign, locator, webVersion }
  constructor({ send, getReceiver, canReport, now = () => Date.now(), random = Math.random }) {
    this.send = send;
    this.getReceiver = getReceiver;
    this.canReport = canReport;
    this.now = now;
    this.random = random;
    this.queue = [];
    this.lastReported = new Map(); // 「呼號|波段|模式」→ 產生 spot 的時間
    this.inFlight = false;
    this.backoffUntil = 0;
    this.nextDue = this.now() + this.interval();
    this.counts = { sent: 0, dropped: 0, rejected: 0, discarded: 0 };
    this.identity = null; // 暫存裡的 spot 是在哪個「呼號|網格」下收到的
    this.lastError = null;
    this.paused = null; // null｜'no-identity'｜'no-clock'｜'no-dial'｜'trial'｜'forward-paused'｜'forward-blocked'
    this.pauseUntil = 0; // 轉發暫停到什麼時候（之後自動恢復試送）
  }

  interval() {
    return INTERVAL_MIN_MS + Math.round(this.random() * INTERVAL_SPAN_MS);
  }

  identityOk() {
    const r = this.getReceiver();
    return Boolean(r.callsign && r.locator);
  }

  // 呼號或網格改了（例如換了地點）：暫存是舊身分收到的，用新身分送出就是錯的資料，清掉重來
  syncIdentity() {
    const r = this.getReceiver();
    const key = `${r.callsign}|${r.locator}`;
    if (this.identity !== null && key !== this.identity) {
      this.counts.discarded += this.queue.length;
      this.queue = [];
      this.lastReported.clear();
    }
    this.identity = key;
  }

  // slot：{ startUtc, mode, band, dialHz, results: [{ text, freqHz, snr, sender?, grid? }] }
  add({ startUtc, mode, band, dialHz, results }) {
    this.syncIdentity();
    this.expirePause();
    if (FORWARD_PAUSES.has(this.paused)) return; // 轉發暫停中：不累積（恢復時不會一次補送暫停期間的資料）
    if (!this.identityOk()) return this.setPaused('no-identity');
    if (!this.canReport()) return this.setPaused('no-clock');
    if (!dialHz) return this.setPaused('no-dial');
    if (mode === 'FT2') return; // FT2 是 FT8TW 自訂模式：轉送站與 PSKReporter 不收，只進 SWL Log
    if (mode === 'JTTY') return; // JTTY P1 不回報（add-web-jtty W1：WSJT-X 回報用的 mode 名稱確認後另案，送真資料前再問）
    if (!RELAY_PAUSES.has(this.paused)) this.paused = null;

    const t = this.now();
    for (const [key, at] of this.lastReported) if (t - at >= DEDUP_MS) this.lastReported.delete(key);
    const wasEmpty = this.queue.length === 0;

    for (const r of results) {
      // JS8 的訊息由主程式組好、帶 sender（D10）；FT8／FT4 從文字解析。sender 是空字串表示解不出，不猜
      const parsed = 'sender' in r ? (r.sender ? { sender: r.sender, grid: r.grid || null } : null) : parseMessage(r.text);
      if (!parsed) continue;
      const key = `${parsed.sender}|${band}|${mode}`;
      if (this.lastReported.has(key)) continue;
      this.lastReported.set(key, t);
      this.queue.push({
        callsign: parsed.sender,
        frequency: dialHz + Math.round(r.freqHz),
        snr: Math.max(-50, Math.min(50, Math.round(r.snr))),
        mode,
        locator: parsed.grid ?? '',
        time: Math.floor(startUtc / 1000),
      });
    }
    // 閒置一陣子後的第一筆不立刻送：否則送出時間會對齊 slot 解碼完成的時刻（spec：SHALL NOT 對齊 slot）
    if (wasEmpty && this.queue.length > 0 && t >= this.nextDue) this.nextDue = t + this.interval();
    if (this.queue.length > MAX_QUEUE) {
      const over = this.queue.length - MAX_QUEUE;
      this.queue.splice(0, over);
      this.counts.dropped += over;
    }
  }

  setPaused(reason) {
    if (!RELAY_PAUSES.has(this.paused)) this.paused = reason;
  }

  // 轉發暫停：丟掉佇列（算進 discarded）、不重送
  pauseForward(reason) {
    this.counts.discarded += this.queue.length;
    this.queue = [];
    this.paused = reason;
    this.pauseUntil = this.now() + FORWARD_PAUSE_MS;
    this.backoffUntil = Math.max(this.backoffUntil, this.pauseUntil);
    this.lastError = null;
  }

  expirePause() {
    if (FORWARD_PAUSES.has(this.paused) && this.now() >= this.pauseUntil) this.liftPause();
  }

  liftPause() {
    this.paused = null;
    this.pauseUntil = 0;
    this.backoffUntil = Math.min(this.backoffUntil, this.now());
  }

  // 心跳回應的 forward（hello.mjs parseForward）：{ psk, aprs, you }。回傳暫停狀態是否改變（主程式據此重畫狀態列）。
  // you 'none'（未允許）不當暫停訊號：交給 /spots 的 trial-not-open；'allow' 表示後台已允許，試驗期暫停也一併解除
  setForward(forward) {
    if (!forward) return false;
    const before = this.paused;
    if (forward.psk === false) {
      if (this.paused !== 'forward-paused') this.pauseForward('forward-paused');
    } else if (forward.you === 'block') {
      if (this.paused !== 'forward-blocked') this.pauseForward('forward-blocked');
    } else if (FORWARD_PAUSES.has(this.paused) || (this.paused === 'trial' && forward.you === 'allow')) {
      this.liftPause();
    }
    return this.paused !== before;
  }

  // 由主程式每秒呼叫；回傳 Promise，測試可 await
  async tick() {
    const t = this.now();
    if (!this.inFlight) this.syncIdentity(); // 送出中不清，免得回應回來時對不上
    this.expirePause();
    if (this.inFlight || this.queue.length === 0 || t < this.backoffUntil) return;
    if (!this.identityOk() || !this.canReport()) return;
    if (this.queue.length < MAX_BATCH && t < this.nextDue) return;

    const batch = this.queue.slice(0, MAX_BATCH);
    this.inFlight = true;
    let res;
    try {
      res = await this.send({ receiver: this.getReceiver(), spots: batch });
    } catch (err) {
      res = { status: 0, error: err.message };
    } finally {
      this.inFlight = false;
    }
    this.nextDue = this.now() + this.interval();
    this.backoffUntil = this.now() + MIN_GAP_MS;
    this.handle(res, batch.length);
  }

  handle(res, n) {
    const { status } = res;
    if (status === 200) {
      this.queue.splice(0, n);
      this.counts.sent += n;
      this.lastError = null;
      if (RELAY_PAUSES.has(this.paused)) this.paused = null;
    } else if (status === 503 && res.reason === 'forward-paused') {
      this.pauseForward('forward-paused');
    } else if (status === 403 && res.reason === 'forward-blocked') {
      this.pauseForward('forward-blocked');
    } else if (status === 400 || status === 413) {
      // 資料不合法：重送也一樣，丟掉免得卡住後面的
      this.queue.splice(0, n);
      this.counts.rejected += n;
      this.lastError = t('page.report.rejected', { status });
    } else if (status === 403 && (res.reason === undefined || res.reason === 'trial-not-open')) {
      // 只有 trial-not-open 才是試驗期；其他 403（例如轉送站缺 CF-Connecting-IP）當一般失敗保留重送
      this.queue.splice(0, n);
      this.paused = 'trial';
      this.backoffUntil = this.now() + TRIAL_BACKOFF_MS;
      this.lastError = null;
    } else if (status === 429) {
      this.backoffUntil = Math.max(this.backoffUntil, this.now() + (res.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000);
      this.lastError = t('page.report.too_fast');
    } else {
      // 502、網路錯誤等：保留，下一個間隔再送（滿 100 筆也一樣，不可每秒重試）
      this.backoffUntil = Math.max(this.backoffUntil, this.nextDue);
      this.lastError = res.error ?? `HTTP ${status}`;
    }
  }

  status() {
    return { ...this.counts, queued: this.queue.length, paused: this.paused, lastError: this.lastError };
  }
}
