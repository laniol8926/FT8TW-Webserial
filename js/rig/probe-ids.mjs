// 電台自動探測的對照表（add-rig-autosetup A5～A8）：ID 回應 → 候選機型（名稱必須在 models.mjs）。
// 每筆標來源：hamlib＝Hamlib 原始碼（2026-10-09 master）、device＝實機紀錄、app＝FT8TW App。不憑記憶填。
// 同一筆的候選第一個是建議值；同一指令集的機型行為相同，選哪一個都一樣。
import { MODELS } from './models.mjs';

// Kenwood 系 `ID;` → `IDnnn;`（rigs/kenwood/kenwood.c kenwood_id_string_list）
export const KENWOOD_IDS = Object.freeze({
  '004': { models: ['KENWOOD TS-440'], source: 'hamlib kenwood.c' },
  // 017：TS-570D 與 Elecraft K2／K3／KX3 都回 017（kenwood.c 註解）→ 以 K3;／OM; 區分（probe.mjs）
  '017': { models: ['KENWOOD TS-570'], elecraftCheck: true, source: 'hamlib kenwood.c' },
  '018': { models: ['KENWOOD TS-570'], source: 'hamlib kenwood.c' },
  '019': { models: ['KENWOOD TS-2000'], source: 'hamlib kenwood.c' },
  // 020：TS-480，以及模擬 TS-480 的機型（QRP Labs、truSDX 等）→ 以 USB ID 與 SW; 區分（probe.mjs）
  '020': {
    models: ['KENWOOD TS-480', 'QRPLabs QDX', 'BG2FX FX-4CR', 'QuantumSDR', '(tr)uSDX (TS-480)', '(tr)uSDX (audio over cat)'],
    qrpCheck: true,
    source: 'hamlib kenwood.c；device 2026-10-09 QMX（韌體 1_04_009）實測 ID020、SW; 回空的 SW;；其他模擬 TS-480 的機型待實機確認',
  },
  '021': { models: ['KENWOOD TS-590'], source: 'hamlib kenwood.c TS-590S' },
  '023': { models: ['KENWOOD TS-590'], source: 'hamlib kenwood.c TS-590SG' },
});

export const ELECRAFT_MODELS = Object.freeze(['Elecraft K3', 'Elecraft K3S', 'Elecraft KX2', 'Elecraft KX3']);
export const QMX_MODELS = Object.freeze(['QRPLabs QMX', 'QRPLabs QMX+']);

// Yaesu 新式 `ID;` → `IDnnnn;`（rigs/yaesu/newcat.c nc_rigid_t）
const DX_OTHER = { models: ['YAESU FT-DX Other series'], source: 'hamlib newcat.c' };
export const YAESU_IDS = Object.freeze({
  '0241': { models: ['YAESU FT-450(D)'], source: 'hamlib newcat.c FT450' },
  '0244': { models: ['YAESU FT-450(D)'], source: 'hamlib newcat.c FT450D' },
  '0310': { models: ['YAESU FT-950'], source: 'hamlib newcat.c' },
  '0251': { models: ['YAESU FT-2000(D)'], source: 'hamlib newcat.c FT2000' },
  '0252': { models: ['YAESU FT-2000(D)'], source: 'hamlib newcat.c FT2000D' },
  '0135': { models: ['YAESU FT-891(DATA-USB)', 'YAESU FT-891(USB)'], source: 'hamlib newcat.c' },
  '0570': { models: ['YAESU FT-991(DATA-USB)', 'YAESU FT-991(USB)'], source: 'hamlib newcat.c FT991' },
  '0670': { models: ['YAESU FT-991(DATA-USB)', 'YAESU FT-991(USB)'], source: 'hamlib newcat.c FT991A' },
  '0761': { models: ['YAESU FT-DX10'], source: 'hamlib newcat.c' },
  '0681': { models: ['YAESU FT-DX101'], source: 'hamlib newcat.c FTDX101D' },
  '0682': { models: ['YAESU FT-DX101'], source: 'hamlib newcat.c FTDX101MP' },
  '0800': { models: ['YAESU FT-710'], source: 'hamlib newcat.c' },
  '0840': { models: ['YAESU FTX1'], source: 'hamlib newcat.c' },
  '0583': DX_OTHER, // FTDX1200
  '0362': DX_OTHER, // FTDX5000
  '0462': DX_OTHER, // FTDX3000
  '0101': DX_OTHER, // FTDX9000D
  '0102': DX_OTHER, // FTDX9000 Contest
  '0103': DX_OTHER, // FTDX9000MP
});

// 舊款 Yaesu 5-byte：不探測（Q1），精靈列出讓使用者選
export const YAESU5_MODELS = Object.freeze(MODELS.filter((m) => m.set === 1 || m.set === 21).map((m) => m.name));

// CI-V 位址 → 候選：機型表中 ICOM／協谷指令集（0、22、9、13）且位址相同的
const CIV_SETS = new Set([0, 22, 9, 13]);
export function civModels(addr) {
  return MODELS.filter((m) => CIV_SETS.has(m.set) && m.civ === addr).map((m) => m.name);
}

// ASCII 系全部機型（回 `?;` 的電台：知道是 ASCII，但 ID 不支援）
const ASCII_SETS = new Set([2, 3, 4, 5, 6, 7, 10, 14, 15, 16, 17, 18, 19, 23, 24, 25, 26, 27]);
export const ASCII_MODELS = Object.freeze(MODELS.filter((m) => ASCII_SETS.has(m.set)).map((m) => m.name));

export const QRP_LABS_USB = Object.freeze({ usbVendorId: 0x0483, usbProductId: 0xa34c }); // device：QMX COM5（2026-10-09 serialport.list）

// requestPort 的過濾（A8）：常見電台 USB 序列晶片；一定另有「顯示全部埠」
export const SERIAL_FILTERS = Object.freeze([
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x（ICOM、Yaesu 內建 USB）
  { usbVendorId: 0x0403 }, // FTDI
  { usbVendorId: 0x1a86 }, // WCH CH340／CH343
  { usbVendorId: 0x067b }, // Prolific PL2303
  { usbVendorId: 0x0483 }, // STMicroelectronics（QRP Labs QDX／QMX，device）
  { usbVendorId: 0x0c26 }, // ICOM（未查證；過濾錯了只是看不到，精靈另有「顯示全部埠」）
].map((f) => Object.freeze(f)));
