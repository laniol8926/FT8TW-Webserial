// 國赫 Q900／PMR-171 二進位 CAT（add-web-rig-control D4）：A5 A5 A5 A5 <長度> <指令> <資料…> <CRC16 高> <CRC16 低>。
// 長度＝長度 byte 之後的 byte 數（含 CRC）；CRC 算「長度＋指令＋資料」。照 App GuoHeRigConstant.java、CRC16.java、GuoHeQ900Rig.java。

const HEAD = [0xa5, 0xa5, 0xa5, 0xa5];

// CRC16.crc16（CCITT 變形，初值 0xFFFF）
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc = ((crc >>> 8) | (crc << 8)) & 0xffff;
    crc ^= b & 0xff;
    crc ^= (crc & 0xff) >> 4;
    crc ^= (crc << 12) & 0xffff;
    crc ^= ((crc & 0xff) << 5) & 0xffff;
  }
  return crc & 0xffff;
}

// body：指令＋資料（不含長度）
export function packet(cmd, data = []) {
  const payload = [data.length + 3, cmd, ...data];
  const crc = crc16(payload);
  return Uint8Array.from([...HEAD, ...payload, crc >> 8, crc & 0xff]);
}

const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

export const guohe = {
  ptt: (on) => packet(0x07, [on ? 0x00 : 0x01]), // PTT_ON／PTT_OFF
  modeUsb: () => packet(0x0a, [0x00, 0x00]), // USB_MODE
  readFreq: () => packet(0x0b), // READ_FREQ
  setFreq: (hz) => {
    const n = Math.round(hz);
    if (!Number.isFinite(n) || n <= 0 || n > 0xffffffff) throw new Error(`bad frequency ${hz}`);
    return packet(0x09, [...be32(n), ...be32(n)]); // VFOA、VFOB 同頻
  },
};

// 組框：找 A5×4，取長度，收滿後驗 CRC；CRC 錯的丟掉
export class GuoheFramer {
  constructor() {
    this.buf = [];
  }

  push(bytes) {
    this.buf.push(...bytes);
    const out = [];
    for (;;) {
      let h = -1;
      for (let i = 0; i + 3 < this.buf.length; i++) {
        if (this.buf[i] === 0xa5 && this.buf[i + 1] === 0xa5 && this.buf[i + 2] === 0xa5 && this.buf[i + 3] === 0xa5) { h = i; break; }
      }
      if (h < 0) {
        this.buf = this.buf.slice(-3).filter((b) => b === 0xa5);
        break;
      }
      let s = h + 4;
      while (this.buf[s] === 0xa5) s++; // 多餘的 A5
      if (s >= this.buf.length) { this.buf = this.buf.slice(h); break; }
      const len = this.buf[s];
      if (this.buf.length < s + len + 1) { this.buf = this.buf.slice(h); break; }
      const body = this.buf.slice(s, s + len + 1);
      this.buf = this.buf.slice(s + len + 1);
      if (len < 3) continue;
      const crc = crc16(body.slice(0, -2));
      if (crc === ((body.at(-2) << 8) | body.at(-1))) out.push(Uint8Array.from(body));
    }
    return out;
  }

  clear() {
    this.buf = [];
  }
}

// 狀態回應（指令 0x0B）：[長度, 0B, x, x, x, VFOA×4, VFOB×4, 使用中 VFO, …]（GuoHeQ900Rig.java:141-158）
export function guoheEvent(body) {
  if (body[1] !== 0x0b || body.length < 16) return null;
  const u32 = (i) => ((body[i] << 24) >>> 0) + (body[i + 1] << 16) + (body[i + 2] << 8) + body[i + 3];
  const hz = body[13] === 0x00 ? u32(5) : u32(9);
  return hz > 0 ? { freq: hz } : null;
}
