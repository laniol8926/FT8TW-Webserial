// JS8 發射端打包：使用者輸入的文字 → 一串 72-bit frame（payload 9 bytes＋itype 旗標）。
// 移植自 FT8TW Js8Varicode.buildMessageFrames（與其 pack* 輔助函式；那邊又是對照 JS8Call varicode.cpp）。
// 行為以 FT8TW Java（JDK 17 語意）為準，tools/js8golden 以原 Java 產生黃金向量逐筆比對。
//
// Java 與 JS 的差異在這裡逐一抹平：
//   - 正則 \s 在 Java 只有 ASCII 空白，\b 以 Character.isLetterOrDigit 判斷（含中日韓字），
//     $ 也吻合結尾換行符之前 → 以等價的字元類／lookaround 改寫（u 旗標）
//   - String.trim() 只去掉 ≤ U+0020；Character.isWhitespace、Character.toUpperCase(char) 各自模擬
import {
  ALPHANUMERIC, NBASECALL, NUSERGRID, NMAXGRID, BASECALL_NAMES, DIRECTED_CMDS, CQ_STRINGS, HUFF_TABLE,
  FRAME_HEARTBEAT, FRAME_COMPOUND, FRAME_COMPOUND_DIRECTED, FRAME_DIRECTED, TYPE_FIRST, TYPE_LAST, TYPE_DATA,
  isChecksummedCmd, checksum16,
} from './varicode.mjs';
import { compress, isJscLoaded } from './jsc.mjs';
import { encode as utxEncode, isUtxLoaded } from './utx.mjs';
import { t } from '../i18n/index.mjs';

const BASECALLS = new Map(BASECALL_NAMES.map((n, i) => [n, NBASECALL + 1 + i]));
const CMDS = new Map(DIRECTED_CMDS);
const HUFF = new Map(HUFF_TABLE);

// ===== Java 字串語意 =====

/** Java String.trim()：只去掉頭尾 ≤ U+0020 的字元 */
function javaTrim(s) {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) <= 0x20) a++;
  while (b > a && s.charCodeAt(b - 1) <= 0x20) b--;
  return s.slice(a, b);
}

// Java Character.isWhitespace（JDK 17）：Unicode 空白分隔符扣掉不換行空白，加上 ASCII 控制空白
const JAVA_WS = new Set([9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x205f, 0x3000]);

// Character.toUpperCase(char) 是單字元對映；JS toUpperCase 遇到特殊大小寫會變多字元。
// 多字元時 Java 多半維持原字，只有希臘文 ypogegrammeni 這幾個有單字元的 titlecase 形式
const UPPER_SIMPLE = new Map([[0x1fb3, 0x1fbc], [0x1fc3, 0x1fcc], [0x1ff3, 0x1ffc]]);
for (const base of [0x1f80, 0x1f90, 0x1fa0]) for (let i = 0; i < 8; i++) UPPER_SIMPLE.set(base + i, base + i + 8);

/** 逐 UTF-16 單元大寫（長度不變、索引對齊），同 Java upperShadow */
function upperShadow(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const u = ch.toUpperCase();
    if (u.length === 1) out += u;
    else {
      const simple = UPPER_SIMPLE.get(ch.charCodeAt(0));
      out += simple === undefined ? ch : String.fromCharCode(simple);
    }
  }
  return out;
}

// ===== 正則（對照 Js8Varicode.java；\s、\b、$ 改寫成 Java 語意）=====

const SP = '[ \\t\\n\\x0B\\f\\r]';
const WORD = '[\\p{L}\\p{Nd}_]';
const WB = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const END = '(?=\\r\\n$|[\\r\\u0085\\u2028\\u2029]$|(?<!\\r)\\n$|$)';

const CALLSIGN_PATTERN = '(?<callsign>[@]?[A-Z0-9/]+)';
const OPTIONAL_CMD_PATTERN = `(?<cmd>${SP}?(?:AGN[?]|QSL[?]|HW CPY[?]|MSG TO[:]|SNR[?]|INFO[?]|GRID[?]|STATUS[?]`
  + '|QUERY MSGS[?]|HEARING[?]|(?:(?:STATUS|HEARING|QUERY CALL|QUERY MSGS|QUERY'
  + `|CMD|MSG|NACK|ACK|73|YES|NO|HEARTBEAT SNR|SNR|QSL|RR|SK|FB|INFO|GRID|DIT DIT)(?=[ ]|${END}))|[?> ]))?`;
const OPTIONAL_GRID_PATTERN = `(?<grid>${SP}?[A-R]{2}[0-9]{2})?`;
const OPTIONAL_NUM_PATTERN = `(?<num>(?<=SNR)${SP}?[-+]?(?:3[01]|[0-2]?[0-9]))?`;

const DIRECTED_RE = new RegExp(`^${CALLSIGN_PATTERN}${OPTIONAL_CMD_PATTERN}${OPTIONAL_NUM_PATTERN}`, 'u');
const HEARTBEAT_RE = new RegExp(
  `^${SP}*(?<callsign>[@](?:ALLCALL|HB)${SP}+)?(?<type>CQ CQ CQ|CQ DX|CQ QRP|CQ CONTEST`
  + `|CQ FIELD|CQ FD|CQ CQ|CQ|HB|HEARTBEAT(?!${SP}+SNR))(?:${SP}(?<grid>[A-R]{2}[0-9]{2}))?${WB}`, 'u');
const COMPOUND_RE = new RegExp(
  `^${SP}*[\`]${CALLSIGN_PATTERN}(?<extra>${OPTIONAL_GRID_PATTERN}${OPTIONAL_CMD_PATTERN}${OPTIONAL_NUM_PATTERN})`, 'u');
const BASE_CALLSIGN_RE = new RegExp(
  `(?<callsign>${WB}(?<base>([0-9A-Z])?([0-9A-Z])([0-9])([A-Z])?([A-Z])?([A-Z])?)(?<portable>[/][P])?${WB})`, 'u');
const COMPOUND_CALLSIGN_SRC = `(?<callsign>(?:[@]?|${WB})(?<extended>[A-Z0-9/@][A-Z0-9/]{0,2}[/]?[A-Z0-9/]{0,3}`
  + `[/]?[A-Z0-9/]{0,3})${WB})`;
const ANCHORED_COMPOUND_CALLSIGN_RE = new RegExp(`^${COMPOUND_CALLSIGN_SRC}`, 'u');
const PACK_CALLSIGN_RE = /([0-9A-Z ])([0-9A-Z])([0-9])([A-Z ])([A-Z ])([A-Z ])/;
const HAS_ALNUM_MIX_RE = /[0-9][A-Z]|[A-Z][0-9]/;

// ===== 位元工具 =====

const bitsOf = (v, n) => v.toString(2).padStart(n, '0');

/** 72 個 '0'/'1' → 9 bytes（MSB first） */
function payloadFromBits(bits) {
  const p = new Uint8Array(9);
  for (let i = 0; i < 72; i++) if (bits[i] === '1') p[i >> 3] |= 0x80 >>> (i & 7);
  return p;
}

// ===== 網格／呼號／數值打包 =====

/** 4 碼 Maidenhead → 15-bit 值；不足 4 碼回 NMAXGRID（Java float 運算與 int 截斷） */
function packGrid(value) {
  const grid = javaTrim(value ?? '');
  if (grid.length < 4) return NMAXGRID;
  const g = grid.slice(0, 4).toUpperCase() + 'mm';
  const c = (i) => g.charCodeAt(i);
  const f = Math.fround;
  const nlong = 180 - 20 * (c(0) - 65);
  const n20d = 2 * (c(2) - 48);
  const xminlong = f(5 * f(c(4) - 97 + 0.5));
  const dlong = f(f(nlong - n20d) - f(xminlong / 60));
  const nlat = -90 + 10 * (c(1) - 65) + (c(3) - 48);
  const xminlat = f(2.5 * f(c(5) - 97 + 0.5));
  const dlat = f(nlat + f(xminlat / 60));
  const ilong = Math.trunc(dlong);
  const ilat = Math.trunc(f(dlat + 90));
  return Math.trunc((ilong + 180) / 2) * 180 + ilat;
}

/** 標準呼號 → 28-bit 值與 /P 旗標；無法打包回 value 0 */
function packCallsign(value) {
  let callsign = javaTrim(value.toUpperCase());
  const base = BASECALLS.get(callsign);
  if (base !== undefined) return { value: base, portable: false };
  let portable = false;
  if (callsign.endsWith('/P')) {
    callsign = callsign.slice(0, -2);
    portable = true;
  }
  // 史瓦帝尼／幾內亞前綴的官方 workaround
  if (callsign.startsWith('3DA0')) callsign = '3D0' + callsign.slice(4);
  if (callsign.startsWith('3X') && callsign.length > 2 && callsign[2] >= 'A' && callsign[2] <= 'Z') {
    callsign = 'Q' + callsign.slice(2);
  }
  const slen = callsign.length;
  if (slen < 2 || slen > 6) return { value: 0, portable };
  const perms = [callsign];
  if (slen === 2) perms.push(` ${callsign}   `);
  if (slen === 3) perms.push(` ${callsign}  `, `${callsign}   `);
  if (slen === 4) perms.push(` ${callsign} `, `${callsign}  `);
  if (slen === 5) perms.push(` ${callsign}`, `${callsign} `);
  let matched = '';
  for (const p of perms) {
    const m = PACK_CALLSIGN_RE.exec(p);
    if (m) matched = m[0]; // 所有排列都跑完，留最後一個吻合的
  }
  if (matched.length < 6) return { value: 0, portable };
  const ix = (i) => ALPHANUMERIC.indexOf(matched[i]);
  let packed = ix(0);
  packed = 36 * packed + ix(1);
  packed = 10 * packed + ix(2);
  packed = 27 * packed + ix(3) - 10;
  packed = 27 * packed + ix(4) - 10;
  packed = 27 * packed + ix(5) - 10;
  return { value: packed, portable };
}

/** 任意（含複合）呼號 → 50-bit 值（混合基數 39/38/38/2/38/38/38/2/38/38/38，總值 < 2^53） */
function packAlphaNumeric50(value) {
  let w = '';
  for (const c of value.toUpperCase()) if (ALPHANUMERIC.includes(c)) w += c;
  if (w.length > 3 && w[3] !== '/') w = w.slice(0, 3) + ' ' + w.slice(3);
  if (w.length > 7 && w[7] !== '/') w = w.slice(0, 7) + ' ' + w.slice(7);
  w = w.padEnd(11, ' ');
  const ix = (i) => ALPHANUMERIC.indexOf(w[i]);
  let packed = ix(0);
  packed = packed * 38 + ix(1);
  packed = packed * 38 + ix(2);
  packed = packed * 2 + (w[3] === '/' ? 1 : 0);
  packed = packed * 38 + ix(4);
  packed = packed * 38 + ix(5);
  packed = packed * 38 + ix(6);
  packed = packed * 2 + (w[7] === '/' ? 1 : 0);
  packed = packed * 38 + ix(8);
  packed = packed * 38 + ix(9);
  packed = packed * 38 + ix(10);
  return packed;
}

/** SNR 等數字 → 1..62（+31 偏移）；空字串回 { n: 0, ok: false } */
function packNum(num) {
  if (num == null || javaTrim(num) === '') return 0;
  const inum = Number.parseInt(javaTrim(num), 10); // 正則保證是 [-+]?\d{1,2}
  return Math.max(-30, Math.min(inum, 31)) + 30 + 1;
}

/** 指令（可含 SNR 數值）→ nusergrid 以上空間的值 */
function packCmd(cmd, num) {
  if (cmd === 25 || cmd === 29) return (((1 << 1) | (cmd === 29 ? 1 : 0)) << 6) + (num & 63);
  return cmd & 127;
}

// ===== 呼號合法性 =====

function isValidCompoundCallsign(callsign) {
  const slashes = callsign.split('/').length - 1;
  if (callsign.length - slashes > 9) return false;
  const idx = callsign.indexOf('/');
  if (idx !== -1) return !BASECALLS.has(callsign.slice(0, idx));
  if (callsign.startsWith('@')) return true;
  return callsign.length > 2 && HAS_ALNUM_MIX_RE.test(callsign);
}

const fullMatch = (re, s) => {
  const m = re.exec(s);
  return m !== null && m[0].length === s.length ? m : null;
};

/** 是否為可用呼號（標準或複合）；compound 表示需要用複合 frame 傳呼號本體 */
function validCallsign(callsign) {
  if (BASECALLS.has(callsign)) return { valid: true, compound: false };
  if (fullMatch(BASE_CALLSIGN_RE, callsign)) {
    return { valid: callsign.length > 2 && HAS_ALNUM_MIX_RE.test(callsign), compound: false };
  }
  const c = fullMatch(ANCHORED_COMPOUND_CALLSIGN_RE, callsign);
  if (c) {
    const valid = isValidCompoundCallsign(c[0]);
    return { valid, compound: valid };
  }
  return { valid: false, compound: false };
}

function isCompoundCallsign(callsign) {
  if (BASECALLS.has(callsign) && !callsign.startsWith('@')) return false;
  if (fullMatch(BASE_CALLSIGN_RE, callsign)) return false;
  const c = fullMatch(ANCHORED_COMPOUND_CALLSIGN_RE, callsign);
  return c !== null && isValidCompoundCallsign(c[0]);
}

// ===== frame 打包（回 { payload, consumed } 或 null）=====

/** [3:type][50:呼號][11:num 高位][5:num 低位][3:bits3] */
function packCompoundFrame(callsign, type, num, bits3) {
  const packed = packAlphaNumeric50(callsign);
  if (packed === 0) return null;
  return payloadFromBits(bitsOf(type & 7, 3) + bitsOf(packed % 2 ** 50, 50)
    + bitsOf((num >> 5) & 0x7ff, 11) + bitsOf(num & 31, 5) + bitsOf(bits3 & 7, 3));
}

/** CQ／HB（heartbeat）frame */
function packHeartbeatMessage(text, callsign) {
  const m = HEARTBEAT_RE.exec(text);
  if (!m) return null;
  const { grid, type } = m.groups;
  let extra = NMAXGRID;
  if (grid !== undefined) extra = packGrid(grid);
  let cqNumber = 0; // HB 一律 0
  if (type.startsWith('CQ')) {
    extra |= 1 << 15;
    cqNumber = CQ_STRINGS.indexOf(type);
  }
  const payload = packCompoundFrame(callsign, FRAME_HEARTBEAT, extra, cqNumber);
  return payload && { payload, consumed: m[0].length };
}

/** 反引號開頭的複合呼號 frame：`KN4CRD/P EM73 或 `KN4CRD/P SNR +10 */
function packCompoundMessage(text) {
  const m = COMPOUND_RE.exec(text);
  if (!m) return null;
  const { callsign, grid, cmd, num } = m.groups;
  let type = FRAME_COMPOUND;
  let extra = NMAXGRID;
  if (cmd !== undefined && CMDS.has(cmd)) {
    extra = NUSERGRID + packCmd(CMDS.get(cmd), packNum(num));
    type = FRAME_COMPOUND_DIRECTED;
  } else if (grid !== undefined) {
    extra = packGrid(javaTrim(grid));
  }
  const payload = packCompoundFrame(callsign, type, extra, 0);
  return payload && { payload, consumed: m[0].length };
}

/** 導向訊息：KN4CRD SNR -10／KN4CRD?／KN4CRD MSG …；不吻合回 null */
function packDirectedMessage(text, mycall) {
  const m = DIRECTED_RE.exec(text);
  if (!m) return null;
  const from = isCompoundCallsign(mycall) ? '<....>' : mycall;
  let to = m.groups.callsign;
  const { cmd, num } = m.groups;
  if (cmd === undefined || cmd === '') return null;
  if (to === mycall) return null;
  const v = validCallsign(to);
  if (!v.valid) return null;
  const dirTo = to;
  if (v.compound) to = '<....>';
  const cmdValue = CMDS.get(cmd) ?? CMDS.get(javaTrim(cmd));
  if (cmdValue === undefined) return null;
  const inum = packNum(num);
  const pf = packCallsign(from);
  const pt = packCallsign(to);
  if (pf.value === 0 || pt.value === 0) return null;
  const extra = ((pf.portable ? 1 : 0) << 7) | ((pt.portable ? 1 : 0) << 6) | inum;
  const payload = payloadFromBits(bitsOf(FRAME_DIRECTED, 3) + bitsOf(pf.value % 2 ** 28, 28)
    + bitsOf(pt.value % 2 ** 28, 28) + bitsOf(((cmdValue % 32) + 32) % 32, 5) + bitsOf(extra & 0xff, 8));
  return { payload, consumed: m[0].length, dirTo, dirCmd: cmd, dirNum: num ?? '', toCompound: v.compound, cmdValue };
}

/** 位元流補 padding（一個 0 之後補 1）成 72-bit frame */
function finishDataFrame(bits, consumed) {
  if (consumed === 0) return null;
  return { payload: payloadFromBits(bits.padEnd(bits.length + 1, '0').padEnd(72, '1')), consumed };
}

/** huffman 資料 frame：[1][0][huffman 位元流]，遇表外字元即停 */
function packHuffMessage(input) {
  let bits = '10';
  let consumed = 0;
  for (let i = 0; i < input.length; i++) {
    const code = HUFF.get(input[i]);
    if (code === undefined || bits.length + code.length >= 72) break;
    bits += code;
    consumed++;
  }
  return finishDataFrame(bits, consumed);
}

/** JSC 位元流塞滿一個 frame（prefix 為 '11' 或快速 frame 的空字串） */
function packJscBits(input, prefix) {
  let bits = prefix;
  let consumed = 0;
  for (const piece of compress(input)) {
    if (bits.length + piece.bits.length >= 72) break;
    bits += piece.bits;
    consumed += piece.chars;
  }
  // JSC 片段可能超吞（最後一片涵蓋到下一個空白），夾在輸入長度內
  return finishDataFrame(bits, Math.min(consumed, input.length));
}

/** Normal 資料 frame：huffman 與 JSC 取涵蓋字元多者（平手選 JSC） */
function packDataMessage(input) {
  const huff = packHuffMessage(input);
  const jsc = packJscBits(input, '11');
  if (jsc === null) return huff;
  if (huff === null) return jsc;
  return huff.consumed > jsc.consumed ? huff : jsc;
}

// ===== UTX =====

/**
 * 剩餘文字是否需用 UTX：大寫影子超出 Latin-1、非 ASCII 小寫的升寫（會遺失原字）、
 * 或大小寫字母混雜（使用者在乎大小寫）。
 */
function needsUtx(raw, shadow) {
  let hasUpper = false;
  let hasLower = false;
  for (let i = 0; i < shadow.length; i++) {
    const sc = shadow.charCodeAt(i);
    if (sc > 0xff) return true;
    const rc = raw.charCodeAt(i);
    if (rc !== sc) {
      if (!(rc >= 0x61 && rc <= 0x7a)) return true;
      hasLower = true;
    } else if (rc >= 0x41 && rc <= 0x5a) hasUpper = true;
  }
  return hasUpper && hasLower;
}

/** UTX 位元流切成 data frame：Normal [1][0]+69 bits，Fast/Turbo 71 bits；顯示文字依 frame 數均分 */
function packUtxFrames(bits, fast, displayAll) {
  const cap = fast ? 71 : 69;
  const n = Math.ceil(bits.length / cap);
  const disp = Array.from(displayAll);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = finishDataFrame((fast ? '' : '10') + bits.slice(i * cap, (i + 1) * cap), 1);
    const from = Math.floor((disp.length * i) / n);
    const to = Math.floor((disp.length * (i + 1)) / n);
    out.push({ payload: p.payload, itype: fast ? TYPE_DATA : 0, text: disp.slice(from, to).join('') });
  }
  return out;
}

const squeezeSpaces = (s) => s.replace(/ {2,}/g, ' ');

function skipSpaces(s, idx) {
  while (idx < s.length && JAVA_WS.has(s.charCodeAt(idx))) idx++;
  return idx;
}

// ===== 對外主入口 =====

/**
 * 把一段文字拆成一串 JS8 frame（同 FT8TW Js8Varicode.buildMessageFrames(mycall, mygrid, text, submode, forceUtx)）。
 * 呼叫前須載入 JSC 詞表（forceUtx 時還要 UTX 字表），例如 await loadJs8Tables(fetch)；未載入直接丟 Error，
 * 不像 Java 默默退化成只用 huffman（那樣產生的 frame 與 App 不同）。
 *
 * @param {string} text 要發送的文字（結構解析用逐字大寫；UTX 保留原文）
 * @param {object} opts
 * @param {string} opts.mycall 我的呼號（開頭的「MYCALL:」或「MYCALL 」會自動去除）
 * @param {string} [opts.mygrid] 4 碼網格（自己是複合呼號、送導向訊息時的 compound frame 用）
 * @param {number} [opts.submode=0] JS8Call SubmodeType（0 Normal、1 Fast、2 Turbo、4 Slow…）；非 0 時資料段用快速 frame
 * @param {boolean} [opts.forceUtx=false] 「強化編碼」：資料段含大小寫混雜／中文等時改用 UTX（只有 FT8TW 解得開）
 * @returns {{ frames: { payload: Uint8Array, itype: number, text: string }[], error: string|null, utx: boolean }}
 *   utx：真的產生了 UTX frame（導向呼號／指令拆掉後剩下的資料段才算；通訊畫面標「只有 FT8TW 解得開」用）。
 *   error 非 null 時 frames 為空（"mycall is empty"、"message is empty"、"nothing packable in message"）
 */
export function buildJs8Frames(text, { mycall, mygrid = '', submode = 0, forceUtx = false } = {}) {
  if (!isJscLoaded()) throw new Error(t('js8.jscNotLoaded'));
  if (forceUtx && !isUtxLoaded()) throw new Error(t('js8.utxNotLoaded'));
  const fail = (error) => ({ frames: [], error, utx: false });
  if (mycall == null || javaTrim(mycall) === '') return fail('mycall is empty');
  const me = upperShadow(javaTrim(mycall));
  // raw 保留原文、line 是逐字大寫影子（長度一致、索引對齊）
  let raw = javaTrim(text ?? '');
  let line = upperShadow(raw);
  if (line === '') return fail('message is empty');
  const meCompound = isCompoundCallsign(me);
  const cut = (n) => {
    line = line.slice(n);
    raw = raw.slice(n);
  };

  if (line.startsWith(me + ':') || line.startsWith(me + ' ')) cut(skipSpaces(line, me.length + 1));

  let hasDirected = false;
  let hasData = false;
  let utx = false;
  const frames = [];
  const add = (payload, itype, shown) => frames.push({ payload, itype, text: shown });

  while (line !== '') {
    const phraseOk = !hasDirected && !hasData;
    const bcn = phraseOk ? packHeartbeatMessage(line, me) : null;
    const cmp = phraseOk && !bcn ? packCompoundMessage(line) : null;
    const dir = phraseOk && !bcn && !cmp ? packDirectedMessage(line, me) : null;

    if (bcn || cmp) {
      const p = bcn ?? cmp;
      add(p.payload, 0, line.slice(0, p.consumed));
      cut(p.consumed);
    } else if (dir) {
      if (meCompound || dir.toCompound) {
        // 複合呼號流程：先送自己的 compound frame，再送目標的 compound directed frame
        const de = packCompoundMessage('`' + me + ' ' + (mygrid == null ? '' : mygrid.toUpperCase()));
        if (de) add(de.payload, 0, me);
        const dc = packCompoundMessage('`' + dir.dirTo + dir.dirCmd + dir.dirNum);
        if (dc) add(dc.payload, 0, dir.dirTo + dir.dirCmd);
      } else {
        add(dir.payload, 0, line.slice(0, dir.consumed));
      }
      hasDirected = true;
      cut(skipSpaces(line, dir.consumed));
      // 緩衝指令（MSG／MSG TO:／>／QUERY…）的後續文字附 checksum16（UTX 時對原文計算）
      if (isChecksummedCmd(dir.cmdValue) && line !== '') {
        if (dir.cmdValue === 5) {
          // 轉發：'>' 不在 huffman 表，換成空白（上游接收端會改寫回 '>'），連續空白壓成一個
          line = squeezeSpaces(line.replaceAll('>', ' '));
          raw = squeezeSpaces(raw.replaceAll('>', ' '));
        }
        const sum = checksum16(forceUtx && needsUtx(raw, line) ? raw : line);
        line += ' ' + sum;
        raw += ' ' + sum;
      }
    } else if (forceUtx && needsUtx(raw, line)) {
      // 資料段含 legacy 字元集外的字元 → 整段剩餘文字用 UTX（保留原文大小寫）
      frames.push(...packUtxFrames(utxEncode(raw), submode !== 0, raw));
      utx = true;
      hasData = true;
      line = '';
      raw = '';
    } else {
      const fast = submode !== 0;
      const dat = fast ? packJscBits(line, '') : packDataMessage(line);
      if (dat) {
        add(dat.payload, fast ? TYPE_DATA : 0, line.slice(0, dat.consumed));
        hasData = true;
        cut(dat.consumed);
      } else {
        cut(1); // 開頭字元無法打包，丟掉一個字元保證前進
      }
    }
  }

  if (frames.length === 0) return fail('nothing packable in message');
  frames[0].itype |= TYPE_FIRST;
  frames[frames.length - 1].itype |= TYPE_LAST;
  return { frames, error: null, utx };
}
