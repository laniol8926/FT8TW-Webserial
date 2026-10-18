// 電台自動探測（add-rig-autosetup A1～A10）：逐一鮑率開埠，送唯讀查詢（ASCII `ID;`、CI-V 廣播 `19 00`），由回應推出候選機型。
// 只送 PROBE_MESSAGES 裡的位元組（A1）：鮑率相同時，舊款 Yaesu 5-byte（沒有封包邊界）任何對齊相位都湊不出危險 opcode。
// **鮑率不同時不成立**：電台收到的是亂碼，可能湊出任何 opcode（review #1）。所以精靈只在使用者明確回答「不是舊款 Yaesu」時才掃描。
// 開埠由 SerialLink 負責（開埠後立即拉低 DTR／RTS，D6）；計時器、序列埠可注入（單元測試、tools/rig-device-check.mjs --probe）。
import { rigError } from './errors.mjs';
import { MODELS, findModel } from './models.mjs';
import { getSet } from './sets.mjs';
import { withModel } from './prefs.mjs';
import { AsciiFramer, ascii } from './protocols/ascii.mjs';
import { CivFramer, CTRL } from './protocols/civ.mjs';
import { portInfo, sameInfo } from './serial.mjs';
import {
  ASCII_MODELS, ELECRAFT_MODELS, KENWOOD_IDS, QMX_MODELS, QRP_LABS_USB, YAESU_IDS, civModels,
} from './probe-ids.mjs';

// 機型表預設鮑率出現多的優先；USB CDC（QMX、IC-705 等）不管鮑率第一輪就回（A3）
export const PROBE_BAUDS = Object.freeze([115200, 38400, 19200, 9600, 4800, 57600, 2400, 1200]);
// 2 個停止位元：只要 1 個的電台照收（多一段閒置）；要 2 個的（Yaesu 新式，Hamlib serial_stop_bits=2）也收得對
export const PROBE_STOP_BITS = 2;
export const REPLY_MS = 300;

const CIV_READ_ID = Uint8Array.from([0xfe, 0xfe, 0x00, CTRL, 0x19, 0x00, 0xfd]);
// 探測只會送這些（A1）。T、X、M、1 不會相鄰出現：Kenwood 系湊不出 TX、Yaesu 湊不出 MX1
const PROBE_MESSAGES = [';', 'ID;', 'SW;', 'K3;'].map((s) => ascii(s)).concat([CIV_READ_ID]);
const SAFE_BYTES = new Set(PROBE_MESSAGES.flatMap((m) => [...m]));
// FT-817 系 5-byte 的危險 opcode：設頻、split、clar、模式、PTT、中繼、亞音、開關機、EEPROM（含 FT-847 的對應指令）
export const Y5_DANGER = new Set([0x01, 0x02, 0x82, 0x05, 0x85, 0xf5, 0x07, 0x08, 0x09, 0xf9, 0x0a, 0x0b, 0x0c, 0x0f, 0x8f, 0xbb, 0xbc, 0xbe]);

export function isProbeByteSafe(b) {
  return SAFE_BYTES.has(b) && !Y5_DANGER.has(b);
}

// 寫出前的最後一道檢查：只放行 PROBE_MESSAGES 中的整筆訊息
export function assertProbeSafe(bytes) {
  const b = Uint8Array.from(bytes);
  const ok = PROBE_MESSAGES.some((m) => m.length === b.length && m.every((x, i) => x === b[i]));
  if (!ok) throw rigError('probeUnsafe', 'probe refused to send a non-whitelisted message');
}

const abortError = () => new DOMException('probe aborted', 'AbortError');

// 收到的位元組同時交給兩種分框器
function collector(link) {
  const st = { ascii: [], civ: [] };
  const af = new AsciiFramer();
  const cf = new CivFramer();
  const off = link.onData((bytes) => {
    st.ascii.push(...af.push(bytes));
    st.civ.push(...cf.push(bytes));
  });
  return { st, off };
}

// ASCII 回應：IDnnn（Kenwood 3 位）／IDnnnn（Yaesu 4 位）／?（是 ASCII 但不支援）
export function asciiIdOf(texts) {
  for (const t of texts) {
    const m = /^ID(\d{3,4})$/.exec(t);
    if (m) return { id: m[1] };
  }
  return texts.includes('?') ? { id: null } : null;
}

// CI-V 回應：E0 ← 電台 19 00 → 位址；退而求其次：transceive 的頻率框（目的 00、指令 00／03）的來源位址
export function civAddrOf(frames) {
  let fallback = null;
  for (const f of frames) {
    if (f.length < 6 || f[0] !== 0xfe || f[1] !== 0xfe || f.at(-1) !== 0xfd) continue;
    const [dst, src, cmd, sub] = [f[2], f[3], f[4], f[5]];
    if (src === CTRL || src === 0x00) continue; // 我們送出去的回送
    if (dst === CTRL && cmd === 0x19 && sub === 0x00) return src;
    if ((dst === 0x00 || dst === CTRL) && (cmd === 0x00 || cmd === 0x03) && fallback === null) fallback = src;
  }
  return fallback;
}

const civAll = () => MODELS.filter((m) => [0, 22, 9, 13].includes(m.set)).map((m) => m.name);

// probeRig：{ found:false, log } 或
// { found:true, baud, protocol:'ascii'|'civ', vendor, id, civ, candidates[], suggested, log }
export async function probeRig({ link, port, bauds = PROBE_BAUDS, replyMs = REPLY_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), signal, onProgress = () => {} }) {
  const log = [];
  const qrpUsb = sameInfo(portInfo(port), QRP_LABS_USB);
  const check = () => { if (signal?.aborted) throw abortError(); };
  let lostErr = null;
  const offClose = link.onClose(({ error }) => {
    lostErr = error?.code ? error : rigError('deviceLost', error?.message ?? 'device disconnected', error ?? undefined);
  });
  const send = async (bytes) => {
    check();
    if (lostErr) throw lostErr;
    assertProbeSafe(bytes);
    try {
      await link.write(bytes);
    } catch (err) {
      throw lostErr ?? err; // 拔線時寫入中的那筆以原始錯誤失敗：改丟帶 code 的
    }
  };
  const wait = async () => {
    await sleep(replyMs);
    check();
    if (lostErr) throw lostErr;
  };
  try {
    for (const baud of bauds) {
      check();
      onProgress({ baud });
      await link.open(port, { baudRate: baud, dataBits: 8, stopBits: PROBE_STOP_BITS, parity: 'none' });
      const { st, off } = collector(link);
      try {
        // ASCII：先送 ; 清掉 Kenwood 系緩衝裡的殘留
        await send(ascii(';'));
        await send(ascii('ID;'));
        await wait();
        const a = asciiIdOf(st.ascii);
        if (a) {
          const r = await asciiResult(a.id, { send, wait, st, qrpUsb });
          log.push({ baud, ascii: [...st.ascii] });
          return { found: true, baud, protocol: 'ascii', civ: null, ...r, log };
        }
        await send(CIV_READ_ID);
        await wait();
        await send(ascii(';')); // CI-V 的位元組留在 Kenwood 系緩衝裡：補 ; 結束
        const addr = civAddrOf(st.civ);
        log.push({ baud, ascii: [...st.ascii], civ: st.civ.length });
        if (addr !== null) {
          const list = civModels(addr);
          return {
            found: true, baud, protocol: 'civ', vendor: 'icom', id: null, civ: addr,
            candidates: list.length ? list : civAll(), suggested: list[0] ?? null, log,
          };
        }
      } finally {
        off();
        await link.close();
      }
    }
    return { found: false, log };
  } finally {
    offClose();
    if (link.isOpen) await link.close();
  }
}

async function asciiResult(id, { send, wait, st, qrpUsb }) {
  if (id === null) return { vendor: null, id: null, candidates: [...ASCII_MODELS], suggested: null };
  if (id.length === 4) {
    const y = YAESU_IDS[id];
    return { vendor: 'yaesu', id, candidates: y ? [...y.models] : ASCII_MODELS.filter((n) => n.startsWith('YAESU')), suggested: y?.models[0] ?? null };
  }
  const k = KENWOOD_IDS[id];
  if (!k) return { vendor: 'kenwood', id, candidates: [...ASCII_MODELS], suggested: null };
  const reply = async (cmd, key) => {
    st.ascii.length = 0;
    await send(ascii(cmd));
    await wait();
    return st.ascii.some((t) => t.toUpperCase().startsWith(key)); // K31 的第二個字是數字，parseCommand 不收
  };
  if (k.qrpCheck) {
    // QMX 收訊時 SW; 回空的 SW;（Hamlib ts480.c qrplabs_qmx_get_level）；其他 TS-480 相容機回 ?;
    if (await reply('SW;', 'SW')) return { vendor: 'qrplabs', id, candidates: [...QMX_MODELS], suggested: QMX_MODELS[0] };
    // QRP Labs USB：QDX 排第一，舊韌體的 QMX 可能不回 SW;，也列進候選（review E）
    const list = qrpUsb ? ['QRPLabs QDX', ...QMX_MODELS, ...k.models.filter((n) => n !== 'QRPLabs QDX')] : [...k.models];
    return { vendor: qrpUsb ? 'qrplabs' : 'kenwood', id, candidates: list, suggested: list[0] };
  }
  if (k.elecraftCheck && (await reply('K3;', 'K3'))) {
    return { vendor: 'elecraft', id, candidates: [...ELECRAFT_MODELS], suggested: ELECRAFT_MODELS[0] };
  }
  return { vendor: 'kenwood', id, candidates: [...k.models], suggested: k.models[0] };
}

// 套用探測結果（A5、A9）：機型預設值＋探測到的鮑率、CI-V 位址；停止位元依選定機型的指令集（Yaesu 系 2，review #3）。不認得的機型回 null
export function probeResultPrefs(prefs, result, modelName) {
  const m = findModel(modelName);
  if (!m) return null;
  const p = withModel(prefs, modelName);
  return {
    ...p,
    controlMode: p.controlMode === 'vox' ? 'cat' : p.controlMode,
    baud: result.baud ?? p.baud,
    civ: result.protocol === 'civ' && Number.isInteger(result.civ) ? result.civ : p.civ,
    stopBits: getSet(m.set)?.stopBits ?? 1,
  };
}
