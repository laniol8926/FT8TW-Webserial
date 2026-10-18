// Kenwood／Yaesu 新式 ASCII CAT（add-web-rig-control D4）：指令＝兩個英文字母＋資料＋結尾（`;`，TK-90 為 `\r`）。
// 純函式，不碰 Web Serial。解析規則照 App Yaesu3Command.java、ElecraftCommand.java（App 的已知錯誤另註）。

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ascii = (text) => encoder.encode(text);
export const asciiText = (bytes) => decoder.decode(bytes);

// 設頻：FA＋補零的頻率＋結尾（App 以 String.format("FA%0nd;")）
export function freqCommand(hz, digits, term = ';') {
  const n = Math.round(hz);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad frequency ${hz}`);
  return `FA${String(n).padStart(digits, '0')}${term}`;
}

// 分框：`;`、`\r`、`\n` 都當結尾（QMX、TS-590 驅動把 \r 換成 ;）。回傳完整的指令字串（不含結尾），不完整的留著等下一塊。
// 緩衝超過 maxLen 就清掉（App 防呆：異常資料不要無限成長）
export class AsciiFramer {
  constructor({ maxLen = 1000 } = {}) {
    this.buf = '';
    this.maxLen = maxLen;
  }

  push(bytes) {
    this.buf += typeof bytes === 'string' ? bytes : asciiText(bytes);
    const parts = this.buf.split(/[;\r\n]/);
    this.buf = parts.pop();
    if (this.buf.length > this.maxLen) this.buf = '';
    return parts.map((s) => s.trim()).filter(Boolean);
  }

  clear() {
    this.buf = '';
  }
}

// 指令：前兩個字元是英文字母才算（Yaesu3Command.getCommand）
export function parseCommand(text) {
  if (typeof text !== 'string' || text.length < 2 || !/^[A-Za-z]{2}/.test(text)) return null;
  return { id: text.slice(0, 2).toUpperCase(), data: text.slice(2) };
}

// FA／FB 的頻率（Yaesu3Command.getFrequency）；不是數字或 0 回 null
export function frequencyOf(cmd) {
  if (!cmd || (cmd.id !== 'FA' && cmd.id !== 'FB') || !/^\d+$/.test(cmd.data)) return null;
  const hz = Number(cmd.data);
  return hz > 0 ? hz : null;
}

// 錶值解析：回傳原始值（尚未換算成 SWR），不是 SWR 讀數回 null
export const METER_PARSERS = {
  // TS-590／2000／570：RM1nnnn（Yaesu3Command.is590MeterSWR／get590ALCOrSWR：charAt(0)=='1'、substring(1,5)）
  rm590: (cmd) => (cmd.id === 'RM' && cmd.data.length >= 5 && cmd.data[0] === '1' && /^\d{4}/.test(cmd.data.slice(1)) ? Number(cmd.data.slice(1, 5)) : null),
  // FT-891／991：RM6nnn（isSWRMeter39：長度 ≥4、charAt(0)=='6'、substring(1,4)）
  rm39: (cmd) => (cmd.id === 'RM' && cmd.data.length >= 4 && cmd.data[0] === '6' && /^\d{3}/.test(cmd.data.slice(1)) ? Number(cmd.data.slice(1, 4)) : null),
  // FT-950／2000／450／DX10／Wolf：RM6nnn000（isSWRMeter38：長度 ≥7）
  rm38: (cmd) => (cmd.id === 'RM' && cmd.data.length >= 7 && cmd.data[0] === '6' && /^\d{3}/.test(cmd.data.slice(1)) ? Number(cmd.data.slice(1, 4)) : null),
  // Yaesu ALC（add-rig-autosetup A15）：RM4nnn000（isALCMeter38）／RM4nnn（isALCMeter39，Yaesu3Command.java:88-113）
  alc38: (cmd) => (cmd.id === 'RM' && cmd.data.length >= 7 && cmd.data[0] === '4' && /^\d{3}/.test(cmd.data.slice(1)) ? Number(cmd.data.slice(1, 4)) : null),
  alc39: (cmd) => (cmd.id === 'RM' && cmd.data.length >= 4 && cmd.data[0] === '4' && /^\d{3}/.test(cmd.data.slice(1)) ? Number(cmd.data.slice(1, 4)) : null),
  // QMX：SWnnn → n.nn（QrpQmxRig.java:539：swData.substring(0,1)+"."+substring(1)）；回傳的是 SWR 本身
  qmxSw: (cmd) => (cmd.id === 'SW' && /^\d{3,}$/.test(cmd.data) ? Number(`${cmd.data[0]}.${cmd.data.slice(1)}`) : null),
  // Elecraft：SWR; 回 SWRnnn;（十分之一）。App 把 'R' 也當數字（ElecraftCommand.java:73-75 會丟例外），這裡跳過 'R'
  elecraftSwr: (cmd) => {
    if (cmd.id !== 'SW') return null;
    const m = /^R?(\d{3})/.exec(cmd.data);
    return m ? Number(m[1]) : null;
  },
};

// S 表回應（add-rig-meters）：SM0nnnn（Kenwood SM0;，P1＋4 位）／SMnnnn（SM;）／SM0nnn（Yaesu SM0;，P1＋3 位）／SMnnn（QMX，device 2026-10-09）。
// 只送主接收機（P1＝0）：5 位去掉 P1；4 位時不論是「P1＋3 位」或「4 位」數值都一樣。不是 S 表回 null
export function smeterOf(cmd) {
  if (!cmd || cmd.id !== 'SM' || !/^\d{3,5}$/.test(cmd.data)) return null;
  return Number(cmd.data.length === 5 ? cmd.data.slice(1) : cmd.data);
}

// QMX 保護（QrpQmxRig.java:248-280）：韌體 ≥ 1_04_004 才有 SR;
export function firmwareSupportsSr(version) {
  const m = /^(\d+)_(\d+)_(\d+)/.exec(String(version ?? '').trim());
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  if (major !== 1) return major > 1;
  if (minor !== 4) return minor > 4;
  return patch >= 4;
}

// LC; 回應的狀態字元：錨定在頂列頻率欄右邊那一格（不能掃整列：VFO A／B 也是 ASCII）。找不到回 null
const LCD_FREQ = /\d{1,2}[.,]\d{3}[.,]\d{2}/;
export function lcdStatusChar(lcd) {
  if (typeof lcd !== 'string' || lcd.length < 10) return null;
  const top = lcd.length >= 16 ? lcd.slice(0, 16) : lcd;
  const m = LCD_FREQ.exec(top);
  if (!m || m.index > 1) return null;
  const end = m.index + m[0].length;
  return end < top.length ? top[end] : ' ';
}
