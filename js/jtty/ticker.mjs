// JTTY 字幕跑馬燈的排程（純邏輯，使用者 2026-10-09）：JTTY 會把句子拆成多個 frame，瀑布圖上隨瀑布往下捲的標籤看不懂，
// 改成瀑布圖下方的字幕區，每台電台一條，文字從右往左一個字一個字「打出來」，前面標頻率與色塊（同頻率尺的 ▼ 與瀑布圖的虛線）。
// 這裡只管：每條的訊息與已顯示字數、速度與積壓追趕、閒置淡出移除、顏色分配、上限；DOM 在 ticker-ui.mjs。
// 時間一律用牆上時鐘（performance.now），不用 frame 的 t0：t0 是資料時間，晚到的 frame 會被誤判閒置。

export const BASE_CPS = 3; // 每秒顯示字數（JTTY 一個 frame 5 字／1.888 s ≈ 2.65 字／s，稍快才不會越積越多）
export const BACKLOG_CHARS = 10; // 尚未顯示的字超過這個數就加速：每多 1 個字每秒多 1 個字
export const IDLE_MS = 20_000; // 全部顯示完後閒置這麼久就移除
export const FADE_MS = 1_500; // 移除前的淡出時間（含在 IDLE_MS 內）
export const MERGE_HZ = 20; // 新訊息與某條的頻率差在這之內就接在同一條（組合器最大容差 10＋3×2＝16 Hz）
export const MAX_DT_MS = 1_000; // 兩次推進相隔超過這麼久（背景分頁）就直接跳到最新，不補播
export const KEEP_CHARS = 160; // 畫面只畫最後這麼多字
export const SEP = ' ｜ '; // 同一台的下一則訊息
export const MAX_LANES_DESKTOP = 3;
export const MAX_LANES_PHONE = 2;
// 各條的顏色：黑底（字幕區與瀑布圖）上都清楚，避開瀑布圖配色（黑→藍→青→白）、發射頻率的黃、頻率尺的青
export const PALETTE = ['#ff9f40', '#ff66d9', '#9dff57', '#ff6b6b'];

const cps = (backlog) => (backlog > BACKLOG_CHARS ? BASE_CPS + (backlog - BACKLOG_CHARS) : BASE_CPS);

export class TickerModel {
  constructor({ maxLanes = MAX_LANES_DESKTOP, palette = PALETTE } = {}) {
    this.maxLanes = Math.max(1, maxLanes);
    this.palette = palette;
    this.lanes = [];
    this.nextKey = 1;
  }

  clear() {
    this.lanes = [];
  }

  // 組合器的快照 { id, freqHz, text, state }（state：receiving／complete／incomplete）；回傳所屬的條，不合格回 null
  update(snap, now) {
    if (!snap || typeof snap.text !== 'string' || !Number.isFinite(snap.freqHz)) return null;
    let lane = this.lanes.find((l) => l.msgs.some((m) => m.id === snap.id));
    if (!lane) {
      lane = this.nearest(snap.freqHz);
      if (!lane) lane = this.addLane(snap.freqHz, now);
      lane.msgs.push({ id: snap.id, text: '', state: 'receiving' });
    }
    if (lane.pos >= total(lane)) lane.lastTick = now; // 已顯示完（沒有在推進）：從現在開始算，不要一下子跳完
    const msg = lane.msgs.find((m) => m.id === snap.id);
    msg.text = snap.text;
    msg.state = snap.state ?? 'receiving';
    lane.freqHz = snap.freqHz;
    lane.lastActivity = now;
    lane.pos = Math.min(lane.pos, total(lane)); // 文字不會變短；萬一變短，不要指到結尾外面
    return lane;
  }

  nearest(freqHz) {
    let best = null;
    for (const l of this.lanes) {
      const df = Math.abs(l.freqHz - freqHz);
      if (df <= MERGE_HZ && (!best || df < best.df)) best = { l, df };
    }
    return best?.l ?? null;
  }

  addLane(freqHz, now) {
    while (this.lanes.length >= this.maxLanes) this.evictOldest();
    const used = new Set(this.lanes.map((l) => l.color));
    const key = this.nextKey++;
    const color = this.palette.find((c) => !used.has(c)) ?? this.palette[key % this.palette.length];
    const lane = { key, freqHz, color, msgs: [], pos: 0, lastTick: now, lastActivity: now };
    this.lanes.push(lane);
    return lane;
  }

  evictOldest() {
    let old = this.lanes[0];
    for (const l of this.lanes) if (l.lastActivity < old.lastActivity) old = l;
    this.lanes = this.lanes.filter((l) => l !== old);
  }

  // 手機／桌機切換：超過的留最新活動的
  setMaxLanes(n) {
    this.maxLanes = Math.max(1, n);
    while (this.lanes.length > this.maxLanes) this.evictOldest();
  }

  // 推進到 now；instant＝全部直接顯示完（減少動態效果）。移除閒置的條。回傳是否還有字要顯示（要不要繼續排動畫）
  advance(now, { instant = false } = {}) {
    let moving = false;
    for (const l of this.lanes) {
      const end = total(l);
      const dt = now - l.lastTick;
      l.lastTick = now;
      if (l.pos < end) {
        if (instant || dt > MAX_DT_MS) l.pos = end;
        else l.pos = Math.min(end, l.pos + (cps(end - l.pos) * Math.max(0, dt)) / 1000);
        l.lastActivity = now; // 閒置從顯示完才開始算
        if (l.pos < end) moving = true;
      }
    }
    this.lanes = this.lanes.filter((l) => now - l.lastActivity < IDLE_MS);
    return moving;
  }

  // 下一次狀態改變（開始淡出或移除）還要多久；沒有條回 null
  nextDeadline(now) {
    let next = null;
    for (const l of this.lanes) {
      const idle = now - l.lastActivity;
      const at = idle < IDLE_MS - FADE_MS ? IDLE_MS - FADE_MS - idle : IDLE_MS - idle;
      next = next === null ? at : Math.min(next, at);
    }
    return next === null ? null : Math.max(0, next);
  }

  // 頻率尺的 ▼ 與瀑布圖的虛線
  stations() {
    return this.lanes.map((l) => ({ freqHz: l.freqHz, color: l.color }));
  }

  // 畫面要的資料，依頻率由低到高（同頻率尺由左到右）
  // spans：已顯示部分的最後 KEEP_CHARS 字，依訊息分段（cls：''／'incomplete'／'sep'）；
  // frac：最新一個字還有多少在右邊外面（0～1 字寬，平滑捲動用）；receiving：最後一則還在接收（尾端「…」）
  view(now) {
    return [...this.lanes].sort((a, b) => a.freqHz - b.freqHz).map((l) => {
      const shown = Math.max(0, Math.ceil(l.pos - 1e-9)); // 浮點誤差不要多畫一個字
      const last = l.msgs[l.msgs.length - 1];
      return {
        key: l.key,
        freqHz: Math.round(l.freqHz),
        color: l.color,
        spans: spansOf(l, shown),
        shown,
        total: total(l),
        frac: Math.max(0, shown - l.pos),
        receiving: last?.state === 'receiving',
        fading: now - l.lastActivity >= IDLE_MS - FADE_MS,
      };
    });
  }
}

function segments(lane) {
  const out = [];
  lane.msgs.forEach((m, i) => {
    if (i > 0) out.push({ text: SEP, cls: 'sep' });
    out.push({ text: m.text, cls: m.state === 'incomplete' ? 'incomplete' : '' });
  });
  return out;
}

function total(lane) {
  return segments(lane).reduce((n, s) => n + s.text.length, 0);
}

// 前 shown 個字裡的最後 KEEP_CHARS 個字，保留分段
function spansOf(lane, shown) {
  const from = Math.max(0, shown - KEEP_CHARS);
  const out = [];
  let at = 0;
  for (const s of segments(lane)) {
    const a = Math.max(at, from);
    const b = Math.min(at + s.text.length, shown);
    if (b > a) out.push({ text: s.text.slice(a - at, b - at), cls: s.cls });
    at += s.text.length;
  }
  return out;
}
