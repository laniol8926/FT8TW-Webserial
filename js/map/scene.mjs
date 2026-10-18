// 地圖呼叫場景（移植 FT8TW PanelMapScene，design D32）：「現在該畫什麼」的完整描述。純邏輯，有單元測試；map.mjs 只負責畫。
// 三個位置（我方、目前對象、對方正在回應的第三台）與兩件正在發生的事：我方最近有沒有發射、對方最近在做什麼。
// 兩者可同時成立：我方剛送出去、對方上一拍正在叫我，畫面上是同一條航線上兩顆反向移動的光點。

// 保留幾個 slot 的資訊（FT8TW 使用者 2026-09-23 指定）：FT8 一來一往、每台隔一個 slot 才發射，
// 只看最近一個 slot 會讓指示隨發射週期一亮一暗；3 個以上就跨過對方「應該再發一次」的時機
export const FRESH_SLOT_COUNT = 2;

// slot 編號：先加週期的 5% 再除（同 Ft8Message.getSequence），剛好落在邊界前的訊息不會被算成上一個 slot
export function slotIndex(utcMs, slotMs) {
  if (!(slotMs > 0)) return 0;
  return Math.floor((utcMs + slotMs / 20) / slotMs);
}

// 訊息的 slot ≥ 目前 − FRESH_SLOT_COUNT。不可以寫成「與目前同號」：當下這個 slot 的解碼還不存在
export function withinRecentSlots(msgUtcMs, nowMs, slotMs) {
  return slotIndex(msgUtcMs, slotMs) >= slotIndex(nowMs, slotMs) - FRESH_SLOT_COUNT;
}

// 雜湊呼號（<...>）連對方自己都不知道是誰，不能拿去查位置
export function isLocatable(call) {
  if (call == null) return false;
  const c = String(call).replace(/[<>]/g, '').trim();
  return c !== '' && !c.includes('...');
}

// 對方最新一則的狀態：'none' | 'cq' | 'toMe' | 'toOther'。CQ 排最前（CQ 的收話方是 "CQ"，不先擋會被當成回第三台）
export function classify(fresh, isCq, callsMe, to) {
  if (!fresh) return 'none';
  if (isCq) return 'cq';
  if (callsMe) return 'toMe';
  return isLocatable(to) ? 'toOther' : 'none';
}

// 建立場景並正規化畫不出來的組合（同 PanelMapScene.of）：
//   不知道對方在哪 → none；回第三台但第三台位置不明 → none；叫我但不知道我在哪 → none；
//   我方或對方位置不明 → 沒有航線，myTx 視為 false
// 位置：{ lat, lon, approx }（approx＝國家中心點，畫虛線）
export function buildScene({ me = null, them = null, third = null, state = 'none', myTx = false }) {
  let s = them ? state : 'none';
  const t = s === 'toOther' ? third : null;
  if (s === 'toOther' && !t) s = 'none';
  if (s === 'toMe' && !me) s = 'none';
  const tx = Boolean(myTx && me && them);
  return { me, them, third: t, state: s, myTx: tx, animated: tx || s !== 'none' };
}

const samePos = (a, b) => a === b || (Boolean(a) && Boolean(b) && a.lat === b.lat && a.lon === b.lon && a.approx === b.approx);

// 三個位置是否相同：狀態、光點變了不算幾何變化（不必重算視野）
export function sameGeometry(a, b) {
  if (!a || !b) return false;
  return samePos(a.me, b.me) && samePos(a.them, b.them) && samePos(a.third, b.third);
}

// ── 光點沿航線移動（畫面座標）──
// 折線與累計長度：points [{x,y}] → { points, cum（每點的累計長度）, length }
export function polyline(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  return { points, cum, length: cum.at(-1) ?? 0 };
}

// 折線上比例 f（0 起點、1 終點）的位置；空折線回 null
export function pointAlong(line, f) {
  const { points, cum, length } = line;
  if (!points.length) return null;
  if (length === 0 || f <= 0) return { x: points[0].x, y: points[0].y };
  if (f >= 1) return { x: points.at(-1).x, y: points.at(-1).y };
  const d = f * length;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
  return { x: points[i - 1].x + (points[i].x - points[i - 1].x) * t, y: points[i - 1].y + (points[i].y - points[i - 1].y) * t };
}

// 光點在週期內的位置 0..1；forward＝起點往終點，反向＝終點往起點
export function dotPhase(nowMs, periodMs, forward) {
  const f = (((nowMs % periodMs) + periodMs) % periodMs) / periodMs;
  return forward ? f : (1 - f) % 1;
}

// ── 誰呼叫誰的連線動畫（使用者 2026-10-07：從發射端畫到接收端）──
// 出生後 durationMs 內從 0 畫到 1；ease-out（前段快、接近接收端時放慢，看得出「到了」）
export function revealFraction(nowMs, bornMs, durationMs) {
  if (durationMs <= 0) return 1;
  const t = (nowMs - bornMs) / durationMs;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - (1 - t) ** 3;
}

// 折線從起點截到比例 f 的那一段（終點內插）：畫到一半的線
export function partialPoints(line, f) {
  const { points, cum, length } = line;
  if (!points.length) return [];
  if (f >= 1) return points;
  const end = pointAlong(line, f);
  const d = Math.max(0, f) * length;
  const out = [points[0]];
  for (let i = 1; i < points.length && cum[i] < d; i++) out.push(points[i]);
  if (f > 0) out.push(end);
  return out;
}

// 連線動畫循環（使用者 2026-10-07：不要只畫一次就停）：每輪延伸 reveal → 停留 hold → 淡出 fade，然後重來
export const LINK_CYCLE = Object.freeze({ reveal: 1200, hold: 600, fade: 600, period: 2400 });

// born 之前（錯開還沒輪到）回 null；之後回本輪的 { f：畫到哪（0..1）, alpha：亮線的透明度 }
export function linkCycle(nowMs, bornMs, { reveal, hold, fade, period } = LINK_CYCLE) {
  if (nowMs < bornMs) return null;
  const t = (nowMs - bornMs) % period;
  if (t < reveal) return { f: revealFraction(t, 0, reveal), alpha: 1 };
  if (t < reveal + hold) return { f: 1, alpha: 1 };
  return { f: 1, alpha: 1 - (t - reveal - hold) / fade };
}

// 喊 CQ 的電台畫漣漪（使用者 2026-10-07，同 S20 摩登電台卡地圖的 CQ 同心圓）：最新一則是 CQ、
// 且在清單最新一則往前 slots 個 slot 內（很久以前喊過的不閃）。stations：[{ call, isCq, lastUtc }]
export function rippleCalls(stations, { slotMs, slots = 2 }) {
  const list = stations ?? [];
  const latest = Math.max(...list.map((s) => s.lastUtc), -Infinity);
  return list.filter((s) => s.isCq && latest - s.lastUtc < slots * slotMs).map((s) => s.call);
}
