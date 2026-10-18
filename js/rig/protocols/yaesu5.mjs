// Yaesu 舊式 5-byte CAT（FT-817／818／857／897、FT-847、mcHF、KN990，add-web-rig-control D9）。
// 指令＝4 byte 參數＋1 byte 操作碼（Yaesu2RigConstant.java）；回應沒有結尾記號，長度依「上一筆查詢」決定：
// 讀頻 5（4 byte BCD＋模式）、讀錶 2、TX 狀態 1；其他指令（PTT、設頻、模式）電台可能回 1 byte 確認，丟掉。

const cmd = (op, p0 = 0, p1 = 0, p2 = 0, p3 = 0) => Uint8Array.from([p0, p1, p2, p3, op]);
const bcdByte = (hi, lo) => (hi << 4) | lo;

// 設頻：頻率÷10 的 8 位 BCD（大端）＋ 01。App 的最後一個 byte 用 freq%100 當低位（Yaesu2RigConstant.java:95），
// 頻率末兩位不是 00 時會錯；所有標準撥號頻率末兩位都是 00，位元組與 App 相同
export function setFreq(hz) {
  const n = Math.round(hz / 10);
  if (!Number.isFinite(n) || n <= 0 || n >= 1e8) throw new Error(`bad frequency ${hz}`);
  const d = String(n).padStart(8, '0').split('').map(Number);
  return cmd(0x01, bcdByte(d[0], d[1]), bcdByte(d[2], d[3]), bcdByte(d[4], d[5]), bcdByte(d[6], d[7]));
}

export const yaesu5 = {
  setFreq,
  readFreq: () => cmd(0x03),
  modeDig: () => cmd(0x07, 0x0a), // setOperationUSBMode 實際送 DIG
  modeUsb: () => cmd(0x07, 0x01), // setOperationUSB847Mode
  ptt: (on) => cmd(on ? 0x08 : 0x88),
  readMeter: () => cmd(0xbd),
  readTxStatus: () => cmd(0xf7),
  readRxStatus: () => cmd(0xe7), // 讀接收狀態，回 1 byte（Hamlib ft817.c「get RX status」；低 4 bit／FT-847 低 5 bit 是 S 表）
  catOn: () => cmd(0x00), // FT-847 連線後送 5 個 0
  catOff: () => cmd(0x80), // FT-847 斷線前送 4 個 0 加 80
};

// 5 byte 讀頻回應 → Hz。App 把 byte 3 乘 10000／1000（Yaesu2Command.java:14-15），這裡照規格是 100 Hz／10 Hz
export function decodeFreq(data) {
  if (!data || data.length < 4) return null;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const hi = (data[i] >> 4) & 0x0f;
    const lo = data[i] & 0x0f;
    if (hi > 9 || lo > 9) return null;
    n = n * 100 + hi * 10 + lo;
  }
  return n > 0 ? n * 10 : null;
}

// 回應組框：expect(kind, len) 在送查詢時呼叫（也清掉之前殘留的確認 byte）；沒有期待時收到的都丟掉
export class Yaesu5Framer {
  constructor() {
    this.want = null;
    this.buf = [];
  }

  expect(kind, len) {
    this.want = kind ? { kind, len } : null;
    this.buf = [];
  }

  push(bytes) {
    if (!this.want) return [];
    this.buf.push(...bytes);
    if (this.buf.length < this.want.len) return [];
    const out = { kind: this.want.kind, data: Uint8Array.from(this.buf.slice(0, this.want.len)) };
    this.want = null;
    this.buf = [];
    return [out];
  }

  clear() {
    this.expect(null);
  }
}

// 回應 → 事件
export function yaesu5Event({ kind, data }) {
  if (kind === 'freq') {
    const hz = decodeFreq(data);
    return hz ? { freq: hz } : null;
  }
  if (kind === 'meter') return { swrRaw: (data[1] & 0xf0) >> 4, alcRaw: data[0] & 0x0f }; // Yaesu2Rig.java:302-303
  if (kind === 'rx') return { smRaw: data[0] }; // 換算時再依機型取低位（add-rig-meters M7）
  if (kind === 'txStatus') return { tx: (data[0] & 0x80) === 0 }; // bit7=0 → 發射中
  return null;
}
