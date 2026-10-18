// 電台控制設定的保存（add-web-rig-control D15）：localStorage `ft8tw.rig`。不合法的值退回預設（機型的預設鮑率、CI-V 位址）。
import { findModel } from './models.mjs';
import { CONTROL_MODES } from './rig.mjs';
import { DATA_BITS, PARITIES, STOP_BITS } from './serial.mjs';

export const RIG_KEY = 'ft8tw.rig';
export const BAUD_RATES = Object.freeze([1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]);
export const PTT_DELAY_MAX_MS = 1000;
export const RIG_DEFAULTS = Object.freeze({ controlMode: 'vox', model: '', baud: null, dataBits: 8, stopBits: 1, parity: 'none', civ: null, pttDelayMs: 100, port: null });

const intIn = (v, ok) => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && ok(n) ? n : undefined;
};

function readPort(v) {
  if (!v || typeof v !== 'object') return null;
  const vid = intIn(v.usbVendorId, (n) => n >= 0 && n <= 0xffff);
  const pid = intIn(v.usbProductId, (n) => n >= 0 && n <= 0xffff);
  if (vid !== undefined) return { usbVendorId: vid, usbProductId: pid };
  if (typeof v.bluetoothServiceClassId === 'string' && v.bluetoothServiceClassId.length <= 64) return { bluetoothServiceClassId: v.bluetoothServiceClassId };
  return null;
}

// raw：任何值。回傳正規化後的設定；baud／civ 沒設定或不合法時取機型預設值（沒有機型時 null）
export function normalizeRigPrefs(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const model = typeof r.model === 'string' ? findModel(r.model) : null;
  return {
    controlMode: CONTROL_MODES.includes(r.controlMode) ? r.controlMode : RIG_DEFAULTS.controlMode,
    model: model?.name ?? '',
    baud: intIn(r.baud, (n) => BAUD_RATES.includes(n)) ?? model?.baud ?? null,
    dataBits: intIn(r.dataBits, (n) => DATA_BITS.includes(n)) ?? RIG_DEFAULTS.dataBits,
    stopBits: intIn(r.stopBits, (n) => STOP_BITS.includes(n)) ?? RIG_DEFAULTS.stopBits,
    parity: PARITIES.includes(r.parity) ? r.parity : RIG_DEFAULTS.parity,
    civ: intIn(r.civ, (n) => n >= 0 && n <= 0xff) ?? model?.civ ?? null,
    pttDelayMs: intIn(r.pttDelayMs, (n) => n >= 0 && n <= PTT_DELAY_MAX_MS) ?? RIG_DEFAULTS.pttDelayMs,
    port: readPort(r.port),
  };
}

export function loadRigPrefs(storage) {
  let raw = null;
  try {
    raw = JSON.parse(storage.getItem(RIG_KEY) ?? 'null');
  } catch {
    raw = null;
  }
  return normalizeRigPrefs(raw);
}

export function saveRigPrefs(storage, prefs) {
  try {
    storage.setItem(RIG_KEY, JSON.stringify(normalizeRigPrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}

// 換機型：鮑率與 CI-V 位址帶入機型預設值
export function withModel(prefs, name) {
  const m = findModel(name);
  return normalizeRigPrefs({ ...prefs, model: m?.name ?? '', baud: m?.baud ?? null, civ: m?.civ ?? null });
}

// 頻率顯示：21 074 000 → "21.074 MHz"（後三位是 000 就省略，使用者 2026-10-09）；7 047 500 → "7.047 500 MHz"
export function formatRigHz(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '';
  return `${(hz / 1e6).toFixed(6).replace(/(\.\d{3})(\d{3})$/, (m, a, b) => (b === '000' ? a : `${a} ${b}`))} MHz`;
}

// 機型選單的分組標題（App 的 #Break 分組沒有名稱）：組內機型名稱第一個字（廠牌）去重
export function groupLabel(group) {
  return [...new Set(group.map((m) => m.name.split(/\s+/)[0]))].join(' / ');
}

// CI-V 位址輸入（16 進位 1～2 位）；不合法回 null
export function parseCiv(text) {
  const v = String(text ?? '').trim();
  return /^[0-9a-f]{1,2}$/i.test(v) ? parseInt(v, 16) : null;
}

export const formatCiv = (n) => (Number.isInteger(n) ? n.toString(16).toUpperCase().padStart(2, '0') : '');

// 連線需要的參數；設定不完整回 null
export function connectParams(prefs) {
  const m = findModel(prefs.model);
  if (!m || prefs.controlMode === 'vox' || !prefs.baud) return null;
  return {
    serial: { baudRate: prefs.baud, dataBits: prefs.dataBits, stopBits: prefs.stopBits, parity: prefs.parity },
    setId: m.set,
    model: m.name,
    civ: prefs.civ ?? m.civ,
    controlMode: prefs.controlMode,
    pttDelayMs: prefs.pttDelayMs,
  };
}
