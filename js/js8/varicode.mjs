// JS8 varicode 解包（RX 方向）：72-bit frame → 可讀內容。
// 移植自 FT8TW Js8Varicode.java（unpackFrame 與其輔助函式；那邊又是對照 JS8Call varicode.cpp）。
// 發射端打包（buildMessageFrames）在 encode.mjs，共用這裡的字表常數。
// 注意：50/28-bit 欄位超過 JS 32-bit 位元運算範圍，一律用乘法累積、Math.floor 除法。
import { decompress } from './jsc.mjs';

export const FRAME_HEARTBEAT = 0;
export const FRAME_COMPOUND = 1;
export const FRAME_COMPOUND_DIRECTED = 2;
export const FRAME_DIRECTED = 3;

// itype 旗標（Js8Frame.TYPE_*）
export const TYPE_FIRST = 1;
export const TYPE_LAST = 2;
export const TYPE_DATA = 4;

export const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@';
export const NBASECALL = 37 * 36 * 10 * 27 * 27 * 27; // 262177560
export const NBASEGRID = 180 * 180;
export const NUSERGRID = NBASEGRID + 10;
export const NMAXGRID = (1 << 15) - 1;

// 特殊呼號/群組：值 = NBASECALL + 1 + 索引
export const BASECALL_NAMES = [
  '<....>', '@ALLCALL', '@JS8NET',
  '@DX/NA', '@DX/SA', '@DX/EU', '@DX/AS', '@DX/AF', '@DX/OC', '@DX/AN',
  '@REGION/1', '@REGION/2', '@REGION/3',
  '@GROUP/0', '@GROUP/1', '@GROUP/2', '@GROUP/3', '@GROUP/4',
  '@GROUP/5', '@GROUP/6', '@GROUP/7', '@GROUP/8', '@GROUP/9',
  '@COMMAND', '@CONTROL', '@NET', '@NTS',
  '@RESERVE/0', '@RESERVE/1', '@RESERVE/2', '@RESERVE/3', '@RESERVE/4',
  '@APRSIS', '@RAGCHEW', '@JS8', '@EMCOMM', '@ARES', '@MARS', '@AMRRON',
  '@RACES', '@RAYNET', '@RADAR', '@SKYWARN', '@CQ', '@HB', '@QSO',
  '@QSOPARTY', '@CONTEST', '@FIELDDAY', '@SOTA', '@IOTA', '@POTA',
  '@QRP', '@QRO',
];

// 導向指令表（directed_cmds）：字串 → 指令值
export const DIRECTED_CMDS = [
  [' HEARTBEAT', -1], [' HB', -1], [' CQ', -1], [' SNR?', 0], ['?', 0], [' DIT DIT', 1],
  [' HEARING?', 3], [' GRID?', 4], ['>', 5], [' STATUS?', 6], [' STATUS', 7], [' HEARING', 8],
  [' MSG', 9], [' MSG TO:', 10], [' QUERY', 11], [' QUERY MSGS', 12], [' QUERY MSGS?', 12],
  [' QUERY CALL', 13], [' GRID', 15], [' INFO?', 16], [' INFO', 17], [' FB', 18], [' HW CPY?', 19],
  [' SK', 20], [' RR', 21], [' QSL?', 22], [' QSL', 23], [' CMD', 24], [' SNR', 25], [' NO', 26],
  [' YES', 27], [' 73', 28], [' NACK', 2], [' ACK', 14], [' HEARTBEAT SNR', 29], [' AGN?', 30],
  ['  ', 31], [' ', 31],
];

// 指令值 → 顯示字串：同值多鍵時取字典序最小者（對照 Qt QMap::key() 語意）
const CMD_STRING = new Map();
for (const [k, v] of DIRECTED_CMDS) {
  const best = CMD_STRING.get(v);
  if (best === undefined || k < best) CMD_STRING.set(v, k);
}
export const cmdString = (cmd) => CMD_STRING.get(cmd) ?? '';

export const CQ_STRINGS = ['CQ CQ CQ', 'CQ DX', 'CQ QRP', 'CQ CONTEST', 'CQ FIELD', 'CQ FD', 'CQ CQ', 'CQ'];

// huffman 表（依 Java LinkedHashMap 的插入順序；UTX Mode A 共用）
export const HUFF_TABLE = [
  [' ', '01'], ['E', '100'], ['T', '1101'], ['A', '0011'], ['O', '11111'], ['I', '11100'],
  ['N', '10111'], ['S', '10100'], ['H', '00011'], ['R', '00000'], ['D', '111011'], ['L', '110011'],
  ['C', '110001'], ['U', '101101'], ['M', '101011'], ['W', '001011'], ['F', '001001'], ['G', '000101'],
  ['Y', '000011'], ['P', '1111011'], ['B', '1111001'], ['.', '1110100'], ['V', '1100101'],
  ['K', '1100100'], ['-', '1100001'], ['+', '1100000'], ['?', '1011001'], ['!', '1011000'],
  ['"', '1010101'], ['X', '1010100'], ['0', '0010101'], ['J', '0010100'], ['1', '0010001'],
  ['Q', '0010000'], ['2', '0001001'], ['Z', '0001000'], ['3', '0000101'], ['5', '0000100'],
  ['4', '11110101'], ['9', '11110100'], ['8', '11110001'], ['6', '11110000'], ['7', '11101011'],
  ['/', '11101010'],
];

// 後續資料要附 checksum16 的緩衝指令（MSG、MSG TO:、>、QUERY…）
export function isChecksummedCmd(cmd) {
  return cmd === 5 || cmd === 9 || cmd === 10 || cmd === 11 || cmd === 12 || cmd === 13 || cmd === 24;
}

// ===== checksum16：CRC-16/KERMIT + base-41 三碼 =====

const ALPHABET41 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-./?';

// 與 Java String.getBytes(UTF_8) 相同：落單的 surrogate 編成 '?'（TextEncoder 會給 U+FFFD，不能用）
function utf8BytesJava(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      const cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else if (c >= 0xd800 && c <= 0xdfff) out.push(0x3f);
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function crc16Kermit(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
  }
  return crc & 0xffff;
}

function pack16bits(packed) {
  const a = Math.trunc(packed / (41 * 41));
  const b = Math.trunc((packed - a * 41 * 41) / 41);
  return ALPHABET41[a] + ALPHABET41[b] + ALPHABET41[packed % 41];
}

export const checksum16 = (input) => pack16bits(crc16Kermit(utf8BytesJava(input)));

// 驗證尾端「空白+3碼」checksum；吻合回傳剝掉後的文字，否則 null
export function stripChecksum16(text) {
  if (text.length < 5) return null;
  const body = text.slice(0, -4);
  if (text[text.length - 4] !== ' ') return null;
  return checksum16(body) === text.slice(-3) ? body : null;
}

// ===== 解包 =====

const bitAt = (p, i) => (p[i >> 3] >> (7 - (i & 7))) & 1;

function bitsOf(p, start, len) {
  let v = 0;
  for (let i = start; i < start + len; i++) v = v * 2 + bitAt(p, i);
  return v;
}

function bitString(p) {
  let s = '';
  for (let i = 0; i < 72; i++) s += bitAt(p, i);
  return s;
}

function unpackAlphaNumeric50(packed) {
  const w = new Array(11);
  const take = (radix) => {
    const r = packed % radix;
    packed = Math.floor(packed / radix);
    return r;
  };
  for (const pos of [10, 9, 8]) w[pos] = ALPHANUMERIC[take(38)];
  w[7] = take(2) ? '/' : ' ';
  for (const pos of [6, 5, 4]) w[pos] = ALPHANUMERIC[take(38)];
  w[3] = take(2) ? '/' : ' ';
  for (const pos of [2, 1]) w[pos] = ALPHANUMERIC[take(38)];
  w[0] = ALPHANUMERIC[packed % 39];
  return w.join('').replaceAll(' ', '');
}

function unpackCallsign28(value, portable) {
  const bi = value - NBASECALL - 1;
  if (bi >= 0 && bi < BASECALL_NAMES.length) return BASECALL_NAMES[bi];
  const w = new Array(6);
  w[5] = ALPHANUMERIC[(value % 27) + 10];
  value = Math.floor(value / 27);
  w[4] = ALPHANUMERIC[(value % 27) + 10];
  value = Math.floor(value / 27);
  w[3] = ALPHANUMERIC[(value % 27) + 10];
  value = Math.floor(value / 27);
  w[2] = ALPHANUMERIC[value % 10];
  value = Math.floor(value / 10);
  w[1] = ALPHANUMERIC[value % 36];
  value = Math.floor(value / 36);
  w[0] = ALPHANUMERIC[value];
  let callsign = w.join('');
  if (callsign.startsWith('3D0')) callsign = '3DA0' + callsign.slice(3);
  if (callsign[0] === 'Q' && callsign[1] >= 'A' && callsign[1] <= 'Z') callsign = '3X' + callsign.slice(1);
  callsign = callsign.trim();
  return portable ? callsign + '/P' : callsign;
}

// 15-bit → 4 碼網格；超出範圍回空字串（此範圍內的浮點運算都是精確整數）
export function unpackGrid(value) {
  if (value > NBASEGRID) return '';
  const dlat = (value % 180) - 90;
  let dlong = Math.trunc(value / 180) * 2 - 180 + 2;
  if (dlong < -180) dlong += 360;
  if (dlong > 180) dlong -= 360;
  const nlong = Math.trunc((60 * (180 - dlong)) / 5);
  const n1 = Math.trunc(nlong / 240);
  const n2 = Math.trunc((nlong - 240 * n1) / 24);
  const nlat = Math.trunc((60 * (dlat + 90)) / 2.5);
  const m1 = Math.trunc(nlat / 240);
  const m2 = Math.trunc((nlat - 240 * m1) / 24);
  const ch = (base, n) => String.fromCharCode(base.charCodeAt(0) + n);
  return ch('A', n1) + ch('A', m1) + ch('0', n2) + ch('0', m2);
}

// Java String.format("%+03d")
const formatSnr = (n) => (n < 0 ? '-' : '+') + String(Math.abs(n)).padStart(2, '0');

function huffDecode(bits) {
  let out = '';
  let i = 0;
  outer: while (i < bits.length) {
    for (const [ch, code] of HUFF_TABLE) {
      if (bits.startsWith(code, i)) {
        out += ch;
        i += code.length;
        continue outer;
      }
    }
    break;
  }
  return out;
}

/**
 * 解包一個 72-bit frame。payload：9 bytes（Uint8Array 或數字陣列），itype：First/Last/Data 旗標。
 * 回傳欄位同 Java UnpackedFrame；完全無法解讀時 text 為空字串。
 * JSC 詞表未載入時 JSC 資料 frame 的 text 為空字串（同 Java 載入失敗）。
 */
export function unpackFrame(payload, itype) {
  const r = {
    frameType: 0, text: '', isData: false, callsignFrom: '', directedCmd: -1,
    callsignTo: '', grid: '', isCq: false, isHeartbeat: false, dataBits: null,
  };

  if (itype & TYPE_DATA) {
    // 快速資料 frame：全 72 bits 都是 JSC 位元流
    r.frameType = -1;
    r.isData = true;
    const s = bitString(payload);
    const end = s.lastIndexOf('0'); // padding：一個 0 之後全是 1
    if (end <= 0) return r;
    r.dataBits = s.slice(0, end);
    r.text = decompress(r.dataBits);
    return r;
  }

  if (bitAt(payload, 0) === 1) {
    // legacy 資料 frame：[1][compressed][70 bits]
    r.frameType = -1;
    r.isData = true;
    const s = bitString(payload);
    const end = s.lastIndexOf('0');
    if (end <= 2) return r;
    r.dataBits = s.slice(2, end);
    r.text = s[1] === '1' ? decompress(r.dataBits) : huffDecode(r.dataBits);
    return r;
  }

  const type = bitsOf(payload, 0, 3);
  r.frameType = type;

  if (type === FRAME_DIRECTED) {
    const from = unpackCallsign28(bitsOf(payload, 3, 28), bitAt(payload, 64) === 1);
    const to = unpackCallsign28(bitsOf(payload, 31, 28), bitAt(payload, 65) === 1);
    const cmd5 = bitsOf(payload, 59, 5);
    const num6 = bitsOf(payload, 66, 6);
    r.callsignFrom = from;
    r.callsignTo = to;
    r.directedCmd = cmd5;
    r.text = `${from}: ${to}${cmdString(cmd5)}` + (num6 !== 0 ? ' ' + formatSnr(num6 - 31) : '');
    return r;
  }

  // 其餘（type 0..2）：heartbeat / compound / compound directed
  const callsign = unpackAlphaNumeric50(bitsOf(payload, 3, 50));
  const num = bitsOf(payload, 53, 11) * 32 + bitsOf(payload, 64, 5);
  const bits3 = bitsOf(payload, 69, 3);
  r.callsignFrom = callsign;

  if (type === FRAME_HEARTBEAT) {
    const isAlt = (num & (1 << 15)) !== 0;
    const grid = unpackGrid(num & 0x7fff);
    r.grid = grid;
    r.isCq = isAlt;
    r.isHeartbeat = !isAlt;
    r.text = `${callsign}: ${isAlt ? CQ_STRINGS[bits3] : 'HB'} ${grid}`.trim();
  } else if (type === FRAME_COMPOUND) {
    r.grid = unpackGrid(num);
    r.text = `${callsign} ${r.grid}`.trim();
  } else if (num >= NUSERGRID && num < NMAXGRID) {
    const packed = num - NUSERGRID;
    if (packed & (1 << 7)) {
      const cmd = packed & (1 << 6) ? ' HEARTBEAT SNR' : ' SNR';
      r.text = `${callsign}${cmd} ${formatSnr((packed & 63) - 31)}`;
    } else {
      r.text = callsign + cmdString(packed & 127);
    }
  } else {
    r.text = callsign;
  }
  return r;
}
