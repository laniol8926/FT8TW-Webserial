// 清單選取的電台在地圖上特別顯眼（add-map-overlays E、D11）：從清單的列找出要標示的呼號、什麼時候取消。純函式，有單元測試。
// 解碼清單、呼叫清單、電台卡左鍵點選 → panel.selectRow(row)；地圖的繪製層只負責畫（map.mjs、globe.mjs 的 setSelected）。
import { messageInfo } from './stations.mjs';

/** 列（{ text, own? }）→ 要標示的呼號（發話方）；我方發射的列、發話方是我自己、雜湊或解析不出 → null */
export function selectionCall(row, myCall = '') {
  if (!row || row.own || typeof row.text !== 'string') return null;
  const info = messageInfo(row.text, myCall);
  const call = info?.sender;
  if (!call || /[<>]|\.\.\./.test(call)) return null;
  if (call === String(myCall).trim().toUpperCase()) return null;
  return call;
}

export const SELECT_PULSE_MS = 1200; // 閃動光環一輪
export const SELECT_GROW_PX = 2; // 標點加大

/** 標籤擺放順序：選取的電台排第一（placeLabels 最先放，不被其他標籤擠掉）；其餘照原順序 */
export function selectedFirst(points, call) {
  if (!call) return points;
  const i = points.findIndex((p) => p.call === call);
  return i <= 0 ? points : [points[i], ...points.slice(0, i), ...points.slice(i + 1)];
}

export const SELECT_PULSE_LIMIT_MS = 4000; // 閃這麼久就停，改成靜態粗環（C3：選取光環無時限時 2D、3D 一直重畫很耗電）

/** 選取後還在閃（選取後 SELECT_PULSE_LIMIT_MS 內） */
export function pulseActive(nowMs, sinceMs, limitMs = SELECT_PULSE_LIMIT_MS) {
  return sinceMs !== null && sinceMs !== undefined && nowMs - sinceMs < limitMs;
}

/**
 * 選取標點的各圈半徑（B2：原本的種類外圈照畫、跟著加大，選取光環放在最外圈之外，色盲也分得出「目前對象」「叫我」「概略位置」）
 * @returns {{ dot, halo, kindRing: number|null, approxRing: number|null, select }}
 */
export function selectedRadii(kind, r, approx = false) {
  const dot = r + SELECT_GROW_PX;
  const halo = dot + 1.5;
  const kindRing = kind === 'target' ? 7 + SELECT_GROW_PX : kind === 'me' ? dot + 3 : null;
  const approxRing = approx ? dot + 5 : null;
  return { dot, halo, kindRing, approxRing, select: Math.max(halo, kindRing ?? 0, approxRing ?? 0) + 3 };
}

/**
 * 選取標示（D12、B2）：照原本的種類畫加大的標點（目前對象空心＋墨色粗圈、叫我實心＋洋紅外圈、概略位置虛線圈），
 * 最後疊選取光環（先畫一道光暈色襯底，衛星影像、海上都看得清楚）；reduced（減少動態效果、閃完）時光環更粗。2D 靜態層與 3D overlay 共用。
 * @param g CanvasRenderingContext2D；r：原本的標點半徑；fill：種類色；halo、ink、callme、other：主題色；color：選取色
 */
export function drawSelectedMark(g, x, y, { kind, r, approx = false, fill, halo, ink, callme, other, color, reduced = false }) {
  const R = selectedRadii(kind, r, approx);
  const circle = (rad, style) => {
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fillStyle = style;
    g.fill();
  };
  const ring = (rad, style, width) => {
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.strokeStyle = style;
    g.lineWidth = width;
    g.stroke();
  };
  circle(R.halo, halo);
  circle(R.dot, kind === 'target' ? halo : fill);
  if (R.kindRing !== null) ring(R.kindRing, kind === 'target' ? ink : callme, kind === 'target' ? 2.5 : 1.5);
  if (R.approxRing !== null) {
    g.setLineDash([3, 3]);
    ring(R.approxRing, other, 1.5);
    g.setLineDash([]);
  }
  const width = reduced ? 3.5 : 2.5;
  ring(R.select, halo, width + 2);
  ring(R.select, color, width);
}

/** 閃動光環的一幀（動畫層）：從選取光環（半徑 r＝selectedRadii().select）往外擴散、淡出 */
export function drawSelectedPulse(g, x, y, nowMs, { r, color }) {
  const f = (((nowMs % SELECT_PULSE_MS) + SELECT_PULSE_MS) % SELECT_PULSE_MS) / SELECT_PULSE_MS;
  g.beginPath();
  g.arc(x, y, r + f * 14, 0, Math.PI * 2);
  g.strokeStyle = color;
  g.globalAlpha = 0.9 * (1 - f);
  g.lineWidth = 2.5;
  g.stroke();
  g.globalAlpha = 1;
}

/** 選取的呼號還在地圖的電台清單（[{ call }]）裡才保留；清單清空或已不在 → null */
export function keepSelection(call, stations) {
  if (!call || !Array.isArray(stations)) return null;
  return stations.some((s) => s?.call === call) ? call : null;
}
