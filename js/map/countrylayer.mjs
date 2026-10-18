// 國界與國名圖層的資料處理（add-map-settings-globe D7、D8）。純函式，有單元測試；畫在 map.mjs／globe.mjs。
//   borders.json：{ v:1, scale:100, lines:[[lon×100, lat×100, …], …] } → [Float32Array(lon, lat, …)]（度）
//   countries.json：{ v:1, items:[{ en, zh, lon, lat, min, rank }] }（Natural Earth NAME、NAME_ZHT、LABEL_X/Y、MIN_LABEL、LABELRANK）
// 國名依縮放只留夠大的國家（MIN_LABEL ≤ zoom），再依 MIN_LABEL、LABELRANK 排序，放得下才寫（不重疊、不蓋呼號）。
export const MAX_BORDER_LINES = 5000;
export const MAX_BORDER_POINTS = 200_000;
export const MAX_COUNTRIES = 1000;
// 全世界視野（跨度 360°）的 zoom：Natural Earth MIN_LABEL 1.7 是最大的一批國家（美、加、俄、中、巴西、澳洲…）
export const WORLD_ZOOM = 1.7;

// 國界線樣式（使用者 2026-10-08：衛星影像、地形淡色上國界不明顯）：依底圖與深淺色，由下往上畫的幾道線（寬度是 CSS 像素，
// 畫布已乘 devicePixelRatio）。影像上用「深色外框＋淺色細線」或「淺色光暈＋深色細線」；color null＝用主題的 --map-border（簡圖照舊）。
const line = (color, width) => Object.freeze({ color, width });
const SAT = Object.freeze([line('rgba(0,0,0,0.45)', 2.4), line('rgba(255,255,255,0.85)', 1.2)]);
// 簡圖國界 1.3 px（使用者 2026-10-09：州界不可以比國界顯眼；州界 0.6 px 淡虛線，overlays.overlayStyle）
const PLAIN = Object.freeze([line(null, 1.3)]);
export const BORDER_STYLES = Object.freeze({
  outline: Object.freeze({ light: PLAIN, dark: PLAIN }),
  satellite: Object.freeze({ light: SAT, dark: SAT }),
  // 地形淡色（使用者 2026-10-09：國界看不清楚）：白光暈在淡色底圖上看不出來，主線改深紫、1.7 px，光暈只留淡淡一層襯底
  relief: Object.freeze({
    light: Object.freeze([line('rgba(255,255,255,0.45)', 3.4), line('rgba(58,36,74,0.95)', 1.7)]),
    dark: Object.freeze([line('rgba(255,255,255,0.35)', 3.4), line('rgba(46,28,60,0.95)', 1.7)]),
  }),
});

/** 國界的畫法：[{ color, width }]（先畫的在下面）；不認得的底圖用簡圖 */
export function borderStyle(type, dark = false) {
  const s = BORDER_STYLES[type] ?? BORDER_STYLES.outline;
  return dark ? s.dark : s.light;
}

// 讀取失敗一律回空陣列（少了國界不影響電台位置，同 outline.mjs）
export function parseBorders(json) {
  if (!json || json.v !== 1 || !Array.isArray(json.lines) || !(json.scale > 0)) return [];
  if (json.lines.length > MAX_BORDER_LINES) return [];
  const out = [];
  let total = 0;
  for (const line of json.lines) {
    if (!Array.isArray(line) || line.length < 4 || line.length % 2) continue;
    total += line.length / 2;
    if (total > MAX_BORDER_POINTS) return [];
    const f = new Float32Array(line.length);
    let ok = true;
    for (let i = 0; i < line.length; i++) {
      const v = line[i] / json.scale;
      if (!Number.isFinite(v) || Math.abs(v) > (i % 2 ? 90 : 180)) {
        ok = false;
        break;
      }
      f[i] = v;
    }
    if (ok) out.push(f);
  }
  return out;
}

// 國名覆寫（使用者 2026-10-08）：台灣一律寫「台灣」／"Taiwan"（Natural Earth NAME_ZHT 是「中華民國」）；其他國家照 Natural Earth。
// gen-map-assets.mjs 產生素材時套用，載入時（parseCountries）再套一次，舊素材也不會寫錯。
export const NAME_OVERRIDES = Object.freeze([
  Object.freeze({ match: ['Taiwan', 'Republic of China', '中華民國'], en: 'Taiwan', zh: '台灣' }),
]);

/** 依 NAME_OVERRIDES 換掉國名（英文或中文名任一相符即換）；沒有相符就原樣回傳 */
export function overrideName(item) {
  const o = NAME_OVERRIDES.find((x) => x.match.includes(item.en) || x.match.includes(item.zh));
  return o ? { ...item, en: o.en, zh: o.zh } : item;
}

const str = (v, max = 60) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

export function parseCountries(json) {
  if (!json || json.v !== 1 || !Array.isArray(json.items) || json.items.length > MAX_COUNTRIES) return [];
  const out = [];
  for (const it of json.items) {
    const en = str(it?.en);
    if (!en || !Number.isFinite(it.lat) || !Number.isFinite(it.lon) || Math.abs(it.lat) > 90 || Math.abs(it.lon) > 180) continue;
    out.push({ ...overrideName({ en, zh: str(it.zh) ?? en }), lat: it.lat, lon: it.lon, min: Number.isFinite(it.min) ? it.min : 5, rank: Number.isFinite(it.rank) ? it.rank : 5 });
  }
  return out;
}

// 視野寬度涵蓋的經度跨度 → 縮放等級（跨度減半 +1，同網路地圖的 zoom）；比整個世界還寬（2D 最多 400°）一樣算全世界
export function zoomOf(lonSpan) {
  return Math.log2(360 / Math.min(360, Math.max(lonSpan, 1e-6))) + WORLD_ZOOM;
}

// 依縮放挑出要寫的國名，依優先順序排好：MIN_LABEL 小（大國）先，再 LABELRANK、英文名
const isTaiwan = (c) => (c.en === 'Taiwan' ? 1 : 0);

export function countryLabels(countries, { lonSpan, locale = 'en' }) {
  const zoom = zoomOf(lonSpan);
  return countries
    .filter((c) => c.min <= zoom + 1e-9)
    // 台灣一律最先擺（使用者 2026-10-09：中國寫了、台灣被呼號擠掉不妥）；其他依 min、rank
    .sort((a, b) => isTaiwan(b) - isTaiwan(a) || a.min - b.min || a.rank - b.rank || a.en.localeCompare(b.en))
    .map((c) => ({ id: c.en, text: locale === 'zh-TW' ? c.zh : c.en, lat: c.lat, lon: c.lon }));
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 國名置中寫在標示點上；超出畫面、與已放的國名或 avoid（呼號標籤、標點）重疊就不寫。
 * @param items [{ id, text, x, y }]（已依優先順序排好）
 * @param avoid [{ x, y, w, h }]
 * @returns [{ id, text, x, y, w, h }]（文字框左上角）
 */
export function placeCountryNames(items, { width, height, measure, fontPx = 11, avoid = [], pad = 3, max = 60 }) {
  const h = fontPx + 2;
  const placed = [];
  for (const it of items) {
    if (placed.length >= max) break;
    const w = measure(it.text) + 2;
    // 置中；台灣撞到呼號、標點時改試上、下、左、右（使用者 2026-10-09：島上的呼號常把台灣擠掉）。其他國家放不下就不寫
    const gap = h + 2;
    const tries = it.id === 'Taiwan' ? [[0, 0], [0, -gap], [0, gap], [-(w / 2 + 8), 0], [w / 2 + 8, 0]] : [[0, 0]];
    for (const [dx, dy] of tries) {
      const box = { x: it.x - w / 2 + dx, y: it.y - h / 2 + dy, w, h };
      if (box.x < 0 || box.y < 0 || box.x + w > width || box.y + h > height) continue;
      const padded = { x: box.x - pad, y: box.y - pad, w: w + 2 * pad, h: h + 2 * pad };
      if (placed.some((p) => overlaps(p, padded)) || avoid.some((a) => overlaps(a, box))) continue;
      placed.push({ id: it.id, text: it.text, ...box });
      break;
    }
  }
  return placed;
}
