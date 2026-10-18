// JS8 多速度參數（add-web-js8-chat design D2、D4、D6、D8、W1）。
// 數值照 FT8TW Js8Encoder（MODES、periodMs、startDelayMs、nsps、MODE_SHORT_NAMES、enabledRxSubmodes）
// 與 Js8Receiver（RX_LEAD_MS、擷取長度）。submode 值對照 JS8Call Varicode::SubmodeType；8 是 FT8TW 自訂的 4S。

const RATE = 12000;
const SYMBOLS = 79;
const RX_LEAD_MS = 1000; // Js8Receiver.RX_LEAD_MS：slot 起點前多久開始擷取
const RX_TAIL_MS = 700; // 擷取長度的尾端餘裕（Js8Receiver.startCapture）

const row = (nsps, periodMs, startDelayMs, short, name, ft8twOnly = false) => Object.freeze({ nsps, periodMs, startDelayMs, short, name, ft8twOnly });

export const SUBMODES = Object.freeze({
  0: row(1920, 15000, 500, 'NOR 15S', 'NORMAL 15s'),
  1: row(1200, 10000, 200, 'FST 10S', 'FAST 10s'),
  2: row(600, 6000, 100, 'TUR 6S', 'TURBO 6s'),
  4: row(3840, 30000, 500, 'SLO 30S', 'SLOW 30s'),
  // FT8TW 專屬：Turbo 符號率再減半，與 JS8Call 不互通
  8: row(300, 4000, 100, 'FTW 4S', 'FT8TW 4s', true),
});

// UI 顯示順序（同 App MODES）
export const SUBMODE_LIST = Object.freeze([0, 1, 2, 4, 8]);

// 與 JS8Call 互通的四種：「同時解碼其他速度」開啟時一律解這些
const JS8CALL_COMPATIBLE = [0, 1, 2, 4];

export function isSubmode(n) {
  return Number.isInteger(n) && Object.hasOwn(SUBMODES, n);
}

export function submodeInfo(submode) {
  if (!isSubmode(submode)) throw new Error(`Unsupported JS8 submode: ${submode}`);
  return SUBMODES[submode];
}

export function periodMs(submode) {
  return submodeInfo(submode).periodMs;
}

export function startDelayMs(submode) {
  return submodeInfo(submode).startDelayMs;
}

// 收訊擷取窗：自 slot 起點前 1000 ms 起，長度＝提前量＋起始延遲＋79 符號音訊＋700 ms 餘裕
// （NOR 14840、FST 9800、TUR 5750、SLO 27480、FTW 3775 ms）
export function captureWindow(submode) {
  const { nsps, startDelayMs: delay } = submodeInfo(submode);
  return { leadMs: RX_LEAD_MS, durationMs: RX_LEAD_MS + delay + (SYMBOLS * nsps * 1000) / RATE + RX_TAIL_MS };
}

// 發射截止：本 slot 已過 slot 長度的 1/6 就延到下一個 slot（沿用 Normal 2.5 s／15 s 的比例）。
// 取整規則：四捨五入到整毫秒，所以 FST 10000/6＝1666.67 → 1667、FTW 4000/6＝666.67 → 667
// 截止：slot 的 1/6（design D8），但不晚於「從現在起發整個 frame（79 符號）＋結尾餘量 500 ms 還放得下」的最晚起點
// （code review 2026-10-07：Slow 1/6＝5000 但最晚只能 4220，原本會先接受、到 fire() 才報「太晚」）
const END_MARGIN_MS = 500; // 同 tx/controller.mjs END_MARGIN_MS
export function txCutoffMs(submode) {
  const { nsps } = submodeInfo(submode);
  const audioMs = (79 * nsps) / 12;
  return Math.min(Math.round(periodMs(submode) / 6), Math.floor(periodMs(submode) - audioMs - END_MARGIN_MS));
}

// 要解碼的速度（同 App enabledRxSubmodes）：關 → 只有發射速度；開 → {0,1,2,4}∪{發射速度}，由小到大。
// FTW 4S 與 JS8Call 不互通，只有被選為發射速度時才解。每次回傳新陣列
export function enabledRxSubmodes(txSubmode, multiSpeed = false) {
  submodeInfo(txSubmode);
  if (!multiSpeed) return [txSubmode];
  return [...new Set([...JS8CALL_COMPATIBLE, txSubmode])].sort((a, b) => a - b);
}

// PSKReporter：FTW 4S 非標準、JS8Call 收不到，填 JS8 會誤導，不回報（design W1）
export function reportable(submode) {
  return !submodeInfo(submode).ft8twOnly;
}
