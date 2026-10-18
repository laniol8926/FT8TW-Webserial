// ICOM CI-V（含協谷 G90S／X6100 的 USB 模式，add-web-rig-control D8）：FE FE <電台> <控制者> 指令… FD，頻率為 5 byte 小端 BCD。
// 位元組照 App IcomRigConstant.java；解析照 IcomCommand.java（App 1 GHz 位數 ×1e8 的錯誤不照抄）。

export const CTRL = 0xe0;
const pack = (rig, ...body) => Uint8Array.from([0xfe, 0xfe, rig & 0xff, CTRL, ...body, 0xfd]);

// 頻率 → 5 byte BCD（低位在前）：14 074 000 → 00 40 07 14 00
export function bcdFreq(hz) {
  const n = Math.round(hz);
  if (!Number.isFinite(n) || n <= 0 || n >= 1e10) throw new Error(`bad frequency ${hz}`);
  const d = String(n).padStart(10, '0').split('').map(Number).reverse(); // d[0]＝個位
  return [0, 2, 4, 6, 8].map((i) => (d[i + 1] << 4) | d[i]);
}

export function decodeBcdFreq(data) {
  if (!data || data.length < 5) return null;
  let hz = 0;
  let mul = 1;
  for (let i = 0; i < 5; i++) {
    const lo = data[i] & 0x0f;
    const hi = (data[i] >> 4) & 0x0f;
    if (lo > 9 || hi > 9) return null;
    hz += lo * mul + hi * mul * 10;
    mul *= 100;
  }
  return hz;
}

export const civ = {
  setFreq: (rig, hz) => pack(rig, 0x05, ...bcdFreq(hz)), // setOperationFrequency
  readFreq: (rig) => pack(rig, 0x03), // setReadFreq
  setDataMode: (rig, mode = 1) => pack(rig, 0x26, 0x00, mode, 0x01, 0x01), // setOperationDataMode：USB-D
  setMode: (rig, mode = 1) => pack(rig, 0x06, mode, 0x01), // setOperationMode（協谷 G90S）
  ptt: (rig, on) => pack(rig, 0x1c, 0x00, on ? 1 : 0), // setPTTState
  readPtt: (rig) => pack(rig, 0x1c, 0x00), // readPTTState
  dataSource: (rig, src = 1) => pack(rig, 0x1a, 0x05, 0x01, 0x19, src), // setConnectorDataMode：01＝USB
  readSwr: (rig) => pack(rig, 0x15, 0x12), // getSWRState
  readAlc: (rig) => pack(rig, 0x15, 0x13), // getALCState
  readSmeter: (rig) => pack(rig, 0x15, 0x02), // S 表（Hamlib icom.c icom_get_level：C_RD_SQSM／S_SML）
};

// 分框：從 FE FE 到 FD 為一個封包（含頭尾）；前面的雜訊丟掉，不完整的留著
export class CivFramer {
  constructor({ maxLen = 256 } = {}) {
    this.buf = [];
    this.maxLen = maxLen;
  }

  push(bytes) {
    this.buf.push(...bytes);
    const out = [];
    for (;;) {
      let head = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 0xfe && this.buf[i + 1] === 0xfe) { head = i; break; }
      }
      if (head < 0) {
        this.buf = this.buf.length && this.buf.at(-1) === 0xfe ? [0xfe] : [];
        break;
      }
      let start = head;
      while (this.buf[start + 2] === 0xfe) start++; // FE FE FE（前導）只留最後兩個
      const end = this.buf.indexOf(0xfd, start + 2);
      if (end < 0) {
        this.buf = this.buf.slice(start);
        if (this.buf.length > this.maxLen) this.buf = [];
        break;
      }
      out.push(Uint8Array.from(this.buf.slice(start, end + 1)));
      this.buf = this.buf.slice(end + 1);
    }
    return out;
  }

  clear() {
    this.buf = [];
  }
}

// 解析：只認電台送給控制者（E0 或 00）的封包，電台回送的我方指令（目的是電台）不算（IcomCommand.getCommand）
export function parseFrame(frame, rig) {
  if (!frame || frame.length < 6 || frame[0] !== 0xfe || frame[1] !== 0xfe || frame.at(-1) !== 0xfd) return null;
  if ((frame[2] !== CTRL && frame[2] !== 0x00) || frame[3] !== (rig & 0xff)) return null;
  const body = frame.slice(4, -1);
  return { cmd: body[0], sub: body.length >= 2 ? body[1] : null, body };
}

// 錶值 2 byte BCD：ICOM twoByteBcdToInt（第 2 byte 是個位、十位）；協谷 twoByteBcdToIntBigEnd（第 1 byte 是個位、十位）
export function bcd2(data, { xiegu = false } = {}) {
  if (!data || data.length < 2) return null;
  const [hiByte, loByte] = xiegu ? [data[1], data[0]] : [data[0], data[1]];
  return (loByte & 0x0f) + ((loByte >> 4) & 0x0f) * 10 + (hiByte & 0x0f) * 100 + ((hiByte >> 4) & 0x0f) * 1000;
}

const isBcd = (b) => (b & 0x0f) <= 9 && (b >> 4) <= 9;

// 封包 → 事件：{ freq } | { swrRaw } | { alcRaw } | { smRaw } | { tx }
export function civEvent(frame, rig, { xiegu = false } = {}) {
  const f = parseFrame(frame, rig);
  if (!f) return null;
  if (f.cmd === 0x00 || f.cmd === 0x03) {
    const hz = decodeBcdFreq(f.body.slice(1));
    return hz ? { freq: hz } : null;
  }
  if (f.cmd === 0x15 && f.sub === 0x02 && f.body.length >= 4) {
    // S 表：Hamlib 對 ICOM 與 Xiegu 都用 from_bcd_be（高位在前，add-rig-meters M10）；Xiegu 255＝無效
    const v = bcd2(f.body.slice(2, 4));
    return v === null || !isBcd(f.body[2]) || !isBcd(f.body[3]) || (xiegu && v === 255) ? null : { smRaw: v };
  }
  if (f.cmd === 0x15 && f.body.length >= 4) {
    const v = bcd2(f.body.slice(2, 4), { xiegu });
    if (v === null || (xiegu && v === 255)) return null; // 協谷 255＝無效（XieGuRig.java:166）
    if (f.sub === 0x12) return { swrRaw: v };
    if (f.sub === 0x13) return { alcRaw: v };
  }
  if (f.cmd === 0x1c && f.sub === 0x00 && f.body.length >= 3) return { tx: f.body[2] !== 0 };
  return null;
}
