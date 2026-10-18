// 電台控制器（add-web-rig-control D5、D7、D8、D11、D13）：連線、初始化、切頻段、輪詢、實際頻率、PTT、SWR 自動停發、QMX 保護。
// 傳輸由 SerialLink（或同介面的物件）負責；計時器與時鐘可注入，單元測試用假的。指令集行為在 sets.mjs。
// PTT 關的保證（D22，安全審查 2026-10-09）：插隊（約 300 ms 等不到佇列就直接寫）、失敗每 500 ms 重送、拉低 RTS／DTR、pttStuck 警告、
// 沒確定送出不關埠（使用者明確斷線除外）、讀錶／輪詢有背壓、斷線時排隊中的間隔一律中止。
import { alcLevel, getSet, convertSwr, modeLeadMs, smeterDb, smeterFor, sUnits, BAND_DELAY_MS, MODE_TO_FREQ_MS, POLL_START_MS, POLL_MS } from './sets.mjs';
import { rigError } from './errors.mjs';
import { ascii, firmwareSupportsSr, lcdStatusChar } from './protocols/ascii.mjs';
import { civ } from './protocols/civ.mjs';

export const CONTROL_MODES = Object.freeze(['vox', 'cat', 'rts', 'dtr']);
export const SWR_LIMIT = 3.0; // Q2：SWR ≥3.0
export const SWR_STRIKES = 2; // 連續 2 次
export const PTT_WATCHDOG_EXTRA_MS = 3000;
export const PTT_WATCHDOG_MAX_MS = 60_000;
export const READ_TIMEOUT_MS = 2000;
export const PTT_OFF_RESEND_WINDOW_MS = 10_000; // KenwoodTS590Rig.PTT_OFF_RESEND_WINDOW_MS
export const ICOM_PTT_QUIET_MS = 60; // IcomRig.PTT_QUIET_MS
export const ICOM_VERIFY_TIMEOUT_MS = 250; // IcomRig.PTT_VERIFY_TIMEOUT_MS
export const ICOM_VERIFY_ATTEMPTS = 3;
export const ICOM_VERIFY_GIVE_UP = 3;
export const QMX_PROBE_LIMIT = 3;
export const STUCK_KEY = 'ft8tw.rig.pttOn'; // 跨分頁的保命旗標（App RigShutdown.markPttOn）
export const PTT_OFF_PRIORITY_MS = 300; // PTT 關等佇列最多這麼久，之後直接寫（App：PTT 等匯流排鎖最多 300 ms，「PTT 絕對不可以無限等」）
export const PTT_OFF_RETRY_MS = 500; // PTT 關失敗：每 500 ms 重送到成功或連線沒了

// QMX 警告的優先順序（QrpQmxRig.updateRigWarning）
const LCD_WARN = { S: 'swrProtect', B: 'band', P: 'practice', G: 'gps' };

export class RigController {
  constructor({ link, now = () => Date.now(), setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (id) => clearTimeout(id), storage = null }) {
    Object.assign(this, { link, now, setTimeoutFn, clearTimeoutFn, storage });
    this.listeners = new Map();
    this.timers = new Set();
    this.state = 'disconnected';
    this.set = null;
    this.cfg = null;
    this.ctx = null;
    this.decoder = null;
    this.queue = Promise.resolve();
    this.session = 0; // 每次連線＋1：舊連線排隊中的指令不送到新連線
    this.inflight = 0; // 佇列中還沒送完的 send() 數（輪詢、讀錶的背壓）
    this.sleepers = new Set();
    this.pttActive = false;
    this.pttStuck = false; // PTT 關沒確定送出（警告一直顯示到 PTT 關成功）
    this.pttRetry = null;
    this.pttOffPending = null;
    this.freq = null; // { hz, at }
    this.freqWaiters = [];
    this.txWaiters = [];
    link.onData((bytes) => this.onData(bytes));
    link.onClose((info) => this.onLinkClosed(info));
  }

  // ── 事件：state、freq、swr、smeter、swrStop、ptt、warning、disconnect、disconnecting、tx、rx、error、pttWatchdog、pttResend、pttStuck ──
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }

  emit(type, detail = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      try { fn(detail); } catch { /* 監聽者的錯不影響控制器 */ }
    }
  }

  get connected() {
    return this.state === 'connected';
  }

  get pttOnNow() {
    return this.pttActive;
  }

  // 控制 PTT：CAT／RTS／DTR 且已連線
  get controlsPtt() {
    return this.connected && this.cfg?.controlMode !== 'vox';
  }

  after(ms, fn) {
    const id = this.setTimeoutFn(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  cancel(id) {
    if (id === null || id === undefined) return;
    this.clearTimeoutFn(id);
    this.timers.delete(id);
  }

  // 斷線（clearAll）時中止：reject，排隊中後面的步驟不送（安全審查 #3）
  sleep(ms) {
    return new Promise((resolve, reject) => {
      const w = { reject };
      this.sleepers.add(w);
      w.id = this.after(ms, () => {
        this.sleepers.delete(w);
        resolve();
      });
    });
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('state', { state, ...extra });
  }

  // ── 連線 ──
  // serial：{ baudRate, dataBits, stopBits, parity }；freqHz：連上後要設的撥號頻率（null 不設）
  // auto：false 時不排設頻段、初始化與輪詢（tools/rig-device-check.mjs 逐步自己呼叫）
  // model：機型名稱（S 表的換算依機型，add-rig-meters M9；沒有就用指令集預設）
  async connect({ port, serial, setId, model = '', civ: civAddr = 0, controlMode = 'cat', pttDelayMs = 100, freqHz = null, auto = true }) {
    if (this.state !== 'disconnected') await this.disconnect();
    const set = getSet(setId);
    if (!set) throw rigError('badSet', `unknown instruction set ${setId}`);
    if (!CONTROL_MODES.includes(controlMode) || controlMode === 'vox') throw rigError('badControlMode', `control mode ${controlMode} does not use the serial port`);
    this.session += 1;
    this.queue = Promise.resolve(); // 舊佇列就算卡住也不影響新連線（安全審查 #3）
    this.inflight = 0;
    this.set = set;
    this.cfg = { controlMode, pttDelayMs, setId, model };
    this.smeter = smeterFor(setId, model);
    this.ctx = { civ: civAddr };
    this.decoder = set.newDecoder(this.ctx);
    this.freq = null;
    this.pollTick = 0;
    this.catOnSent = false;
    this.lastPttOffAt = 0;
    this.lastPttCmdAt = 0;
    this.swrStreak = 0;
    this.icom = { verifySupported: true, noAnswerStreak: 0, verifying: false };
    this.qmx = { tick: 0, firmware: null, vnProbes: 0, srSupported: false, srLocked: false, lcSupported: true, lcAnswered: false, lcProbes: 0, lcd: null, lowPower: 0, noPower: false };
    this.warning = null;
    this.setState('connecting');
    try {
      await this.link.open(port, serial, { requireSignals: controlMode === 'rts' || controlMode === 'dtr' });
    } catch (err) {
      this.setState('disconnected', { error: err });
      throw err;
    }
    this.setState('connected');
    // 上次關閉時 PTT 還按著（分頁當掉）或 PTT 關沒確定送出：先送一次 PTT 關（App resendPttOffIfStuck）
    if (this.readStuck() || this.pttStuck) await this.pttOff({ reason: 'stuck' });
    if (!auto) return;
    if (freqHz) this.after(BAND_DELAY_MS, () => { this.setBandAndMode(freqHz).catch(() => {}); });
    for (const it of set.init) this.after(it.atMs, () => { if (!this.pttActive) this.send(it.steps(this.ctx)).catch(() => {}); });
    this.after(POLL_START_MS, () => this.pollLoop());
  }

  // 立刻送初始化指令（不等 1.5 s；實機檢查用）
  runInit() {
    if (!this.connected) return Promise.reject(rigError('notConnected', 'not connected'));
    return this.send(this.set.init.flatMap((it) => it.steps(this.ctx)));
  }

  // force：使用者明確按「中斷連線」（或改回 VOX）。PTT 關沒確定送出時：一般斷線（改設定重連、換埠）丟 pttStuck、不關埠；
  // force 先直接再送一次 PTT 關並拉低控制線，失敗就留著警告照樣關埠（安全審查 #1）
  async disconnect({ force = false } = {}) {
    if (this.state === 'disconnected') return;
    this.emit('disconnecting', { force }); // 主程式先停止發射（安全審查 #5）
    if (this.pttActive) await this.pttOff({ reason: 'disconnect' });
    else if (this.pttOffPending) await this.pttOffPending;
    if (this.state === 'disconnected') return; // 等 PTT 關時連線斷了
    if (this.pttStuck) {
      if (!force) throw rigError('pttStuck', 'PTT off not confirmed; not closing the port');
      this.cancel(this.pttRetry);
      this.pttRetry = null;
      try {
        await this.writePttOffDirect();
        this.pttOffConfirmed('disconnect', true);
      } catch {
        // 警告留著；旗標留著，下次連上補送
      }
      if (this.state === 'disconnected') return;
    }
    if (this.set?.catOff && this.connected) await this.send(this.set.catOff(this.ctx)).catch(() => {});
    this.clearAll();
    await this.link.close();
    this.setState('disconnected');
  }

  clearAll() {
    this.decoder = null; // 自動探測會重用同一個 link：斷線後舊的解碼器不再處理資料（review D）
    for (const id of this.timers) this.clearTimeoutFn(id);
    this.timers.clear();
    this.bandTimer = null;
    this.meterTimer = null;
    this.pttWatchdog = null;
    this.pttRetry = null;
    this.pendingHz = null;
    for (const w of [...this.sleepers]) w.reject(rigError('disconnected', 'disconnected'));
    this.sleepers.clear();
    for (const w of this.freqWaiters.splice(0)) w.reject(rigError('disconnected', 'disconnected'));
    for (const w of this.txWaiters.splice(0)) w(null);
  }

  onLinkClosed({ error } = {}) {
    if (this.state === 'disconnected') return;
    const duringPtt = this.pttActive;
    this.pttActive = false; // 埠已經沒了，送不出 PTT 關；殘留旗標留著，下次連上補送
    this.clearAll();
    this.setState('disconnected', { error });
    this.emit('disconnect', { duringPtt, error });
    if (duringPtt) this.setStuck(true, error); // 電台可能還在發射（例如寫入卡住）
  }

  // ── 寫入：步驟依序送；Yaesu 5-byte 在送出時設定期待的回應長度 ──
  send(steps) {
    const session = this.session;
    const run = async () => {
      for (const s of steps) {
        if (session !== this.session) throw rigError('disconnected', 'disconnected');
        if (!this.link.isOpen) throw rigError('portNotOpen', 'port not open');
        this.decoder?.expect?.(s.expect ?? null);
        await this.link.write(s.bytes);
        this.emit('tx', { bytes: s.bytes });
        if (s.gapMs) await this.sleep(s.gapMs);
      }
    };
    this.inflight += 1;
    const p = this.queue.then(run, run).finally(() => {
      if (session === this.session) this.inflight -= 1;
    });
    this.queue = p.catch(() => {});
    return p;
  }

  // 佇列忙（上一筆還沒送完）：輪詢、讀錶跳過這一拍（App IcomRig 匯流排鎖忙就跳過），不讓佇列越積越長
  get busy() {
    return this.inflight > 0;
  }

  // 不排隊直接寫（PTT 關的後備、重送、分頁關閉）
  async writeDirect(steps) {
    for (const s of steps) {
      this.decoder?.expect?.(s.expect ?? null); // 同 send()：Yaesu 5-byte 依這筆指令決定回應長度
      await this.link.writeNow(s.bytes);
      this.emit('tx', { bytes: s.bytes });
      if (s.gapMs) await this.sleep(s.gapMs);
    }
  }

  // 排隊送，PTT_OFF_PRIORITY_MS 內沒送完就改直接寫（排隊的那份之後照送，多送一次 PTT 關無害）
  sendPriority(steps) {
    const queued = this.send(steps);
    return new Promise((resolve, reject) => {
      let direct = false;
      const timer = this.after(PTT_OFF_PRIORITY_MS, () => {
        direct = true;
        this.writeDirect(steps).then(resolve, reject);
      });
      queued.then(() => {
        this.cancel(timer);
        resolve();
      }, (err) => {
        if (direct) return;
        this.cancel(timer);
        reject(err);
      });
    });
  }

  // ── 切頻段：先模式，800 ms 後頻率（MainViewModel.setOperationBand）；PTT 開著就等 PTT 關 ──
  setBandAndMode(hz) {
    if (!this.connected || !hz) return Promise.resolve(false);
    this.targetHz = hz;
    if (this.pttActive) {
      this.pendingHz = hz;
      return Promise.resolve(false);
    }
    this.pendingHz = null;
    this.cancel(this.bandTimer);
    return new Promise((resolve, reject) => {
      this.send(this.set.mode(this.ctx)).then(() => {
        this.bandTimer = this.after(MODE_TO_FREQ_MS, () => {
          this.bandTimer = null;
          if (this.pttActive) {
            this.pendingHz = hz;
            resolve(false);
            return;
          }
          this.send(this.set.setFreq(hz, this.ctx)).then(() => resolve(true), reject);
        });
      }, reject);
    });
  }

  // 「測試」：讀一次頻率
  // 發射中不讀（truSDX 讀頻前置 ;RX; 會放開 PTT，安全審查 #8）
  readFrequency({ timeoutMs = READ_TIMEOUT_MS } = {}) {
    if (!this.connected) return Promise.reject(rigError('notConnected', 'not connected'));
    if (this.pttActive) return Promise.reject(rigError('busyTx', 'transmitting'));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      w.timer = this.after(timeoutMs, () => {
        this.freqWaiters = this.freqWaiters.filter((x) => x !== w);
        reject(rigError('readTimeout', 'timeout'));
      });
      this.freqWaiters.push(w);
      this.send(this.set.readFreq(this.ctx)).catch((err) => {
        this.cancel(w.timer);
        this.freqWaiters = this.freqWaiters.filter((x) => x !== w);
        reject(err);
      });
    });
  }

  // 最近一次讀到的頻率（maxAgeMs 內）
  // 發射中不讀頻（D7），頻率也不會變：PTT 開著時沿用最後一次讀到的，不過期（S 表 review B2：FT8 發射到一半摘要列、回報退回標準頻率）
  actualHz(maxAgeMs = 10_000) {
    if (!this.connected || !this.freq) return null;
    if (this.pttActive) return this.freq.hz;
    return this.now() - this.freq.at <= maxAgeMs ? this.freq.hz : null;
  }

  // ── 輪詢（每 2 s）：PTT 關讀頻率，PTT 開讀錶（App 各驅動 readTask）──
  pollLoop() {
    if (!this.connected) return;
    if (!this.busy) this.poll();
    this.after(POLL_MS, () => this.pollLoop());
  }

  poll() {
    this.pollTick += 1;
    const set = this.set;
    if (set.catOn && !this.catOnSent) {
      this.catOnSent = true;
      this.send(set.catOn(this.ctx)).catch(() => {});
    }
    if (this.pttActive) {
      if (set.meters && !(set.meterIntervalMs < POLL_MS)) this.send(set.meters(this.ctx, this.pollTick)).catch(() => {});
    } else {
      // TS-590 系：PTT 關後 10 s 內每拍補送 ;RX;（KenwoodTS590Rig.resendPttOffIfRecent）
      if (set.pttOffResend && this.cfg.controlMode === 'cat' && this.lastPttOffAt && this.now() - this.lastPttOffAt <= PTT_OFF_RESEND_WINDOW_MS) {
        this.send([{ bytes: ascii(';RX;') }]).catch(() => {});
      }
      // S 表（add-rig-meters M6）：ASCII 接在讀頻後同一批；CI-V／Yaesu 5-byte 與讀頻輪替（奇數拍讀頻、偶數拍讀 S 表）
      const sm = this.smeter;
      // 「測試」讀頻還在等回應：這拍不送 S 表（E7 的期待長度會清掉讀頻回應，S 表 review B1）
      if (sm?.alternate && this.pollTick % 2 === 0) { if (!this.freqWaiters.length) this.send(sm.steps(this.ctx)).catch(() => {}); }
      else this.send([...set.readFreq(this.ctx), ...(sm && !sm.alternate ? sm.steps(this.ctx) : [])]).catch(() => {});
    }
    if (set.qmx) this.qmxPoll();
  }

  // QMX 保護輪詢（QrpQmxRig.pollProtection）
  qmxPoll() {
    const q = this.qmx;
    q.tick += 1;
    const cmds = [];
    if (!q.firmware && q.vnProbes < QMX_PROBE_LIMIT) {
      q.vnProbes += 1;
      cmds.push('VN;');
    }
    if (q.srSupported) cmds.push('SR;');
    if (q.lcSupported && (this.pttActive || q.tick % 3 === 0)) {
      if (!q.lcAnswered) q.lcProbes += 1;
      if (!q.lcAnswered && q.lcProbes > QMX_PROBE_LIMIT) q.lcSupported = false;
      else cmds.push('LC;');
    }
    if (cmds.length) this.send(cmds.map((c) => ({ bytes: ascii(c) }))).catch(() => {});
  }

  // ── 收到資料 ──
  onData(bytes) {
    this.emit('rx', { bytes });
    if (!this.decoder) return;
    for (const ev of this.decoder.push(bytes)) this.handle(ev);
  }

  handle(ev) {
    if (ev.freq) {
      this.freq = { hz: ev.freq, at: this.now() };
      this.emit('freq', { hz: ev.freq });
      for (const w of this.freqWaiters.splice(0)) {
        this.cancel(w.timer);
        w.resolve(ev.freq);
      }
    }
    if (ev.swr !== undefined || ev.swrRaw !== undefined) {
      const swr = ev.swr ?? convertSwr(this.set.swr, ev.swrRaw);
      if (swr !== null) this.onSwr(swr);
    }
    // S 表：只在接收中（發射前送出、PTT 開後才到的回應丟掉，M8）
    if (ev.smRaw !== undefined && this.smeter && !this.pttActive && !this.pttStuck) { // PTT 關沒確認時電台可能還在發射（review C6）
      const db = smeterDb(this.smeter, ev.smRaw);
      if (db !== null) this.emit('smeter', { raw: ev.smRaw, db, s: sUnits(db), calibrated: this.smeter.calibrated });
    }
    // 發射電平步驟的讀數（add-rig-autosetup A15）
    if (ev.alcRaw !== undefined) this.emit('meter', { alcRaw: ev.alcRaw, alc: alcLevel(this.set?.alc, ev.alcRaw) });
    if (ev.power !== undefined) this.emit('meter', { power: ev.power });
    if (ev.tx !== undefined) for (const w of this.txWaiters.splice(0)) w(ev.tx);
    if (this.set?.qmx) this.qmxEvent(ev);
  }

  onSwr(swr) {
    this.emit('swr', { swr, high: swr >= SWR_LIMIT });
    if (!this.pttActive) return;
    this.swrStreak = swr >= SWR_LIMIT ? this.swrStreak + 1 : 0;
    if (this.swrStreak >= SWR_STRIKES) {
      this.swrStreak = 0;
      this.emit('swrStop', { swr });
      this.pttOff({ reason: 'swr' });
    }
  }

  qmxEvent(ev) {
    const q = this.qmx;
    if (ev.firmware) {
      q.firmware = ev.firmware;
      q.srSupported = firmwareSupportsSr(ev.firmware);
    }
    if (ev.srLocked !== undefined) q.srLocked = ev.srLocked;
    if (ev.lcd !== undefined) {
      q.lcAnswered = true;
      const c = lcdStatusChar(ev.lcd);
      if (c !== null) q.lcd = c;
    }
    if (ev.power !== undefined && this.pttActive) {
      q.lowPower = ev.power <= 1 ? q.lowPower + 1 : 0;
      if (q.lowPower >= 3) q.noPower = true; // QrpQmxRig：PC 原始值（0.1 W）連續 3 次 ≤1
    }
    this.updateWarning();
  }

  updateWarning() {
    const q = this.qmx;
    const code = (q.srSupported && q.srLocked && 'swrProtect') || LCD_WARN[q.lcd] || (q.noPower && 'noPower') || null;
    if (code === this.warning) return;
    this.warning = code;
    this.emit('warning', { code });
  }

  // ── PTT ──
  // expectedMs：這次音訊長度（PTT 看門狗＝它＋3 s，最長 60 s）
  async pttOn({ expectedMs = 15_000 } = {}) {
    if (!this.connected) throw rigError('notConnected', 'rig not connected');
    const mode = this.cfg.controlMode;
    this.pttActive = true;
    this.writeStuck(true);
    this.swrStreak = 0;
    if (this.qmx) Object.assign(this.qmx, { lowPower: 0, noPower: false });
    this.cancel(this.pttWatchdog);
    this.pttWatchdog = this.after(Math.min(expectedMs + PTT_WATCHDOG_EXTRA_MS, PTT_WATCHDOG_MAX_MS), () => {
      this.pttWatchdog = null;
      if (!this.pttActive) return;
      this.emit('pttWatchdog', {});
      this.pttOff({ reason: 'watchdog' });
    });
    try {
      if (mode === 'cat' || this.set.pttAlwaysCat) await this.send(this.set.pttOn(this.ctx));
      else await this.link.setSignals(mode === 'rts' ? { rts: true } : { dtr: true });
      this.lastPttCmdAt = this.now();
    } catch (err) {
      await this.pttOff({ reason: 'error' });
      throw err;
    }
    if (!this.pttActive) {
      // 送出期間被停止（看門狗、斷線、停止）：PTT 關可能插隊比 PTT 開先送出，再送一次 PTT 關
      await this.pttOff({ reason: 'released' });
      throw rigError('pttReleased', 'PTT released while keying');
    }
    this.emit('ptt', { on: true });
    // ICOM：SWR／ALC 每 250 ms 輪替，PTT 指令後 60 ms 內不送（IcomRig.startMeterTimer）
    if (this.set.meters && this.set.meterIntervalMs < POLL_MS) this.meterLoop(0);
    return true;
  }

  meterLoop(tick) {
    this.meterTimer = this.after(this.set.meterIntervalMs, () => {
      if (!this.pttActive || !this.connected) return;
      if (this.now() - this.lastPttCmdAt >= ICOM_PTT_QUIET_MS && !this.busy) this.send(this.set.meters(this.ctx, tick)).catch(() => {});
      this.meterLoop(tick + 1);
    });
  }

  // 一定不丟例外；回傳是否確定送出。失敗：pttStuck 警告、拉低控制線、每 500 ms 直接重送到成功或連線沒了
  async pttOff({ reason = 'normal' } = {}) {
    const was = this.pttActive;
    if (was && this.freq) this.freq = { ...this.freq, at: this.now() }; // 發射期間不讀頻：有效期從放開才開始算（review B2）
    this.pttActive = false;
    this.cancel(this.pttWatchdog);
    this.pttWatchdog = null;
    this.cancel(this.meterTimer);
    this.meterTimer = null;
    this.cancel(this.pttRetry);
    this.pttRetry = null;
    if (!this.connected || !this.cfg) return false;
    const run = this.sendPttOff().then(() => null, (err) => err ?? new Error('PTT off failed'));
    this.pttOffPending = run;
    const err = await run;
    if (this.pttOffPending === run) this.pttOffPending = null;
    if (this.pttActive) return !err; // 等待中又開始發射：之後的 PTT 關再處理
    if (err) {
      this.pttOffFailed(err);
      return false;
    }
    this.pttOffConfirmed(reason, was);
    return true;
  }

  // CAT：PTT 關指令（插隊）；RTS／DTR：控制線拉低（就是 PTT 關）
  async sendPttOff() {
    const mode = this.cfg.controlMode;
    if (mode === 'cat' || this.set.pttAlwaysCat) await this.sendPriority(this.set.pttOff(this.ctx));
    if (mode === 'rts' || mode === 'dtr') await this.link.setSignals({ rts: false, dtr: false });
  }

  // 重送、強制斷線用：不排隊
  async writePttOffDirect() {
    const mode = this.cfg.controlMode;
    if (mode === 'cat' || this.set.pttAlwaysCat) {
      this.linesLow();
      await this.writeDirect(this.set.pttOff(this.ctx));
    }
    if (mode === 'rts' || mode === 'dtr') await this.link.setSignals({ rts: false, dtr: false });
  }

  // 保險：控制線拉低（CAT 時失敗不算，藍牙 SPP 沒有控制線）
  linesLow() {
    try {
      Promise.resolve(this.link.setSignals({ rts: false, dtr: false })).catch(() => {});
    } catch { /* 盡力而為 */ }
  }

  pttOffFailed(err) {
    this.emit('error', { error: err, during: 'pttOff' });
    this.setStuck(true, err);
    if (!this.connected) return;
    this.linesLow();
    this.pttRetry = this.after(PTT_OFF_RETRY_MS, () => this.retryPttOff());
  }

  async retryPttOff() {
    this.pttRetry = null;
    if (!this.connected || this.pttActive || !this.pttStuck) return;
    try {
      await this.writePttOffDirect();
    } catch (err) {
      if (this.connected && !this.pttActive && this.pttStuck && !this.pttRetry) this.pttOffFailed(err);
      return;
    }
    if (!this.pttActive) this.pttOffConfirmed('retry', true);
  }

  pttOffConfirmed(reason, was) {
    this.writeStuck(false);
    this.lastPttOffAt = this.now();
    this.lastPttCmdAt = this.now();
    this.setStuck(false);
    if (was || reason === 'stuck') this.emit('ptt', { on: false, reason });
    if (this.set.pttVerify && this.cfg.controlMode === 'cat') this.verifyPttOff();
    if (this.pendingHz) {
      const hz = this.pendingHz;
      this.pendingHz = null;
      this.setBandAndMode(hz).catch(() => {});
    }
  }

  setStuck(on, error = null) {
    if (this.pttStuck === on) return;
    this.pttStuck = on;
    this.emit('pttStuck', { stuck: on, error });
  }

  // 分頁關閉（pagehide／beforeunload）：不排隊、同步送出 PTT 關；所有控制方式都拉低 RTS／DTR
  emergencyPttOff() {
    if (!this.connected || !this.cfg) return;
    if (!this.pttActive && !this.pttStuck && !this.readStuck()) return;
    this.pttActive = false;
    const mode = this.cfg.controlMode;
    try {
      if (mode === 'cat' || this.set.pttAlwaysCat) for (const s of this.set.pttOff(this.ctx)) {
        this.decoder?.expect?.(s.expect ?? null);
        this.link.writeNow(s.bytes).catch(() => {});
      }
      this.linesLow();
    } catch { /* 盡力而為；旗標留著，下次連上補送 */ }
  }

  // ICOM：PTT 關後讀 1C 00 確認，仍在發射就重送（IcomRig.verifyPttOffLoop）
  async verifyPttOff() {
    const ic = this.icom;
    if (!ic.verifySupported || ic.verifying) return;
    ic.verifying = true;
    try {
      let noResponse = 0;
      for (let attempt = 1; attempt <= ICOM_VERIFY_ATTEMPTS; attempt++) {
        if (this.pttActive || !this.connected) return;
        const state = await this.queryTx();
        if (state === null) {
          noResponse += 1;
          if (noResponse >= 2) {
            ic.noAnswerStreak += 1;
            if (ic.noAnswerStreak >= ICOM_VERIFY_GIVE_UP) ic.verifySupported = false;
            return;
          }
          continue;
        }
        ic.noAnswerStreak = 0;
        if (!state) return;
        if (this.pttActive || !this.connected) return;
        this.emit('pttResend', { attempt });
        await this.send(this.set.pttOff(this.ctx));
        this.lastPttCmdAt = this.now();
      }
    } catch {
      // 寫入失敗：連線層會回報
    } finally {
      ic.verifying = false;
    }
  }

  queryTx() {
    return new Promise((resolve) => {
      let timer = null;
      const w = (v) => {
        this.cancel(timer);
        resolve(v);
      };
      this.txWaiters.push(w);
      timer = this.after(ICOM_VERIFY_TIMEOUT_MS, () => {
        this.txWaiters = this.txWaiters.filter((x) => x !== w);
        resolve(null);
      });
      this.send([{ bytes: civ.readPtt(this.ctx.civ) }]).catch(() => {});
    });
  }

  readStuck() {
    try {
      return this.storage?.getItem(STUCK_KEY) === '1';
    } catch {
      return false;
    }
  }

  writeStuck(on) {
    try {
      if (on) this.storage?.setItem(STUCK_KEY, '1');
      else this.storage?.removeItem(STUCK_KEY);
    } catch {
      // 無痕模式等
    }
  }
}

// 給 TxController／測試音的 PTT 介面（D12、D20）：mode() 目前控制方式、delayMs() PTT 延遲。
// 選了 CAT／RTS／DTR 就一律走 PTT——電台沒連上時 on() 丟錯、發射停止，不會默默退回 VOX 播音訊
export function pttAdapter(rig, { mode, delayMs }) {
  return {
    active: () => mode() !== 'vox',
    ready: () => rig.controlsPtt,
    on: (o) => rig.pttOn(o),
    off: () => rig.pttOff(),
    delayMs,
    leadMs: modeLeadMs,
  };
}
