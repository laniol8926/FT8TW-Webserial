// EOX Sentinel-2 cloudless 線上衛星圖磚（add-map-eox-imagery D1～D5）。純函式與排程器，有單元測試；瀏覽器取圖在 eoxsource.mjs。
// 服務：EOX::Maps WMTS，TileMatrixSet g（GoogleMapsCompatible，Web Mercator），XYZ 順序 z/y/x。
// 授權：非商業 CC BY-NC-SA 4.0，必須標示 EOX_ATTRIBUTION（https://cloudless.eox.at/documentation/license，2026-10-09 查證）。
// 請求量：只抓看得到的格、同時 ≤ 6、任意 1 秒 ≤ 16（滑動視窗）、want() 每次取代排隊；429／5xx／網路錯誤整個主機指數退避（429／503 另看 Retry-After），
// 連續 3 次視為連不上（down）；恢復時同時數 1→2→4→6 逐步放大。

export const EOX_HOST = 'tiles.maps.eox.at';
export const EOX_MAX_Z = 14;
export const TILE_PX = 256;
export const MERC_MAX_LAT = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI; // 85.0511…
export const EOX_ATTRIBUTION = Object.freeze({
  before: 'EOxCloudless ',
  href: 'https://cloudless.eox.at',
  after: ' by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)',
  text: 'EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)',
});
export const MAX_CONCURRENT = 6;
export const PER_SECOND = 16;
export const CACHE_SIZE = 300; // 約 79 MB（256×256×4 bytes）
export const CACHE_SIZE_PHONE = 150; // 手機（code review 6）
export const MAX_VIEW_TILES = 96;
export const DOWN_AFTER = 3; // 連續幾次主機層級失敗視為連不上
export const RAMP_AFTER = 2; // 主機失敗後，連續幾次成功同時數加倍一次（1→2→4→6）
export const MAX_RETRY_AFTER_MS = 300_000; // Retry-After 最多採用 5 分鐘
const RATE_GUARD_MS = 5;
const RATE_WINDOW_MS = 1000 + RATE_GUARD_MS; // 每秒上限的滑動視窗

export const isTileInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export const EOX_LAYER_2025 = 's2cloudless-2025_3857';
/** 圖磚網址（z/y/x）；layer：EOX 圖層（線上地圖來源 add-map-tile-source，預設 2025）；不在範圍內的整數回 null */
export function eoxTileUrl(z, x, y, layer = EOX_LAYER_2025) {
  if (!isTileInt(z, 0, EOX_MAX_Z)) return null;
  const n = 2 ** z;
  if (!isTileInt(x, 0, n - 1) || !isTileInt(y, 0, n - 1)) return null;
  return `https://${EOX_HOST}/wmts/1.0.0/${layer}/default/g/${z}/${y}/${x}.jpg`;
}

export const tileKey = (z, x, y) => `${z}/${x}/${y}`;
export function parseTileKey(key) {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(String(key));
  return m ? { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) } : null;
}

/** 緯度 → Web Mercator 的 y（0＝北緣 85.05°、1＝南緣），超出夾住 */
export function mercY(lat) {
  if (lat >= MERC_MAX_LAT) return 0;
  if (lat <= -MERC_MAX_LAT) return 1;
  const l = lat;
  const r = (l * Math.PI) / 180;
  return Math.min(1, Math.max(0, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2));
}
/** Web Mercator 的 y（0～1）→ 緯度 */
export function latOfMercY(f) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * f))) * 180) / Math.PI;
}

/** 圖磚的經緯度範圍 { w, e, n, s }；x 可以是展開值（超出 0～2^z−1，經度跟著展開） */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  return { w: (x / n) * 360 - 180, e: ((x + 1) / n) * 360 - 180, n: latOfMercY(y / n), s: latOfMercY((y + 1) / n) };
}

/** 最小足夠的層級：256·2^z/360 ≥ 每度（經度方向）像素 × 像素比；夾 0～maxZ */
export function zoomFor(pxPerDeg, dpr = 1, maxZ = EOX_MAX_Z) {
  const r = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const need = pxPerDeg * r;
  if (!(need > 0) || !Number.isFinite(need)) return 0;
  const z = Math.ceil(Math.log2((need * 360) / TILE_PX) - 1e-9);
  return Math.max(0, Math.min(maxZ, z));
}

function tileRange(bounds, z) {
  const { west, east, south, north } = bounds ?? {};
  if (![west, east, south, north].every(Number.isFinite) || east <= west || north <= south) return null;
  const n = 2 ** z;
  const r = {
    n, x0: Math.floor(((west + 180) / 360) * n), x1: Math.ceil(((east + 180) / 360) * n) - 1,
    y0: Math.max(0, Math.floor(mercY(north) * n)), y1: Math.min(n - 1, Math.ceil(mercY(south) * n) - 1),
    cx: (((west + east) / 2 + 180) / 360) * n, cy: ((mercY(north) + mercY(south)) / 2) * n,
  };
  r.count = r.x1 >= r.x0 && r.y1 >= r.y0 ? (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) : 0;
  // 不同的格（多份世界副本同一格只算一次）：請求量上限看這個
  r.unique = r.count ? Math.min(r.x1 - r.x0 + 1, n) * (r.y1 - r.y0 + 1) : 0;
  return r;
}
const HARD_MAX_TILES = 4096; // 防呆：一次最多列這麼多格（全世界 z14 有 2.7 億格）

/** 範圍內有幾個不同的格（不建清單；經度展開超過一圈時，世界副本的同一格只算一次） */
export function tileCount(bounds, z) {
  return tileRange(bounds, z)?.unique ?? 0;
}

/**
 * 看得到的格：bounds { west, east, south, north }（經度是展開值）→ [{ z, x, y, xu }]（x 取模、xu 為展開的格號），依離中心距離排序。
 * 緯度夾在 ±85.05°（以外沒有圖磚）；邊界剛好在格線上時不多拿下一格；超過 HARD_MAX_TILES 格回空
 */
export function visibleTiles(bounds, z) {
  const r = tileRange(bounds, z);
  if (!r || !r.count || r.count > HARD_MAX_TILES) return [];
  const out = [];
  for (let xu = r.x0; xu <= r.x1; xu++) {
    for (let y = r.y0; y <= r.y1; y++) out.push({ z, x: ((xu % r.n) + r.n) % r.n, y, xu, d: (xu + 0.5 - r.cx) ** 2 + (y + 0.5 - r.cy) ** 2 });
  }
  out.sort((a, b) => a.d - b.d);
  return out.map(({ d, ...t }) => t);
}

/** 依每度像素選層級並列出看得到的格；超過 maxTiles 就降一級 → { z, tiles } */
export function tilesFor(bounds, pxPerDeg, dpr = 1, { maxTiles = MAX_VIEW_TILES, maxZ = EOX_MAX_Z } = {}) {
  let z = zoomFor(pxPerDeg, dpr, maxZ);
  while (z > 0 && tileCount(bounds, z) > maxTiles) z--;
  return { z, tiles: visibleTiles(bounds, z) };
}

const STRIP_ERR_PX = 0.25; // 條帶內以線性內插緯度的最大誤差（目的地 256 px 高的等距圓柱）
const MAX_STRIPS = 64;
/** 重投影的水平條帶數：Mercator 的 y 對緯度是非線性的，低層級、高緯度切多條，誤差 < STRIP_ERR_PX；z 高時一條就夠 */
export function stripCount(z, y) {
  const n = 2 ** z;
  const top = latOfMercY(y / n), bot = latOfMercY((y + 1) / n);
  const pxPerDeg = TILE_PX / (top - bot);
  for (let k = 1; k < MAX_STRIPS; k *= 2) {
    let worst = 0;
    for (let i = 0; i < k && worst <= STRIP_ERR_PX; i++) {
      const a = latOfMercY((y + i / k) / n), b = latOfMercY((y + (i + 1) / k) / n);
      for (const f of [0.25, 0.5, 0.75]) worst = Math.max(worst, Math.abs(latOfMercY((y + (i + f) / k) / n) - (a + (b - a) * f)) * pxPerDeg);
    }
    if (worst <= STRIP_ERR_PX) return k;
  }
  return MAX_STRIPS;
}
/** 條帶：[{ sy, sh, n, s }]（來源像素 0～256 與上下緣緯度），上到下 */
export function stripsOf(z, y) {
  const k = stripCount(z, y);
  const n = 2 ** z;
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push({ sy: (i / k) * TILE_PX, sh: TILE_PX / k, n: latOfMercY((y + i / k) / n), s: latOfMercY((y + (i + 1) / k) / n) });
  }
  return out;
}

/**
 * 把 Web Mercator 圖磚 img 重投影成等距圓柱（同大小 TILE_PX×TILE_PX，上緣＝圖磚北緣、下緣＝南緣，緯度線性）畫進 g。
 * 每條條帶的上下緣換成緯度後線性放到目的地；條帶之間多畫 0.5 px，不留縫
 */
export function reprojectInto(g, img, z, y) {
  const strips = stripsOf(z, y);
  const top = strips[0].n, span = top - strips.at(-1).s;
  for (const st of strips) {
    const dy0 = ((top - st.n) / span) * TILE_PX;
    const dy1 = ((top - st.s) / span) * TILE_PX;
    g.drawImage(img, 0, st.sy, TILE_PX, st.sh, 0, dy0, TILE_PX, Math.min(TILE_PX - dy0, dy1 - dy0 + 0.5));
  }
  return strips.length;
}

/** 缺的格：找快取裡（has(key)）最近的祖先，去重後依層級由低到高（先畫粗的，細的蓋上去） */
export function fallbackTiles(missing, has, minZ = 0) {
  const seen = new Map();
  for (const t of missing) {
    for (let z = t.z - 1; z >= minZ; z--) {
      const d = 2 ** (t.z - z);
      const x = Math.floor(t.x / d), y = Math.floor(t.y / d), xu = Math.floor(t.xu / d);
      const k = tileKey(z, x, y);
      if (!has(k)) continue;
      const id = `${k}@${xu}`;
      if (!seen.has(id)) seen.set(id, { z, x, y, xu });
      break;
    }
  }
  return [...seen.values()].sort((a, b) => a.z - b.z);
}

/**
 * 畫一組格（2D 畫面、3D 貼圖共用）：缺的先畫快取裡最近的祖先（拉伸頂著），再畫目前層級已到的格。
 * src { has(key), image(z, x, y) }；rectOf({ w, e, n, s }) → { x, y, w, h }（目的地矩形；null＝不畫）
 * → { drawn（目前層級畫了幾格）, fallback（祖先幾格）, missing（目前層級缺幾格） }
 */
export function drawTileSet(g, tiles, src, rectOf, minZ = 0) {
  const missing = tiles.filter((t) => !src.has(tileKey(t.z, t.x, t.y)));
  const anc = fallbackTiles(missing, src.has, minZ);
  const counts = { drawn: 0, fallback: 0, missing: missing.length };
  const paint = (t) => {
    const img = src.image(t.z, t.x, t.y);
    const r = img && rectOf(tileBounds(t.z, t.xu, t.y));
    if (!r) return false;
    g.drawImage(img, 0, 0, TILE_PX, TILE_PX, r.x, r.y, r.w, r.h);
    return true;
  };
  for (const t of anc) if (paint(t)) counts.fallback++;
  for (const t of tiles) if (paint(t)) counts.drawn++;
  return counts;
}

/** LRU 快取（Map 保持插入順序：get 時移到最後）；丟掉或覆寫時呼叫 onEvict(value)（釋放 ImageBitmap） */
export class TileCache {
  constructor(max = CACHE_SIZE, onEvict = () => {}) {
    if (!(max >= 1)) throw new RangeError('TileCache 上限至少 1');
    this.max = max;
    this.onEvict = onEvict;
    this.map = new Map();
  }
  get size() { return this.map.size; }
  has(k) { return this.map.has(k); }
  keys() { return [...this.map.keys()]; }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) {
      this.onEvict(this.map.get(k));
      this.map.delete(k);
    }
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const [oldK, oldV] = this.map.entries().next().value;
      this.map.delete(oldK);
      this.onEvict(oldV);
    }
  }
  clear() {
    for (const v of this.map.values()) this.onEvict(v);
    this.map.clear();
  }
}

/**
 * HTTP Retry-After（秒數或 HTTP 日期）→ 要等的毫秒（0～MAX_RETRY_AFTER_MS）；看不懂回 null。
 * 日期要用牆上時間 wallNowMs 換算（排程器本身用單調時鐘）
 */
export function parseRetryAfter(value, wallNowMs) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  let ms;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else if (/^[A-Za-z]{3},/.test(v) && Number.isFinite(Date.parse(v))) ms = Date.parse(v) - wallNowMs;
  else return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/** 第 n 次失敗後等多久：baseMs·2^(n−1)，上限 maxMs；n ≤ 0 → 0 */
export function backoffMs(n, { baseMs = 2000, maxMs = 300_000 } = {}) {
  if (!(n > 0)) return 0;
  return Math.min(maxMs, baseMs * 2 ** (n - 1));
}

const MAX_TILE_FAILS = 2000; // 每格失敗紀錄的上限（滿了丟最舊的）

/**
 * 圖磚排程器。fetchTile(url, signal, { z, x, y }) → Promise<{ status, value, retryAfterMs? }>（value 為解好的圖；網路錯誤 reject；中止 reject AbortError）。
 * want(tiles)：目前要的格（優先順序），取代排隊；get／has 讀快取；status：'idle' | 'ok' | 'down'；onChange('tile' | 'status')。
 * now 應為單調時鐘（瀏覽器傳 performance.now()：系統時間往回調不會卡住）；suspend(true) 時排隊保留、不發新請求
 */
export class TileLoader {
  constructor({ fetchTile, urlOf = eoxTileUrl, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h),
    maxConcurrent = MAX_CONCURRENT, perSecond = PER_SECOND, cacheSize = CACHE_SIZE, onChange = () => {}, onEvict = () => {} }) {
    Object.assign(this, { fetchTile, urlOf, now, setTimer, clearTimer, maxConcurrent, perSecond, onChange });
    this.cache = new TileCache(cacheSize, onEvict);
    this.queue = []; // [{ key, url, z }]
    this.inflight = new Map(); // key → AbortController
    this.tileFails = new Map(); // key → { n, until }
    this.hostFails = 0;
    this.lastHostFailAt = -Infinity;
    this.pausedUntil = 0;
    this.retryUntil = 0; // 伺服器 Retry-After 指定的最早時間（online 也不提前）
    this.status = 'idle';
    this.limit = maxConcurrent; // 目前的同時數上限：主機失敗後降為 1，連續成功 RAMP_AFTER 次加倍
    this.okStreak = 0;
    this.starts = []; // 最近 1 秒內開始的請求時間（滑動視窗）
    this.suspended = false;
    this.timer = null;
    this.timerAt = Infinity;
    this.counts = { requested: 0, ok: 0, failed: 0, aborted: 0, maxInFlight: 0, maxZ: -1 };
    this.epoch = 0; // 換來源（reset）加一：舊來源晚到的結果不採用
  }
  has(key) { return this.cache.has(key); }
  get(key) { return this.cache.get(key); }

  want(tiles) {
    const t = this.now();
    const next = [];
    const keys = new Set();
    for (const tile of tiles ?? []) {
      const key = tileKey(tile.z, tile.x, tile.y);
      if (keys.has(key)) continue;
      keys.add(key);
      if (this.cache.has(key) || this.inflight.has(key)) continue; // 中止的請求已移出 inflight：再被要時會重新請求
      const f = this.tileFails.get(key);
      if (f && t < f.until) continue;
      const url = this.urlOf(tile.z, tile.x, tile.y);
      if (!url) continue;
      next.push({ key, url, z: tile.z, x: tile.x, y: tile.y });
    }
    // 不在新清單的進行中請求：中止並馬上移出 inflight（縮放、拖曳時舊層級、畫面外的不必等；之後又被要時不會被跳過）
    for (const [key, ctl] of this.inflight) {
      if (keys.has(key)) continue;
      ctl.abort();
      this.inflight.delete(key);
    }
    this.queue = next;
    this.pump();
  }

  cancel() {
    this.queue = [];
    for (const ctl of this.inflight.values()) ctl.abort();
    this.inflight.clear();
    this.clearPending();
  }

  /** 分頁隱藏、地圖收起：暫停發新請求（排隊保留）；恢復時接著發 */
  suspend(on) {
    const v = Boolean(on);
    if (v === this.suspended) return;
    this.suspended = v;
    if (v) this.clearPending();
    else this.pump();
  }

  /** 瀏覽器回到線上：提前試探一張（取消指數退避，但 Retry-After 照守；失敗數不歸零、同時數 1，成功後才逐步放大） */
  resetBackoff() {
    if (this.hostFails === 0 && this.status !== 'down') return this.pump(); // 主機正常（Wi-Fi 切換等也會觸發 online）：照舊
    this.pausedUntil = this.retryUntil > this.now() ? this.retryUntil : 0;
    this.limit = 1;
    this.okStreak = 0;
    this.clearPending();
    this.pump();
  }

  destroy() {
    this.cancel();
    this.cache.clear();
  }

  /**
   * 換來源（add-map-tile-source S5）：取消排隊與進行中、清快取（釋放）、清每格失敗與主機退避、狀態回 idle，之後用新的 urlOf。
   * 舊來源晚到的結果（epoch 不同）只釋放、不進快取、不算成敗
   */
  reset(urlOf) {
    this.cancel();
    this.cache.clear();
    this.epoch++;
    this.urlOf = urlOf;
    this.tileFails.clear();
    this.hostFails = 0;
    this.lastHostFailAt = -Infinity;
    this.pausedUntil = 0;
    this.retryUntil = 0;
    this.limit = this.maxConcurrent;
    this.okStreak = 0;
    this.setStatus('idle');
  }

  stats() {
    return { ...this.counts, inFlight: this.inflight.size, queued: this.queue.length, cached: this.cache.size, hostFailures: this.hostFails,
      pausedUntil: this.pausedUntil, status: this.status, limit: this.limit, suspended: this.suspended };
  }

  clearPending() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }
  wakeAt(at) {
    if (at >= this.timerAt) return;
    this.clearPending();
    this.timerAt = at;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.pump();
    }, Math.max(0, at - this.now()));
  }
  pump() {
    while (this.queue.length && !this.suspended) {
      const t = this.now();
      if (t < this.pausedUntil) return this.wakeAt(this.pausedUntil);
      // 主機層級失敗後一次只放一個試探，連續成功才逐步放大（this.limit）
      if (this.inflight.size >= this.limit) return;
      // 滑動視窗：任意 [s, s+1000) 內開始的請求 ≤ perSecond（多留 RATE_GUARD_MS：實際 fetch 比這裡記的時間晚一點點，邊界不會多算一個）
      while (this.starts.length && this.starts[0] <= t - RATE_WINDOW_MS) this.starts.shift();
      if (this.starts.length >= this.perSecond) return this.wakeAt(this.starts[0] + RATE_WINDOW_MS);
      this.starts.push(t);
      this.start(this.queue.shift());
    }
  }

  start(item) {
    const { key, url, z } = item;
    item.startedAt = this.now();
    item.epoch = this.epoch;
    const ctl = new AbortController();
    this.inflight.set(key, ctl);
    this.counts.requested++;
    this.counts.maxInFlight = Math.max(this.counts.maxInFlight, this.inflight.size);
    this.counts.maxZ = Math.max(this.counts.maxZ, z);
    let p;
    try {
      p = Promise.resolve(this.fetchTile(url, ctl.signal, { z, x: item.x, y: item.y }));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then((res) => this.done(item, ctl, res, null), (err) => this.done(item, ctl, null, err));
  }

  done(item, ctl, res, err) {
    const { key } = item;
    if (item.epoch !== this.epoch) { // 換來源前送出的：已中止、已移出 inflight；解好的圖釋放
      if (res?.value) this.cache.onEvict(res.value);
      return;
    }
    if (this.inflight.get(key) === ctl) this.inflight.delete(key);
    const status = res?.status ?? 0;
    const ok = Boolean(!err && status >= 200 && status < 300 && res.value);
    if (ctl.signal.aborted) {
      // 中止時已經解好的圖：照樣放進快取（不浪費、也不外洩記憶體），不觸發重畫；快取已有就釋放。又在排隊等著的話直接用並重畫
      this.counts.aborted++;
      if (ok && !this.cache.has(key)) {
        this.cache.set(key, res.value);
        const i = this.queue.findIndex((q) => q.key === key);
        if (i >= 0) {
          this.queue.splice(i, 1);
          this.onChange('tile');
        }
      } else if (res?.value) this.cache.onEvict(res.value);
      this.pump();
      return;
    }
    if (ok) {
      this.counts.ok++;
      this.cache.set(key, res.value);
      this.tileFails.delete(key);
      // 逐步恢復：失敗數一次減一；同時數連續成功 RAMP_AFTER 次加倍（1→2→4→6）。pausedUntil 不清（Retry-After 照守）。
      // 上次主機失敗前就送出的同一批成功不算（同「同一批失敗只算一次」）
      if (item.startedAt > this.lastHostFailAt) {
        this.hostFails = Math.max(0, this.hostFails - 1);
        if (this.limit < this.maxConcurrent && ++this.okStreak >= RAMP_AFTER) {
          this.limit = Math.min(this.maxConcurrent, this.limit * 2);
          this.okStreak = 0;
        }
      }
      this.setStatus('ok');
      this.onChange('tile');
    } else if (err || status === 0 || status === 429 || status >= 500) {
      // 主機層級：限流、伺服器錯誤、網路錯誤（離線、CORS）
      // 同一批（上次失敗前就送出的）只算一次，不因同時 6 個 429 一次跳到很長的退避
      this.counts.failed++;
      const t = this.now();
      if (item.startedAt > this.lastHostFailAt) this.hostFails++;
      this.lastHostFailAt = t;
      this.limit = 1;
      this.okStreak = 0;
      this.pausedUntil = Math.max(this.pausedUntil, t + backoffMs(this.hostFails));
      // 429／503 帶 Retry-After（fetchTile 已換成毫秒）：至少等到那時（上限 5 分鐘）
      const ra = res?.retryAfterMs;
      if ((status === 429 || status === 503) && Number.isFinite(ra) && ra >= 0) {
        const until = t + Math.min(MAX_RETRY_AFTER_MS, ra);
        this.retryUntil = Math.max(this.retryUntil, until);
        this.pausedUntil = Math.max(this.pausedUntil, until);
      }
      if (this.hostFails >= DOWN_AFTER) this.setStatus('down');
      // 放回排隊最前面：退避到期就由它試探（不必等下一次重畫）
      if (!this.queue.some((q) => q.key === key)) this.queue.unshift(item);
    } else {
      // 這一格壞了（404、解碼失敗）：只退避這格
      this.counts.failed++;
      const n = (this.tileFails.get(key)?.n ?? 0) + 1;
      this.tileFails.delete(key);
      this.tileFails.set(key, { n, until: this.now() + backoffMs(n) });
      if (this.tileFails.size > MAX_TILE_FAILS) this.tileFails.delete(this.tileFails.keys().next().value);
    }
    this.pump();
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.onChange('status');
  }
}
