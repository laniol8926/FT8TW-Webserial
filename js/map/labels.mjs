// 地圖標點的排序、標籤擺放（避免重疊）與點選命中判定。純函式，有單元測試。

// 優先順序：目前對象 > 叫我 > CQ > 其他；同級越近聽到的越前面。標籤密集時優先順序高的先放
export function kindOf(station, target) {
  if (target && station.call === target) return 'target';
  if (station.callsMe) return 'me';
  if (station.isCq) return 'cq';
  return 'other';
}
const RANK = { target: 0, me: 1, cq: 2, other: 3 };

export function byPriority(a, b) {
  return RANK[a.kind] - RANK[b.kind] || b.lastUtc - a.lastUtc;
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 依序（呼叫端先排好優先順序）替每個標點找一個不與已放標籤、其他標點重疊的位置：右、左、上、下。
 * 都放不下就不顯示這個標籤（標點照畫）。
 * @param items [{ id, x, y, text }]（x, y 為標點中心像素）
 * @param measure (text) => 文字寬度像素
 * @returns [{ id, x, y, w, h }]（標籤框左上角與大小；文字畫在框內）
 */
export function placeLabels(items, { width, height, measure, fontPx = 11, gap = 6, dotR = 5, max = 80 }) {
  const h = fontPx + 2;
  const dots = items.map((it) => ({ x: it.x - dotR, y: it.y - dotR, w: dotR * 2, h: dotR * 2, id: it.id }));
  const placed = [];
  for (const it of items) {
    if (placed.length >= max) break;
    const w = measure(it.text) + 2;
    const candidates = [
      { x: it.x + gap, y: it.y - h / 2 },
      { x: it.x - gap - w, y: it.y - h / 2 },
      { x: it.x - w / 2, y: it.y - gap - h },
      { x: it.x - w / 2, y: it.y + gap },
    ];
    for (const c of candidates) {
      const box = { ...c, w, h };
      if (box.x < 0 || box.y < 0 || box.x + w > width || box.y + h > height) continue;
      if (placed.some((p) => overlaps(p, box))) continue;
      if (dots.some((d) => d.id !== it.id && overlaps(d, box))) continue;
      placed.push({ id: it.id, ...box });
      break;
    }
  }
  return placed;
}

// 同一個網格的電台畫在同一點：只給第一個（優先順序最高的）標籤，文字加上「+其餘台數」。
// points 需先依優先順序排好；回傳 [{ id, x, y, text }]
export function labelItems(points, eps = 2) {
  const items = [];
  for (const p of points) {
    const same = items.find((it) => Math.abs(it.x - p.x) <= eps && Math.abs(it.y - p.y) <= eps);
    if (same) same.extra += 1;
    else items.push({ id: p.call, x: p.x, y: p.y, extra: 0 });
  }
  return items.map(({ extra, ...it }) => ({ ...it, text: extra ? `${it.id} +${extra}` : it.id }));
}

// 點選命中：半徑內最近的標點；同距離取優先順序高的（陣列中較前面的）。沒有回 null
export function pickAt(points, x, y, radius) {
  let best = null;
  let bestD = radius * radius;
  for (const p of points) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d <= bestD && (best === null || d < bestD)) {
      best = p;
      bestD = d;
    }
  }
  return best;
}
