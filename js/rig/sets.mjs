// 指令集設定（add-web-rig-control D4）：每個 App 指令集（rigs/InstructionSet.java）一筆，說明怎麼設頻、設模式、讀頻、PTT、讀錶、
// SWR 換算、連線後的初始化與特別處理。指令以「步驟」表示：{ bytes, gapMs?（送完後等多久）, expect?（Yaesu 5-byte 期待的回應）}。
// 位元組的來源（Java 檔名）寫在每一筆；黃金值測試在 webtest/rig-sets.test.mjs。網路電台（11、12、20）不在這裡。
import { AsciiFramer, METER_PARSERS, ascii, freqCommand, frequencyOf, parseCommand, smeterOf } from './protocols/ascii.mjs';
import { CivFramer, civ, civEvent } from './protocols/civ.mjs';
import { Yaesu5Framer, yaesu5, yaesu5Event } from './protocols/yaesu5.mjs';
import { GuoheFramer, guohe, guoheEvent } from './protocols/guohe.mjs';

export const INIT_DELAY_MS = 1500; // App：START_QUERY_FREQ_DELAY-500
export const POLL_START_MS = 2000; // START_QUERY_FREQ_DELAY
export const POLL_MS = 2000; // QUERY_FREQ_TIMEOUT
export const BAND_DELAY_MS = 1000; // MainViewModel.connectCableRig 1000 ms 後 setOperationBand
export const MODE_TO_FREQ_MS = 800; // setOperationBand：先模式，800 ms 後頻率

const step = (bytes, extra = {}) => ({ bytes: typeof bytes === 'string' ? ascii(bytes) : bytes, ...extra });
const steps = (...list) => list.map((x) => (x.bytes ? x : step(x)));

// ── SWR 換算表（rigs/common/SWRConverter.java 的線性內插；超出最後一點回最後一點，FT-817 例外回 15）──
const TABLES = {
  icom: [[0, 1.0], [48, 1.5], [80, 2.0], [120, 3.0], [255, 5.0]], // IcomRig.java ICOM_SWR_TABLE
  ts590: [[0, 1.0], [6, 1.5], [12, 2.0], [18, 3.0], [30, 10.0]], // KenwoodTS590Rig.java
  yaesu255: [[0, 1.0], [30, 1.3], [60, 1.5], [100, 2.0], [160, 2.5], [200, 3.0], [230, 4.0], [255, 5.0]], // Yaesu39Rig／YaesuDX10Rig／KenwoodTS2000Rig
  ft817: [[0, 1.0], [1, 1.4], [2, 1.8], [3, 2.13], [4, 2.25], [5, 3.7], [6, 6.0], [7, 7.0], [8, 8.0], [9, 9.0], [10, 10.0], [11, 10.5], [12, 10.0], [13, 10.0], [14, 10.0], [15, 10.0]], // Yaesu2Rig.java
  // App 只有原始警告門檻的機型（D10）：合成「門檻＝3.0」的兩點表，讓 SWR ≥3.0 自動停發一致
  yaesu125: [[0, 1.0], [125, 3.0]], // Yaesu3RigConstant.swr_39_alert_max＝125（相當於 3.0）
  xiegu120: [[0, 1.0], [120, 3.0]], // IcomRigConstant.swr_alert_max＝120（協谷用）
  ft847: [[0, 1.0], [7, 3.0]], // Yaesu2_847Rig：raw > swr_817_alert_min(6) 警告
};

// 換算表內插（Hamlib src/cal.c rig_raw2val）：低於第一點回第一點、高於最後一點回最後一點、中間線性內插。表為 [原始值, 換算值]
export function interp(table, raw) {
  if (!table?.length || !Number.isFinite(raw)) return null;
  if (raw <= table[0][0]) return table[0][1];
  if (raw >= table.at(-1)[0]) return table.at(-1)[1];
  let i = 1;
  while (raw >= table[i][0]) i++;
  const [r0, v0] = table[i - 1];
  const [r1, v1] = table[i];
  return v0 + ((v1 - v0) * (raw - r0)) / (r1 - r0);
}

export function convertSwr(swr, raw) {
  if (!swr || raw === null || raw === undefined || !Number.isFinite(raw)) return null;
  if (swr.kind === 'direct') return raw;
  if (swr.kind === 'tenths') return raw / 10;
  const table = TABLES[swr.table];
  if (raw >= table.at(-1)[0]) return swr.overflow ?? table.at(-1)[1];
  return interp(table, raw);
}

// ── 解碼器 ──
// ASCII：每個完整指令 → 事件
function asciiDecoder(set) {
  const framer = new AsciiFramer();
  return {
    push(bytes) {
      const events = [];
      for (const text of framer.push(bytes)) {
        const cmd = parseCommand(text);
        if (!cmd) continue;
        const hz = frequencyOf(cmd);
        if (hz) { events.push({ freq: hz }); continue; }
        const sm = smeterOf(cmd);
        if (sm !== null) { events.push({ smRaw: sm }); continue; }
        if (set.alcParser) {
          const a = METER_PARSERS[set.alcParser](cmd);
          if (a !== null) { events.push({ alcRaw: a }); continue; }
        }
        if (set.meterParser) {
          const v = METER_PARSERS[set.meterParser](cmd);
          if (v !== null) { events.push(set.swr?.kind === 'direct' ? { swr: v } : { swrRaw: v }); continue; }
        }
        if (cmd.id === 'RX') events.push({ rx: true });
        if (set.qmx) {
          if (cmd.id === 'VN') events.push({ firmware: cmd.data.trim() });
          else if (cmd.id === 'SR') events.push({ srLocked: cmd.data.trim().startsWith('1') });
          else if (cmd.id === 'LC') events.push({ lcd: cmd.data });
          else if (cmd.id === 'PC' && /^\d+(\.\d+)?$/.test(cmd.data.trim())) events.push({ power: Number(cmd.data.trim()) });
        }
      }
      return events;
    },
    clear: () => framer.clear(),
  };
}

function civDecoder(set, ctx) {
  const framer = new CivFramer();
  return {
    push(bytes) {
      const events = [];
      for (const frame of framer.push(bytes)) {
        const ev = civEvent(frame, ctx.civ, { xiegu: set.xiegu });
        if (!ev) continue;
        if (ev.freq && set.freqRange && (ev.freq < set.freqRange[0] || ev.freq > set.freqRange[1])) continue; // XieGuRig.java:155
        events.push(ev);
      }
      return events;
    },
    clear: () => framer.clear(),
  };
}

function yaesu5Decoder() {
  const framer = new Yaesu5Framer();
  return {
    push: (bytes) => framer.push(bytes).map(yaesu5Event).filter(Boolean),
    expect: (e) => framer.expect(e?.kind ?? null, e?.len ?? 0),
    clear: () => framer.clear(),
  };
}

function guoheDecoder() {
  const framer = new GuoheFramer();
  return { push: (bytes) => framer.push(bytes).map(guoheEvent).filter(Boolean), clear: () => framer.clear() };
}

// ── 指令集工廠 ──
// Kenwood 系（TS-590 指令；KenwoodTK90RigConstant.java）
function kenwood({ id, name, pttOn = 'TX1;', pttOff = 'RX;', mode = 'MD2;', meters = ['RM1;'], meterParser = 'rm590', swr = { kind: 'table', table: 'ts590' },
  init = ['FR0;'], readFreq = ['FA;'], ...extra }) {
  return {
    id, name, protocol: 'ascii',
    mode: () => steps(...[mode].flat()),
    setFreq: (hz) => steps(freqCommand(hz, 11)),
    readFreq: () => steps(...readFreq),
    pttOn: () => steps(pttOn),
    pttOff: () => steps(pttOff),
    meters: meters ? () => steps(...meters) : null,
    meterParser: meters ? meterParser : null,
    swr: meters ? swr : null,
    init: init ? [{ atMs: INIT_DELAY_MS, steps: () => steps(...init) }] : [],
    newDecoder() { return asciiDecoder(this); },
    ...extra,
  };
}

// Yaesu 新式（Yaesu3RigConstant.java）：digits＝設頻位數（8 或 9）
function yaesu({ id, name, mode, digits, ptt = 'MX', meters = true, meterParser = 'rm38', swr = { kind: 'table', table: 'yaesu125' }, ...extra }) {
  const [on, off] = ptt === 'TX' ? ['TX1;', 'TX0;'] : ['MX1;', 'MX0;'];
  return {
    id, name, protocol: 'ascii',
    mode: () => steps(mode),
    setFreq: (hz) => steps(freqCommand(hz, digits)),
    readFreq: () => steps('FA;'),
    pttOn: () => steps(on),
    pttOff: () => steps(off),
    meters: meters ? () => steps('RM4;', 'RM6;') : null,
    meterParser: meters ? meterParser : null,
    alcParser: meters ? (meterParser === 'rm39' ? 'alc39' : 'alc38') : null,
    alc: meters ? { max: 125 } : null, // Yaesu3RigConstant.alc_39_alert_max
    stopBits: 2, // Hamlib newcat 系 serial_stop_bits=2（FT-710 為 1，多一個停止位元照收）
    swr: meters ? swr : null,
    init: [],
    newDecoder() { return asciiDecoder(this); },
    ...extra,
  };
}

// ICOM CI-V（IcomRig.java；協谷 XieGuRig.java／XieGu6100Rig.java）
function icom({ id, name, dataMode = true, meters = true, xiegu = false, ...extra }) {
  return {
    id, name, protocol: 'civ', xiegu,
    mode: ({ civ: a }) => steps(dataMode ? civ.setDataMode(a, 1) : civ.setMode(a, 1)),
    setFreq: (hz, { civ: a }) => steps(civ.setFreq(a, hz)),
    readFreq: ({ civ: a }) => steps(civ.readFreq(a)),
    // ICOM：PTT 開前先把資料來源設成 USB（IcomRig.sendPttCommands：USB_CABLE → 1A 05 01 19 01）；協谷沒有
    pttOn: ({ civ: a }) => (xiegu ? steps(civ.ptt(a, true)) : steps(civ.dataSource(a, 1), civ.ptt(a, true))),
    pttOff: ({ civ: a }) => steps(civ.ptt(a, false)),
    // ICOM：SWR／ALC 每 250 ms 輪替一道（IcomRig.startMeterTimer）；協谷每拍兩道（XieGuRig.readSWRMeter）
    meters: meters ? ({ civ: a }, tick) => (xiegu ? steps(civ.readSwr(a), civ.readAlc(a)) : steps(tick % 2 ? civ.readAlc(a) : civ.readSwr(a))) : null,
    meterIntervalMs: xiegu ? POLL_MS : 250,
    swr: meters ? { kind: 'table', table: xiegu ? 'xiegu120' : 'icom' } : null,
    // ALC 門檻（IcomRigConstant.alc_alert_max＝120；協谷 xiegu_alc_alert_min／max＝36／84）
    alc: meters ? (xiegu ? { min: 36, max: 84 } : { max: 120 }) : null,
    init: [],
    newDecoder(ctx) { return civDecoder(this, ctx); },
    ...extra,
  };
}

const Y5_FREQ = { kind: 'freq', len: 5 };
const Y5_METER = { kind: 'meter', len: 2 };
// 不是查詢的指令，電台可能回 1 byte 確認：留 50 ms 讓它在下一筆查詢設定期待長度之前到達（否則會黏到讀頻回應前面）
export const Y5_ACK_GAP_MS = 50;
const y5 = (bytes) => step(bytes, { gapMs: Y5_ACK_GAP_MS });
function yaesuOld({ id, name, mode, swr, ...extra }) {
  return {
    id, name, protocol: 'yaesu5',
    mode: () => [y5(mode)],
    setFreq: (hz) => [y5(yaesu5.setFreq(hz))],
    readFreq: () => [step(yaesu5.readFreq(), { expect: Y5_FREQ })],
    pttOn: () => [y5(yaesu5.ptt(true))],
    pttOff: () => [y5(yaesu5.ptt(false))],
    meters: () => [step(yaesu5.readMeter(), { expect: Y5_METER })],
    swr,
    init: [],
    newDecoder: () => yaesu5Decoder(),
    stopBits: 2, // Hamlib ft817.c serial_stop_bits=2
    ...extra,
  };
}

const LIST = [
  icom({ id: 0, name: 'ICOM', pttVerify: true }),
  icom({ id: 22, name: 'ICOM IC-746/756', meters: false, pttVerify: true }), // IcomRig(civ, false)：oldVersion 不讀錶
  icom({ id: 9, name: 'XIEGU (USB)', dataMode: false, xiegu: true, freqRange: [500_000, 250_000_000] }),
  icom({ id: 13, name: 'XIEGU (U-DIG)', dataMode: true, xiegu: true, freqRange: [500_000, 250_000_000] }),
  yaesuOld({ id: 1, name: 'YAESU FT-817', mode: yaesu5.modeDig(), swr: { kind: 'table', table: 'ft817', overflow: 15 }, alc: { max: 7 } }), // Yaesu2RigConstant.alc_817_alert_max
  yaesuOld({ id: 21, name: 'YAESU FT-847', mode: yaesu5.modeUsb(), swr: { kind: 'table', table: 'ft847' }, catOn: () => [y5(yaesu5.catOn())], catOff: () => [y5(yaesu5.catOff())] }),
  yaesu({ id: 2, name: 'YAESU FT-891/991 (USB)', mode: 'MD02;', digits: 9, meterParser: 'rm39', swr: { kind: 'table', table: 'yaesu255' } }),
  yaesu({ id: 19, name: 'YAESU FT-891/991 (DATA-USB)', mode: 'MD0C;', digits: 9, meterParser: 'rm39', swr: { kind: 'table', table: 'yaesu255' } }),
  yaesu({ id: 3, name: 'YAESU FT-950/2000', mode: 'MD02;', digits: 8 }),
  yaesu({ id: 4, name: 'YAESU FT-450', mode: 'MD0C;', digits: 8, ptt: 'TX' }),
  yaesu({ id: 15, name: 'Wolf SDR (DIG-U)', mode: 'MD0C;', digits: 8, ptt: 'TX' }), // Wolf_sdr_450Rig(false)
  yaesu({ id: 16, name: 'Wolf SDR (USB)', mode: 'MD02;', digits: 8, ptt: 'TX' }), // Wolf_sdr_450Rig(true)
  // FT-DX10／DX101／FT-710：發射中不讀錶（YaesuDX10Rig 沒有設 catPolicy）
  yaesu({ id: 6, name: 'YAESU FT-DX10', mode: 'MD0C;', digits: 9, meters: false }),
  yaesu({ id: 26, name: 'YAESU FT-710', mode: 'MD0C;', digits: 9, meters: false }),
  // FTX1：設頻 VS0;→FT0;→MD0C;→FA，各隔 40 ms；讀頻 FA;→20 ms→IF;；發射中可讀錶（Ftx1CatPolicy）
  yaesu({ id: 25, name: 'YAESU FTX1', mode: 'MD0C;', digits: 9, swr: { kind: 'table', table: 'yaesu255' },
    setFreq: (hz) => [step('VS0;', { gapMs: 40 }), step('FT0;', { gapMs: 40 }), step('MD0C;', { gapMs: 40 }), step(freqCommand(hz, 9))],
    readFreq: () => [step('FA;', { gapMs: 20 }), step('IF;')] }),
  kenwood({ id: 7, name: 'KENWOOD TS-480/590', pttOffResend: true }),
  kenwood({ id: 14, name: 'KENWOOD TS-2000', pttOn: 'TX0;', swr: { kind: 'table', table: 'yaesu255' } }),
  kenwood({ id: 24, name: 'LAB599 TX-500MP', pttOn: 'TX0;', mode: 'MD6;', swr: { kind: 'table', table: 'yaesu255' } }),
  kenwood({ id: 18, name: 'KENWOOD TS-570', pttOn: 'TX;' }), // App 門檻 1500 永遠到不了，改用 TS-590 表（D10）
  kenwood({ id: 27, name: 'KENWOOD TS-440', pttOn: 'TX;' }),
  // TK-90：全部以 \r 結尾、不讀錶（KenwoodKT90Rig.java）
  kenwood({ id: 5, name: 'KENWOOD TK-90', pttOn: 'TX\r', pttOff: 'RX\r', mode: 'MD2\r', meters: null, init: ['FR0\r'], readFreq: ['FA\r'],
    setFreq: (hz) => steps(freqCommand(hz, 11, '\r')) }),
  // QMX：模式字串含 Q41（TX rise threshold 1）、Q90（關 I/Q）；讀 SW;（SWR）與 PC;（功率）；保護輪詢（QrpQmxRig.java）
  kenwood({ id: 23, name: 'QRP Labs QMX', mode: 'MD6;Q41;Q90;', meters: ['SW;', 'PC;'], meterParser: 'qmxSw', swr: { kind: 'direct' }, qmx: true }),
  // truSDX：只做 CAT，不送 UA2;（audio over CAT 不在範圍，D17）；讀頻前置 ;RX;（TrUSDXRig.readFreqFromRig 的 force reset）
  kenwood({ id: 17, name: '(tr)uSDX', pttOn: ';TX0;', pttOff: ';RX;', meters: null, init: ['FR0;', 'MD2;'], readFreq: [';RX;', 'FA;'] }),
  // Elecraft：模式 MD2; MD6; DT0;；SWR; 回 SWRnnn（十分之一）
  kenwood({ id: 10, name: 'Elecraft', pttOn: 'TX;', mode: ['MD2;', 'MD6;', 'DT0;'], meters: ['SWR;'], meterParser: 'elecraftSwr', swr: { kind: 'tenths' }, init: null }),
  // 國赫：PTT 一律走 CAT（GuoHeQ900Rig.setPTT 不看控制方式）；不讀錶
  {
    id: 8, name: 'GUOHE Q900/PMR-171', protocol: 'guohe', pttAlwaysCat: true,
    mode: () => [step(guohe.modeUsb())],
    setFreq: (hz) => [step(guohe.setFreq(hz))],
    readFreq: () => [step(guohe.readFreq())],
    pttOn: () => [step(guohe.ptt(true))],
    pttOff: () => [step(guohe.ptt(false))],
    meters: null, swr: null, init: [],
    newDecoder: () => guoheDecoder(),
  },
];

// ── S 表（add-rig-meters design M4～M12）：照 Hamlib master（2026-10-09）。表為 [原始值, 相對 S9 的 dB]，以 interp（rig_raw2val）換算 ──
const STR_CAL = {
  icomStd: [[0, -54], [120, 0], [241, 60]], // ic7100.c IC7100_STR_CAL／ic7200.c／ic7800.c；xiegu.c X6100_STR_CAL
  ic7300: [[0, -54], [10, -48], [30, -36], [60, -24], [90, -12], [120, 0], [241, 64]], // ic7300.c IC7300_STR_CAL（IC9700_STR_CAL 同值）
  ic7000: [[0, -54], [5, -29], [15, -27], [43, -22], [68, -17], [92, -12], [120, -6], [141, 2], [162, 13], [182, 25], [202, 38], [222, 47], [241, 57], [255, 63]], // ic7000.c IC7000_STR_CAL
  ic706iig: [[45, -60], [46, -54], [54, -48], [64, -42], [76, -36], [84, -30], [94, -24], [104, -18], [113, -12], [123, -6], [133, 0], [144, 10], [156, 20], [170, 30], [181, 40], [192, 50], [204, 60]], // ic706.c IC706IIG_STR_CAL
  ic7410: [[0, -54], [124, 0], [246, 60]], // ic7410.c IC7410_STR_CAL
  ic7600: [[0, -54], [11, -48], [21, -42], [34, -36], [50, -30], [59, -24], [75, -18], [93, -12], [103, -6], [124, 0], [145, 10], [160, 20], [183, 30], [204, 40], [222, 50], [246, 60]], // ic7600.c IC7600_STR_CAL（ic7610.c 同值）
  icomUnknown: [[0, -60], [255, 60]], // icom.h UNKNOWN_IC_STR_CAL（ic718.c、ic9100.c）
  ic746: [[0, -60], [10, -55], [27, -49], [45, -42], [60, -35], [76, -28], [89, -21], [100, -14], [110, -7], [120, 0], [125, 10], [129, 20], [133, 30], [138, 40], [142, 50], [146, 60]], // ic746.c IC746_STR_CAL
  ic756pro: [[0, -60], [14, -52], [29, -44], [44, -36], [60, -28], [75, -20], [91, -12], [107, -4], [124, 4], [141, 12], [158, 20], [175, 28], [192, 36], [210, 44], [228, 52], [247, 60]], // ic756.c IC756PRO_STR_CAL
  x108g: [[0, -54], [5, -29], [15, -27], [43, -22], [68, -17], [92, -12], [120, -6], [141, 2], [162, 13], [182, 25], [202, 38], [222, 47], [241, 57], [255, 63]], // xiegu.c X108G_STR_CAL
  ts590: [[0, -60], [3, -48], [6, -36], [9, -24], [12, -12], [15, 0], [20, 20], [25, 40], [30, 60]], // ts590.c TS590_STR_CAL（ts570.c TS570_STR_CAL 同值）
  ts480: [[0, -60], [3, -48], [5, -36], [7, -24], [9, -12], [11, 0], [14, 20], [17, 40], [20, 60]], // ts480.c TS480_STR_CAL
  ts2000: [[0, -54], [3, -48], [6, -36], [9, -24], [12, -12], [15, 0], [20, 20], [25, 40], [30, 60]], // ts2000.c TS2000_STR_CAL
  k3: [[0, -54], [1, -42], [2, -36], [3, -24], [4, -12], [5, -6], [6, 0], [7, 10], [8, 15], [9, 20], [10, 30], [11, 35], [12, 40], [13, 50], [14, 55], [15, 60]], // elecraft.h K3_SM_CAL
  yaesu16: [[0, -54], [12, -48], [27, -42], [40, -36], [55, -30], [65, -24], [80, -18], [95, -12], [112, -6], [130, 0], [150, 10], [172, 20], [190, 30], [220, 40], [240, 50], [255, 60]], // ft991.h FT991_STR_CAL（ft891.h／ft950.h／ft2000.h／ft710.h／ftx1.h 同值）
  ft450: [[10, -60], [125, 0], [240, 60]], // ft450.h FT450_STR_CAL
  yaesuDefault: [[0, -54], [26, -42], [51, -30], [81, -18], [105, -9], [130, 0], [157, 12], [186, 25], [203, 35], [237, 50], [255, 60]], // newcat.c yaesu_default_str_cal（ftdx10.c 沒有 str_cal）
  ftdx101: [[0, -60], [17, -54], [25, -48], [34, -42], [51, -36], [68, -30], [85, -24], [102, -18], [119, -12], [136, -6], [160, 0], [255, 60]], // ftdx101.h FTDX101D_STR_CAL
};

// 公式（Hamlib 的 get_level 直接算、不查表）
const STR_FORMULA = {
  ft817: (raw) => { const n = raw & 0x0f; return n < 10 ? 6 * n - 54 : 10 * (n - 9); }, // ft817.c ft817_get_smeter_level（ft857.c 同）
  ft847: (raw) => { const n = raw & 0x1f; return n < 4 ? -54 + 2 * n : n < 20 ? -48 + 3 * (n - 3) : 5 * (n - 19); }, // ft847.c ft847_get_smeter_level
  tx500: (raw) => raw * 3.6 - 54, // tx500.c tx500_get_level（TX500_STR_CAL 定義了但沒用）
  kenwoodLinear: (raw) => raw * 4 - 54, // kenwood.c kenwood_get_level 沒有 str_cal 時（QMX 暫用，未校正，M11）
};

// protocol：這筆 S 表指令的協定（機型覆寫要跟指令集一致才用）
const smAscii = (text) => Object.assign(() => steps(text), { protocol: 'ascii' });
const smCiv = Object.assign(({ civ: a }) => [step(civ.readSmeter(a))], { protocol: 'civ' });
const smY5 = Object.assign(() => [step(yaesu5.readRxStatus(), { expect: { kind: 'rx', len: 1 }, gapMs: Y5_ACK_GAP_MS })], { protocol: 'yaesu5' });
// cal：STR_CAL 的表名或 STR_FORMULA 的公式名；alternate：與讀頻輪替（CI-V 背靠背、Yaesu 5-byte 期待長度，M6）；calibrated＝false 畫面標 ≈
const sm = (stepsFn, cal, { alternate = false, calibrated = true } = {}) => Object.freeze({ steps: stepsFn, protocol: stepsFn.protocol, cal, alternate, calibrated });
const civSm = (cal, calibrated = true) => sm(smCiv, cal, { alternate: true, calibrated });
const y5Sm = (cal, calibrated = true) => sm(smY5, cal, { alternate: true, calibrated });

// 指令集預設（沒有的＝沒有預設，要靠機型覆寫）
const SMETER_SET = {
  0: civSm('icomStd', false), // 其他 ICOM：CI-V 慣例 0／120／241（未逐台核對）
  1: y5Sm('ft817'),
  21: y5Sm('ft847'),
  2: sm(smAscii('SM0;'), 'yaesu16'),
  19: sm(smAscii('SM0;'), 'yaesu16'),
  3: sm(smAscii('SM0;'), 'yaesu16'),
  25: sm(smAscii('SM0;'), 'yaesu16'),
  26: sm(smAscii('SM0;'), 'yaesu16'),
  4: sm(smAscii('SM0;'), 'ft450'),
  6: sm(smAscii('SM0;'), 'yaesuDefault'),
  14: sm(smAscii('SM0;'), 'ts2000'),
  24: sm(smAscii('SM0;'), 'tx500'),
  18: sm(smAscii('SM;'), 'ts590'), // ts570.c TS570_STR_CAL（與 TS-590 表同值）；kenwood_get_level 送 SM
  17: sm(smAscii('SM;'), 'ts480'), // ts480.c trudx_caps
  10: sm(smAscii('SM;'), 'k3'), // k3.c k3_get_level（韌體 <4.37 的 SM;）
  23: sm(smAscii('SM;'), 'kenwoodLinear', { calibrated: false }), // QMX：SM0; 回 ?;、SM; 回 SM013;（device 2026-10-09）
};

// 機型覆寫（null＝這台不讀）。協谷位元組順序待實機（M10），先標未校正 ≈（review C2）
const SMETER_MODEL = {
  'ICOM IC-7300': civSm('ic7300'), 'ICOM IC-7300MK2': civSm('ic7300'), 'ICOM IC-705': civSm('ic7300'), 'ICOM IC-9700': civSm('ic7300'),
  'ICOM IC-7000': civSm('ic7000'),
  'ICOM IC-706MKII': civSm('ic706iig'), 'ICOM IC-706MKIIG': civSm('ic706iig'),
  'ICOM IC-7410': civSm('ic7410'),
  'ICOM IC-7600': civSm('ic7600'), 'ICOM IC-7610': civSm('ic7600'),
  'ICOM IC-7100': civSm('icomStd'), 'ICOM IC-7200': civSm('icomStd'), 'ICOM IC-7800': civSm('icomStd'),
  'ICOM IC-718': civSm('icomUnknown', false), 'ICOM IC-9100': civSm('icomUnknown', false),
  'ICOM IC-746': civSm('ic746'), 'ICOM IC-746PRO': civSm('ic746'),
  'ICOM IC-756PRO': civSm('ic756pro'), 'ICOM IC-756PRO2': civSm('ic756pro'), 'ICOM IC-756PRO3': civSm('ic756pro'),
  'WB2CBA Pebble HF': null, 'WB2CBA TDX': null, 'WB2CBA TinyDX': null,
  'XIEGU G90S(USB)': civSm('x108g', false), 'XIEGU G90S(U-DIG)': civSm('x108g', false), 'XIEGU X108': civSm('x108g', false), 'XIEGU X5105': civSm('x108g', false),
  'XIEGU X6200(U-DIG)': civSm('x108g', false), 'XIEGU X6100(U-DIG)': civSm('icomStd', false),
  'KENWOOD TS-590': sm(smAscii('SM0;'), 'ts590'), // kenwood_get_level：RIG_IS_TS590S → SM0
  'KENWOOD TS-480': sm(smAscii('SM0;'), 'ts480'), // RIG_IS_TS480 → SM0
  'BG2FX FX-4CR': sm(smAscii('SM;'), 'ts590'), // ts590.c fx4_caps：TS590_STR_CAL，不是 RIG_IS_TS590S → SM
  'QRPLabs QDX': sm(smAscii('SM;'), 'ts480'), // ts480.c qrplabs_caps
  '(tr)uSDX (TS-480)': sm(smAscii('SM;'), 'ts480'), // ts480.c trudx_caps
  'YAESU FT-DX101': sm(smAscii('SM0;'), 'ftdx101'),
  'OTHER KN990': y5Sm('ft817', false),
  'mcHF-QRP sdr': y5Sm('ft817', false),
};

// 這個指令集＋機型的 S 表設定；不讀回 null。沒有機型名稱（或機型不在覆寫表）用指令集預設
export function smeterFor(setId, model = '') {
  const set = getSet(setId);
  if (!set) return null;
  if (model && Object.hasOwn(SMETER_MODEL, model)) {
    const m = SMETER_MODEL[model];
    return m && m.protocol === set.protocol ? m : null;
  }
  return SMETER_SET[setId] ?? null;
}

// 原始值 → 相對 S9 的 dB（整數，同 Hamlib val->i）；不能換算回 null
export function smeterDb(meter, raw) {
  if (!meter || !Number.isFinite(raw) || raw < 0) return null;
  const v = STR_FORMULA[meter.cal] ? STR_FORMULA[meter.cal](raw) : interp(STR_CAL[meter.cal], raw);
  return v === null ? null : Math.round(v);
}

// dB → S 單位（M4）：S0～S9，S9 以上 10 dB 一級到 S9+60
export function sUnits(db) {
  if (db === null || db === undefined || !Number.isFinite(db)) return null;
  if (db <= 0) return `S${Math.min(9, Math.max(0, Math.round((db + 54) / 6)))}`;
  const plus = Math.min(60, Math.round(db / 10) * 10);
  return plus ? `S9+${plus}` : 'S9';
}

export const SETS = Object.freeze(Object.fromEntries(LIST.map((s) => [s.id, Object.freeze({ alc: null, ...s })])));

// ALC 讀數判斷（add-rig-autosetup A15）：'none'（ALC 沒動作）｜'low'（低於最佳範圍，協谷）｜'ok'｜'high'（超過 App 警告門檻）；不能判斷回 null
export function alcLevel(alc, raw) {
  if (!alc || !Number.isFinite(raw)) return null;
  if (raw > alc.max) return 'high';
  if (alc.min !== undefined && raw < alc.min) return 'low';
  return raw === 0 ? 'none' : 'ok';
}

export function getSet(id) {
  return SETS[id] ?? null;
}

// 模式提前量（App GeneralVariables.getModeAudioLeadMs）：PTT 指令比音訊起點多提早這麼多
export function modeLeadMs(mode) {
  if (mode === 'JTTY') return 100; // JTTY 隨時發射（add-web-jtty jtty-chat「立即開始」：PTT 前置 100 ms）
  return mode === 'FT2' ? 200 : mode === 'FT4' ? 150 : 100;
}
