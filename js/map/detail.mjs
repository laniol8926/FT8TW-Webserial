// 放大後的向量圖（add-map-overlays D14～D16，使用者 2026-10-09：「地圖放大到台灣的程度，畫面就糊掉了」）。純函式，有單元測試。
// 衛星影像、地形淡色（還有 3D 簡圖的貼圖）都是 4096 px 寬的等距圓柱圖，約 11.4 px／度；放大超過約 1.2 倍就開始糊。
// 這裡決定：每度幾個 CSS 像素（pxPerDeg：2D 是 projection.scaleOf；3D 是畫面寬／globeLonSpan）時，影像淡出多少、
// 用哪一級 Natural Earth 向量資料（1:50m、1:10m），以及資料的解析（差分＋字串編碼）、依視野裁切、配色。
// 畫在 map.mjs（2D）與 globe.mjs（3D 細節貼圖）；資料由 tools/gen-map-assets.mjs --detail 產生、layers.mjs 載入。

export const IMAGE_PX_PER_DEG = 4096 / 360;
// 影像交叉淡化的範圍（每度 CSS 像素）：14 開始淡出、22 完全是向量圖。3D 手動拉到最近（globemath MIN_ZOOM_DIST）時 250 px 高的小地圖也有 50 px／度以上，淡化做得完
export const FADE_START_PX_PER_DEG = 14;
export const FADE_END_PX_PER_DEG = 22;
// 分級：min 以上用這級；prefetch 以上就先下載（淡出開始時資料已經在，不會突然出現）。比 1:50m 更遠用原本的 1:110m（不另外下載）
export const DETAIL_TIERS = Object.freeze([
  Object.freeze({ id: '50m', min: FADE_START_PX_PER_DEG, prefetch: 11 }),
  Object.freeze({ id: '10m', min: 40, prefetch: 32 }),
]);
// 各級的檔案（web/assets/map/）；1:50m 的州界就是 admin1.json（州界開關已經在用）
export const DETAIL_FILES = Object.freeze({
  '50m': Object.freeze({ land: 'land-50m.json', borders: 'borders-50m.json', states: null }),
  '10m': Object.freeze({ land: 'land-10m.json', borders: 'borders-10m.json', states: 'states-10m.json' }),
});
export const MAX_DETAIL_LINES = 100_000;
export const MAX_DETAIL_POINTS = 1_000_000;
// 下載失敗後多久再試（code review D19 a）：不是每幀重發（飛行中會一直發），也不是永遠不再試
export const DETAIL_RETRY_MS = 30_000;

const ok = (v) => Number.isFinite(v);

/**
 * 這個 key（'50m:land' 之類）現在可以發請求？reqs：Map key → { failedAt }（null＝下載中或已成功；數字＝失敗的時間）。
 * 沒發過、或上次失敗已過 retryMs 才發
 */
export function canRequest(reqs, key, now, retryMs = DETAIL_RETRY_MS) {
  const r = reqs.get(key);
  return !r || (r.failedAt !== null && now - r.failedAt >= retryMs);
}

/** 影像淡出、向量圖淡入的比例 0～1（smoothstep；門檻以下 0、以上 1） */
export function vectorFade(pxPerDeg) {
  if (!ok(pxPerDeg)) return 0;
  const t = Math.min(1, Math.max(0, (pxPerDeg - FADE_START_PX_PER_DEG) / (FADE_END_PX_PER_DEG - FADE_START_PX_PER_DEG)));
  return t * t * (3 - 2 * t);
}

/** 這個縮放要用的分級（'50m'、'10m'）；null＝原本的 1:110m 輪廓 */
export function detailTier(pxPerDeg) {
  let out = null;
  for (const t of DETAIL_TIERS) if (ok(pxPerDeg) && pxPerDeg >= t.min) out = t.id;
  return out;
}

/** 這個縮放要先下載的分級 */
export function tiersToLoad(pxPerDeg) {
  return DETAIL_TIERS.filter((t) => ok(pxPerDeg) && pxPerDeg >= t.prefetch).map((t) => t.id);
}

/** 已下載好的分級中可以用的：要的那級還沒好就退一級；不會用比要的更細的 */
export function readyTier(pxPerDeg, ready) {
  const want = DETAIL_TIERS.findIndex((t) => t.id === detailTier(pxPerDeg));
  for (let i = want; i >= 0; i--) if (ready.has(DETAIL_TIERS[i].id)) return DETAIL_TIERS[i].id;
  return null;
}

// 單一數字最多 8 個字元（40 bit）：再多就是壞資料（一長串續接字元會讓 mul 溢位成 Infinity、z 變 NaN，code review D19 #1）
const MAX_MUL = 2 ** 35;

/** encodeInts（產生器）的反函式：每個字元 63～126，低 5 bit 是資料、第 6 bit 是「還有下一個字元」；zigzag 還原正負。壞字串（含單一數字超過 8 個字元）回 null */
export function decodeInts(str) {
  if (typeof str !== 'string') return null;
  const out = [];
  let z = 0;
  let mul = 1;
  let open = false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i) - 63;
    if (c < 0 || c > 63) return null;
    z += (c & 0x1f) * mul;
    if (c & 0x20) {
      mul *= 32;
      if (mul > MAX_MUL) return null;
      open = true;
      continue;
    }
    out.push(z % 2 ? -(z + 1) / 2 : z / 2);
    z = 0;
    mul = 1;
    open = false;
  }
  return open ? null : out;
}

// 字串 → 整數座標（差分還原）；經緯度超出範圍回 null
function decodeLine(str, scale) {
  const d = decodeInts(str);
  if (!d || d.length < 4 || d.length % 2) return null;
  const ints = new Array(d.length);
  ints[0] = d[0];
  ints[1] = d[1];
  for (let i = 2; i < d.length; i++) ints[i] = ints[i - 2] + d[i];
  const lonMax = 180 * scale, latMax = 90 * scale;
  // 寫成 !(… <= …)：NaN 也擋得下來
  for (let i = 0; i < ints.length; i += 2) {
    const x = ints[i], y = ints[i + 1];
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !(Math.abs(x) <= lonMax) || !(Math.abs(y) <= latMax)) return null;
  }
  return ints;
}
function withBox(ints, scale) {
  const pts = new Float32Array(ints.length);
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i < ints.length; i += 2) {
    const lon = ints[i] / scale, lat = ints[i + 1] / scale;
    pts[i] = lon;
    pts[i + 1] = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return { pts, w, s, e, n };
}
const valid = (json, key) => Boolean(json) && json.v === 1 && json.enc === 'delta-polyline' && json.scale > 0 && Array.isArray(json[key]);

/** 國界、州界：[{ pts: Float32Array(lon, lat, …), w, s, e, n }]；壞的那條略過，總數超過上限整個回空 */
export function parseDetailLines(json, { maxLines = MAX_DETAIL_LINES, maxPoints = MAX_DETAIL_POINTS } = {}) {
  if (!valid(json, 'lines') || json.lines.length > maxLines) return [];
  const out = [];
  let total = 0;
  for (const str of json.lines) {
    const ints = decodeLine(str, json.scale);
    if (!ints) continue;
    total += ints.length / 2;
    if (total > maxPoints) return [];
    out.push(withBox(ints, json.scale));
  }
  return out;
}

/**
 * 陸地（含湖泊當洞，even-odd 填色）：{ tile, rings: [{ pts, skip: Uint8Array, w, s, e, n }] }。
 * skip[i]＝1：第 i 條邊（點 i → i+1，最後一條接回起點）落在切格的格線上（產生器切出來的，或資料本來沿 ±180°、−90° 的封口），畫海岸線時跳過
 */
export function parseLand(json, { maxLines = MAX_DETAIL_LINES, maxPoints = MAX_DETAIL_POINTS } = {}) {
  if (!valid(json, 'rings') || json.rings.length > maxLines) return { tile: 0, rings: [] };
  const T = json.tile > 0 ? Math.round(json.tile * json.scale) : 0;
  const rings = [];
  let total = 0;
  for (const str of json.rings) {
    const ints = decodeLine(str, json.scale);
    if (!ints || ints.length < 6) continue;
    const n = ints.length / 2;
    total += n;
    if (total > maxPoints) return { tile: 0, rings: [] };
    const skip = new Uint8Array(n);
    if (T) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [xa, ya, xb, yb] = [ints[2 * i], ints[2 * i + 1], ints[2 * j], ints[2 * j + 1]];
        if ((xa === xb && xa % T === 0) || (ya === yb && ya % T === 0)) skip[i] = 1;
      }
    }
    rings.push({ ...withBox(ints, json.scale), skip });
  }
  return { tile: json.tile > 0 ? json.tile : 0, rings };
}

const boxes = new WeakMap();
/** 折線（Float32Array lon, lat, …）的範圍 { w, s, e, n }（第一次算完快取） */
export function boxOf(f) {
  let b = boxes.get(f);
  if (!b) {
    b = withBox(Array.from(f), 1);
    delete b.pts;
    boxes.set(f, b);
  }
  return b;
}

/**
 * 畫面看得到的項目：[[item, off]]（off＝經度位移，360° 的倍數）。item 有 w/s/e/n（或是 Float32Array，用 boxOf）。
 * bounds 的經度是展開值（以視野中心展開，可超出 ±180°）；pad（度）讓線寬、海岸線在邊緣也畫得到
 */
export function visibleItems(items, bounds, offsets, pad = 0) {
  const out = [];
  const west = bounds.west - pad, east = bounds.east + pad, south = bounds.south - pad, north = bounds.north + pad;
  for (const it of items) {
    const b = ArrayBuffer.isView(it) ? boxOf(it) : it;
    if (b.s > north || b.n < south) continue;
    for (const off of offsets) if (b.w + off <= east && b.e + off >= west) out.push([it, off]);
  }
  return out;
}

/** 依中心點分到 tileDeg 見方的格：[{ w, s, e, n, items }]（格的範圍是成員範圍的聯集）。畫的時候整格一個 Path2D */
export function bucketize(items, tileDeg) {
  const map = new Map();
  for (const it of items) {
    const b = ArrayBuffer.isView(it) ? boxOf(it) : it;
    const key = `${Math.floor((b.w + b.e) / 2 / tileDeg)},${Math.floor((b.s + b.n) / 2 / tileDeg)}`;
    let g = map.get(key);
    if (!g) map.set(key, (g = { w: Infinity, s: Infinity, e: -Infinity, n: -Infinity, items: [] }));
    g.items.push(it);
    g.w = Math.min(g.w, b.w);
    g.s = Math.min(g.s, b.s);
    g.e = Math.max(g.e, b.e);
    g.n = Math.max(g.n, b.n);
  }
  return [...map.values()];
}

// 向量圖配色（D15）：簡圖照主題色（--map-sea、--map-land、--map-coast）；衛星、地形改畫時接近原本影像的色調，深色主題暗一些。
// 地形淡色的深色主題仍是偏亮的底（國界、圖層、國名沿用地形淡色的深色線與淺光暈，照樣看得清楚）
const PALETTES = Object.freeze({
  satellite: Object.freeze({
    light: Object.freeze({ sea: '#2C5A85', land: '#5E7A52', coast: '#A9BFA0' }),
    dark: Object.freeze({ sea: '#1E3F60', land: '#46613F', coast: '#8FA58A' }),
  }),
  relief: Object.freeze({
    light: Object.freeze({ sea: '#BCD3DE', land: '#EDE5D2', coast: '#8C9AA3' }),
    dark: Object.freeze({ sea: '#8FA9B8', land: '#C9BFA9', coast: '#6B7A84' }),
  }),
});
/** { sea, land, coast }；簡圖回 null（用主題的 CSS 變數）。eox（線上衛星圖磚）圖磚還沒到的地方用衛星色調墊底 */
export function vectorPalette(type, dark = false) {
  const p = PALETTES[type === 'eox' ? 'satellite' : type];
  return p ? (dark ? p.dark : p.light) : null;
}

/** 3D 細節貼圖的範圍：看得到的範圍 need 每邊再加 marginFrac 倍（緯度夾 ±90；經度最多一圈，展開值） */
export function regionFor(need, marginFrac = 0.5) {
  const dLon = (need.east - need.west) * marginFrac;
  const dLat = (need.north - need.south) * marginFrac;
  let west = need.west - dLon, east = need.east + dLon;
  if (east - west > 360) {
    const c = (west + east) / 2;
    [west, east] = [c - 180, c + 180];
  }
  return { west, east, south: Math.max(-90, need.south - dLat), north: Math.min(90, need.north + dLat) };
}

/** 貼圖範圍 r 涵蓋得了 need（經度可差 360° 的倍數）？ */
export function regionCovers(r, need) {
  if (!r) return false;
  if (need.south < r.south || need.north > r.north) return false;
  if (r.east - r.west >= 360) return true;
  const off = 360 * Math.round(((need.west + need.east) / 2 - (r.west + r.east) / 2) / 360);
  return need.west - off >= r.west && need.east - off <= r.east;
}
