// EOX 線上衛星圖磚的瀏覽器端（add-map-eox-imagery D2、D3、D11）：fetch → blob → createImageBitmap，重投影成等距圓柱後放進 LRU。
// 頁面層級單例：2D／3D 切換時快取不丟。只有使用者選了 eox 底圖、繪製層呼叫 eoxSource() 才會建立（預設不連外）。
// 排程、退避、上限都在 tiles.mjs TileLoader；這裡只接瀏覽器 API（fetch、createImageBitmap、canvas、時鐘、online／visibilitychange 都可注入，有單元測試）。
import { CACHE_SIZE, CACHE_SIZE_PHONE, EOX_MAX_Z, TILE_PX, TileLoader, parseRetryAfter, reprojectInto, stripCount, tileKey } from './tiles.mjs';
import { resolveTileSource } from './tilesource.mjs';

export const MAX_TILE_BYTES = 1 << 20; // 一張圖磚最多 1 MB（EOX 的 JPEG 約 10～60 KB）

let source = null;
let wantedSource = null; // 線上地圖來源（add-map-tile-source S5）：單例建立前先記下，建立時套用

/** 設定目前的線上地圖來源 { key, urlOf }（resolveTileSource 的結果）：單例已建立就直接換（清快取），否則只記下（不建立、不連外） */
export function configureTileSource(tileSource) {
  if (!tileSource?.key || typeof tileSource.urlOf !== 'function') return;
  wantedSource = tileSource;
  source?.setTileSource(tileSource);
}

/** 已建立的來源（沒選過 eox 時為 null：切回其他底圖時用來取消，不會因此建立） */
export function peekEoxSource() {
  return source;
}

/** 快取上限：手機（窄螢幕）或記憶體 ≤ 4 GB 用 CACHE_SIZE_PHONE（code review 6） */
export function cacheSizeFor({ phone = false, deviceMemory } = {}) {
  return phone || (Number(deviceMemory) > 0 && Number(deviceMemory) <= 4) ? CACHE_SIZE_PHONE : CACHE_SIZE;
}

const release = (v) => {
  if (!v?.img) return;
  if (typeof v.img.close === 'function') v.img.close();
  else v.img.width = 0;
};
const discard = (res) => {
  try {
    res.body?.cancel?.().catch?.(() => {});
  } catch { /* 已讀完或已鎖定 */ }
};

/** 讀回應本體，超過 max bytes 就放棄（取消串流）回 null；沒有串流時讀 blob 再看大小 */
export async function readBounded(res, max) {
  const type = res.headers?.get?.('content-type') ?? '';
  const reader = res.body?.getReader?.();
  if (!reader) {
    const b = await res.blob();
    return b.size > max ? null : b;
  }
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type });
}

/**
 * 取一張圖磚 → { status, value, retryAfterMs? }。value null＝這一格壞了（不是圖、太大、解不開、不是 256×256）。
 * 非 2xx 帶回 Retry-After（毫秒，日期以 wallNow 換算）
 */
export function makeFetchTile({ fetch, createImageBitmap, createCanvas, wallNow = () => Date.now() }) {
  return async function fetchTile(url, signal, { z, y }) {
    // credentials: 'omit'：不帶 cookie；Referer 照瀏覽器預設（只帶網站來源）
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
    if (!res.ok) {
      discard(res);
      return { status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), wallNow()) };
    }
    const bad = { status: res.status, value: null };
    const type = res.headers.get('content-type') ?? '';
    const len = Number(res.headers.get('content-length'));
    if (!type.startsWith('image/') || len > MAX_TILE_BYTES) {
      discard(res);
      return bad;
    }
    const blob = await readBounded(res, MAX_TILE_BYTES);
    if (!blob) return bad;
    let bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      return bad; // 解不開
    }
    if (bmp.width !== TILE_PX || bmp.height !== TILE_PX) {
      bmp.close?.();
      return bad;
    }
    if (stripCount(z, y) === 1) return { status: res.status, value: { img: bmp } };
    // 低層級、高緯度：Mercator 非線性，先重投影成等距圓柱（之後 2D、3D 都是單純的矩形 drawImage）
    const cv = createCanvas();
    cv.width = cv.height = TILE_PX;
    reprojectInto(cv.getContext('2d'), bmp, z, y);
    bmp.close();
    return { status: res.status, value: { img: cv } };
  };
}

/**
 * 建一個來源（單元測試直接用；頁面用 eoxSource() 單例）。
 * win：接 online 事件；doc：document.hidden 與 visibilitychange（隱藏時暫停發請求）；setVisible(false)：地圖收起或捲出畫面
 */
export function createEoxSource({ fetch, createImageBitmap, createCanvas, wallNow, now = () => performance.now(), setTimer, clearTimer,
  cacheSize = CACHE_SIZE, win = null, doc = null, fetchTile = makeFetchTile({ fetch, createImageBitmap, createCanvas, wallNow }),
  tileSource = resolveTileSource({}) }) {
  const listeners = new Set();
  let sourceKey = tileSource.key;
  let maxZ = tileSource.maxZ ?? EOX_MAX_Z; // 目前來源的最大層級（tilesFor 用）
  let generation = 0; // 每到一張圖磚加一（3D 細節貼圖的 key）
  let visible = true;
  const loader = new TileLoader({
    fetchTile,
    urlOf: tileSource.urlOf,
    now, // 單調時鐘：系統時間往回調不會卡住退避與滑動視窗
    ...(setTimer ? { setTimer } : {}),
    ...(clearTimer ? { clearTimer } : {}),
    cacheSize,
    onEvict: release,
    onChange(kind) {
      if (kind === 'tile') generation++;
      for (const fn of listeners) fn(kind);
    },
  });
  const syncPause = () => loader.suspend(Boolean(doc?.hidden) || !visible);
  const onOnline = () => loader.resetBackoff();
  win?.addEventListener?.('online', onOnline);
  doc?.addEventListener?.('visibilitychange', syncPause);
  syncPause();
  const src = {
    want: (tiles) => loader.want(tiles),
    has: (key) => loader.has(key),
    /** 圖磚（等距圓柱，TILE_PX 見方）或 undefined */
    image: (z, x, y) => loader.get(tileKey(z, x, y))?.img,
    cancel: () => loader.cancel(),
    /** 地圖看得到（沒收起、在畫面內）；看不到時暫停發請求，排隊保留 */
    setVisible(on) {
      visible = Boolean(on);
      syncPause();
    },
    get status() { return loader.status; },
    get generation() { return generation; },
    /** 目前來源的識別（換來源時 3D 全球貼圖、細節貼圖據此重建） */
    get sourceKey() { return sourceKey; },
    /** 目前來源的最大層級（EOX 14、自訂 18） */
    get maxZ() { return maxZ; },
    /** 換來源（add-map-tile-source S5）：key 相同不動回 false；不同就清快取、失敗紀錄與退避，通知 'source'，回 true */
    setTileSource(next) {
      if (!next?.key || typeof next.urlOf !== 'function' || next.key === sourceKey) return false;
      sourceKey = next.key;
      maxZ = next.maxZ ?? EOX_MAX_Z;
      loader.reset(next.urlOf);
      generation++;
      for (const fn of listeners) fn('source');
      return true;
    },
    stats: () => loader.stats(),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      win?.removeEventListener?.('online', onOnline);
      doc?.removeEventListener?.('visibilitychange', syncPause);
      listeners.clear();
      loader.destroy();
      if (source === src) source = null;
    },
  };
  return src;
}

export function eoxSource() {
  if (source) return source;
  const g = globalThis;
  source = createEoxSource({
    fetch: (...a) => g.fetch(...a),
    createImageBitmap: (b) => g.createImageBitmap(b),
    createCanvas: () => g.document.createElement('canvas'),
    cacheSize: cacheSizeFor({ phone: Boolean(g.matchMedia?.('(max-width: 599px)').matches), deviceMemory: g.navigator?.deviceMemory }),
    win: g.window ?? null,
    doc: g.document ?? null,
    ...(wantedSource ? { tileSource: wantedSource } : {}),
  });
  return source;
}
