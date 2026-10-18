// Web Serial 連線層（add-web-rig-control D2、D6、D15、D16）：開埠、讀迴圈、寫入佇列與逾時、DTR／RTS、斷線、記住授權過的埠。
// 只有這個檔碰 navigator.serial；`serial` 可注入（單元測試的假序列埠、tools/rig-device-check.mjs 的 Node 轉接層）。
// 寫入逾時＝連線中斷（安全審查 #2）：逾時那筆 abort、關埠、通知 onClose，後面的寫入（含 PTT 關）不會排在卡住的寫入後面無限等。
import { rigError } from './errors.mjs';

export const WRITE_TIMEOUT_MS = 2000;
export const STOP_BITS = Object.freeze([1, 2]); // Web Serial 只有 1、2（App 另有 1.5）
export const PARITIES = Object.freeze(['none', 'even', 'odd']); // 沒有 mark、space
export const DATA_BITS = Object.freeze([7, 8]);

// 埠的識別（USB VID／PID）；藍牙 SPP 沒有 VID 時用 bluetoothServiceClassId
export function portInfo(port) {
  const info = port?.getInfo?.() ?? {};
  if (info.usbVendorId !== undefined) return { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId };
  if (info.bluetoothServiceClassId !== undefined) return { bluetoothServiceClassId: String(info.bluetoothServiceClassId) };
  return null;
}

export function sameInfo(a, b) {
  if (!a || !b) return false;
  return a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId && a.bluetoothServiceClassId === b.bluetoothServiceClassId;
}

export function describePort(port) {
  const i = portInfo(port);
  if (!i) return '';
  if (i.usbVendorId !== undefined) return `USB ${i.usbVendorId.toString(16).padStart(4, '0').toUpperCase()}:${(i.usbProductId ?? 0).toString(16).padStart(4, '0').toUpperCase()}`;
  return 'Bluetooth';
}

export class SerialLink {
  constructor({ serial = globalThis.navigator?.serial ?? null, setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (id) => clearTimeout(id) } = {}) {
    Object.assign(this, { serial, setTimeoutFn, clearTimeoutFn });
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.closing = false;
    this.chain = Promise.resolve();
    this.pending = new Set(); // 寫入中的 reject：埠關掉時一起失敗（stream 卡住時 write() 自己不會回）
    this.dataFns = new Set();
    this.closeFns = new Set();
    this.onPortDisconnect = null;
  }

  get supported() {
    return Boolean(this.serial);
  }

  get isOpen() {
    return Boolean(this.port && this.writer);
  }

  onData(fn) {
    this.dataFns.add(fn);
    return () => this.dataFns.delete(fn);
  }

  // fn({ error })：埠意外關閉（拔線、藍牙斷線、讀取致命錯誤）；自己呼叫 close() 不通知
  onClose(fn) {
    this.closeFns.add(fn);
    return () => this.closeFns.delete(fn);
  }

  // 只能在使用者手勢（click）裡呼叫
  async requestPort(options = {}) {
    if (!this.serial) throw rigError('unsupported', 'Web Serial not supported');
    try {
      return await this.serial.requestPort(options);
    } catch (err) {
      if (err?.name === 'NotFoundError') throw rigError('cancelled', err.message, err);
      if (err?.name === 'SecurityError') throw rigError('blocked', err.message, err);
      throw err;
    }
  }

  // 授權過的埠中，找 VID／PID 相同的（不需要手勢）。沒指定 info 時只有一個埠才回傳
  async findGranted(info) {
    if (!this.serial?.getPorts) return null;
    const ports = await this.serial.getPorts();
    if (info) return ports.find((p) => sameInfo(portInfo(p), info)) ?? null;
    return ports.length === 1 ? ports[0] : null;
  }

  // 裝置重新插上（已授權過的）
  onConnectEvent(fn) {
    if (!this.serial?.addEventListener) return () => {};
    const h = (e) => fn(e.target ?? e.port);
    this.serial.addEventListener('connect', h);
    return () => this.serial.removeEventListener('connect', h);
  }

  // requireSignals：RTS／DTR 控 PTT 時控制線一定要拉得低，拉不低就關埠、開埠失敗（安全審查 #10）
  async open(port, { baudRate, dataBits = 8, stopBits = 1, parity = 'none' }, { requireSignals = false } = {}) {
    if (this.port) await this.close();
    if (!Number.isInteger(baudRate) || baudRate <= 0) throw rigError('badSerial', `bad baud rate ${baudRate}`);
    if (!DATA_BITS.includes(dataBits) || !STOP_BITS.includes(stopBits) || !PARITIES.includes(parity)) throw rigError('badSerial', 'bad serial parameters');
    try {
      await port.open({ baudRate, dataBits, stopBits, parity, flowControl: 'none' });
    } catch (err) {
      throw rigError('openFailed', err?.message ?? String(err), err); // 瀏覽器的 'Failed to open serial port.'（被占用）等
    }
    // Chrome 開埠會拉高 DTR、RTS：RTS／DTR 控 PTT 的介面會被鍵下，一開就拉低（D6）
    try {
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (err) {
      // CAT／VOX：有些藍牙 SPP 沒有控制線，照常用；RTS／DTR 控 PTT：拉不低就不能用
      if (requireSignals) {
        try { await port.close(); } catch { /* 關不了也要回報 */ }
        throw rigError('signalsFailed', `cannot lower RTS/DTR: ${err?.message ?? err}`, err);
      }
    }
    this.port = port;
    this.closing = false;
    this.writer = port.writable.getWriter();
    this.chain = Promise.resolve();
    this.onPortDisconnect = () => this.lost(rigError('deviceLost', 'device disconnected'));
    port.addEventListener?.('disconnect', this.onPortDisconnect);
    this.readLoop(port);
  }

  async readLoop(port) {
    let error = null;
    while (this.port === port && port.readable && !this.closing) {
      let reader;
      try {
        reader = port.readable.getReader();
      } catch (err) {
        error = err;
        break;
      }
      this.reader = reader;
      let done = false;
      try {
        for (;;) {
          const r = await reader.read();
          if (r.done) { done = true; break; }
          if (r.value?.length) for (const fn of this.dataFns) fn(r.value);
        }
      } catch (err) {
        error = err; // 非致命錯誤（framing、buffer overrun）後 readable 會重建，再讀；致命錯誤後 readable 為 null
      } finally {
        try { reader.releaseLock(); } catch { /* 已釋放 */ }
        this.reader = null;
      }
      if (done) break;
    }
    if (!this.closing && this.port === port) this.lost(error);
  }

  lost(error) {
    if (!this.port || this.closing) return;
    const port = this.port;
    this.teardown(error);
    port.close?.().catch?.(() => {});
    for (const fn of this.closeFns) fn({ error });
  }

  teardown(error = null) {
    for (const fail of [...this.pending]) fail(error ?? rigError('portNotOpen', 'port not open'));
    this.pending.clear();
    const port = this.port;
    if (port && this.onPortDisconnect) port.removeEventListener?.('disconnect', this.onPortDisconnect);
    try { this.writer?.releaseLock(); } catch { /* 寫入中 */ }
    this.port = null;
    this.writer = null;
    this.onPortDisconnect = null;
  }

  // 依序寫入；每筆有逾時（逾時＝連線中斷，後面的都失敗）
  write(bytes, { timeoutMs = WRITE_TIMEOUT_MS } = {}) {
    const run = () => this.writeNow(bytes, { timeoutMs });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  // 不排隊立刻寫（PTT 關、分頁關閉：等不到佇列）。只跳過 JS 這層的佇列；stream 本身仍一次寫一筆，
  // 卡在 stream 裡的那筆要等逾時（→ 視同斷線）才放開
  writeNow(bytes, { timeoutMs = WRITE_TIMEOUT_MS } = {}) {
    const writer = this.writer;
    if (!writer) return Promise.reject(rigError('portNotOpen', 'port not open'));
    let timer = null;
    let fail = null;
    const timeout = new Promise((_, reject) => {
      fail = reject;
      timer = this.setTimeoutFn(() => reject(rigError('writeTimeout', 'write timeout')), timeoutMs);
    });
    this.pending.add(fail);
    return Promise.race([writer.write(bytes), timeout])
      .catch((err) => {
        if (writer === this.writer) this.writeFailed(err, writer);
        throw err;
      })
      .finally(() => {
        this.pending.delete(fail);
        this.clearTimeoutFn(timer);
      });
  }

  writeFailed(err, writer) {
    if (err?.code === 'writeTimeout') {
      // 卡住的寫入：abort（不等它，abort 要等卡住的那筆結束才 resolve），當成斷線
      try { writer.abort(err).catch(() => {}); } catch { /* 已失效 */ }
      this.lost(err);
      return;
    }
    // 非致命寫入錯誤：Chrome 會重建 writable，換新的 writer 再用；拿不到就是斷線
    try { writer.releaseLock(); } catch { /* 已釋放 */ }
    this.writer = null;
    try {
      if (this.port?.writable) this.writer = this.port.writable.getWriter();
    } catch {
      this.writer = null;
    }
    if (!this.writer) this.lost(err);
  }

  async setSignals({ rts, dtr }) {
    if (!this.port) throw rigError('portNotOpen', 'port not open');
    const s = {};
    if (rts !== undefined) s.requestToSend = Boolean(rts);
    if (dtr !== undefined) s.dataTerminalReady = Boolean(dtr);
    await this.port.setSignals(s);
  }

  async close() {
    const port = this.port;
    if (!port) return;
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* 已關 */ }
    let timer = null;
    await Promise.race([this.chain, new Promise((r) => { timer = this.setTimeoutFn(r, 500); })]);
    this.clearTimeoutFn(timer);
    this.teardown();
    try { await port.close(); } catch { /* 拔掉的埠關不了 */ }
    this.closing = false;
  }
}
