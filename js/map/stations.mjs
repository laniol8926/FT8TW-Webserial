// 地圖用的「最近聽到的電台」：每個 slot 的解碼結果依發送者彙整，保留最近 N 分鐘（預設 15）。純邏輯，有單元測試。
// 狀態（CQ、叫我）看該台最新一則；網格沿用最後一次看到的（通聯中的訊息多半不帶網格）。
import { parseMessage } from '../ft8parse.mjs';
import { gridToLatLon } from '../maidenhead.mjs';

export const DEFAULT_WINDOW_MIN = 15;
export const WINDOW_CHOICES_MIN = Object.freeze([5, 15, 30, 60]);
export const MAX_STATIONS = 1000; // 長時間開著也不無限長大

// 一則訊息的發送者、收話方（CQ 時 null）、網格、是否 CQ、是否指名我方；找不出發送者（雜湊、自由文字、遙測）回 null
export function messageInfo(text, myCall = '') {
  const parsed = parseMessage(text);
  if (!parsed) return null;
  const first = String(text).trim().split(/\s+/)[0];
  const me = String(myCall).trim().toUpperCase();
  const isCq = first === 'CQ';
  return {
    sender: parsed.sender,
    to: isCq ? null : first.replace(/^<|>$/g, '') || null,
    grid: parsed.grid,
    isCq,
    callsMe: Boolean(me) && first.replace(/^<|>$/g, '') === me,
  };
}

export class StationTracker {
  constructor({ windowMin = DEFAULT_WINDOW_MIN } = {}) {
    this.windowMs = windowMin * 60_000;
    this.byCall = new Map();
  }

  setWindowMin(min) {
    this.windowMs = min * 60_000;
  }

  // 一個 slot 的解碼結果；回傳是否有變化（沒變就不必重畫）
  addSlot({ startUtc, results }, myCall = '') {
    let changed = false;
    for (const r of results ?? []) {
      const info = messageInfo(r.text, myCall);
      if (!info) continue;
      const old = this.byCall.get(info.sender);
      if (old && old.lastUtc > startUtc) continue; // 晚到的舊 slot 不蓋掉新狀態
      this.byCall.delete(info.sender); // 重新插入：Map 順序＝最近聽到的在最後
      this.byCall.set(info.sender, {
        call: info.sender,
        grid: info.grid ?? old?.grid ?? null,
        snr: r.snr,
        isCq: info.isCq,
        callsMe: info.callsMe,
        to: info.to, // 對方正在回應誰（地圖「回第三台」）
        lastUtc: startUtc,
      });
      changed = true;
    }
    while (this.byCall.size > MAX_STATIONS) this.byCall.delete(this.byCall.keys().next().value);
    return changed;
  }

  // 丟掉超過時間窗的；回傳是否有丟
  prune(now) {
    let changed = false;
    for (const [call, s] of this.byCall) {
      if (s.lastUtc < now - this.windowMs) {
        this.byCall.delete(call);
        changed = true;
      }
    }
    return changed;
  }

  get(call) {
    return this.byCall.get(call) ?? null;
  }

  clear() {
    const had = this.byCall.size > 0;
    this.byCall.clear();
    return had;
  }

  // 時間窗內的電台，最近聽到的在前
  list(now) {
    return [...this.byCall.values()].filter((s) => s.lastUtc >= now - this.windowMs).reverse();
  }
}

/**
 * 電台在地圖上的位置：真實網格永遠優先於國家中心點（同 FT8TW PanelMapScene.pick），兩者都沒有回 null。
 * @param approxLocate (call) => { lat, lon } | null，例如 cty.dat 前綴查國家中心點；沒有就只標有網格的
 */
export function locate(station, approxLocate = null) {
  const exact = station.grid ? gridToLatLon(station.grid) : null;
  if (exact) return { ...exact, approx: false };
  const approx = approxLocate?.(station.call);
  if (approx && Number.isFinite(approx.lat) && Number.isFinite(approx.lon)) return { lat: approx.lat, lon: approx.lon, approx: true };
  return null;
}

// ── 地圖只畫右邊目前清單裡的電台（使用者 2026-10-07：不需要自己的篩選條件）──

// 聽過的網格（通聯中的訊息多半不帶網格；清單裡只剩不帶網格的那幾則時，用之前聽過的）
export class GridMemory {
  constructor() {
    this.byCall = new Map();
  }

  get size() {
    return this.byCall.size;
  }

  learn(rows) {
    for (const r of rows ?? []) {
      const info = r?.text ? messageInfo(r.text) : null;
      if (!info?.grid) continue;
      this.byCall.delete(info.sender);
      this.byCall.set(info.sender, info.grid);
    }
    while (this.byCall.size > MAX_STATIONS) this.byCall.delete(this.byCall.keys().next().value);
  }

  get(call) {
    return this.byCall.get(call);
  }
}

// 清單的列（{ text, snr, startUtc, own? }）→ 地圖的電台：依發送者彙整、狀態看最新一則；我方發射的列不算
export function stationsFromRows(rows, myCall = '', memory = null) {
  const sorted = (rows ?? []).filter((r) => r?.text && !r.own).sort((a, b) => a.startUtc - b.startUtc);
  const tracker = new StationTracker({ windowMin: Number.MAX_SAFE_INTEGER / 60_000 });
  let i = 0;
  while (i < sorted.length) {
    const startUtc = sorted[i].startUtc;
    const results = [];
    for (; i < sorted.length && sorted[i].startUtc === startUtc; i++) results.push(sorted[i]);
    tracker.addSlot({ startUtc, results }, myCall);
  }
  const last = sorted.at(-1)?.startUtc ?? 0;
  return tracker.list(last).map((s) => (s.grid ? s : { ...s, grid: memory?.get(s.call) ?? null }));
}
