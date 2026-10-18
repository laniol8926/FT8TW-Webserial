// 地圖設定（add-map-settings-globe D1、add-map-overlays D1）：地圖種類、國界、國名、日夜分界、2D／3D、四個圖層。存 localStorage ft8tw.mapSettings，
// 讀取時逐欄驗證，壞欄回預設；localStorage 不可用（無痕、被擋）時用預設、不丟例外。純函式，有單元測試。
export const MAP_SETTINGS_KEY = 'ft8tw.mapSettings';
// 簡圖、衛星影像（Blue Marble）、地形淡色（Natural Earth）、衛星影像（EOX Sentinel-2 線上圖磚，add-map-eox-imagery；使用者自己選才連外）
export const MAP_TYPES = Object.freeze(['outline', 'satellite', 'relief', 'eox']);
export const MAP_VIEWS = Object.freeze(['2d', '3d']);
// 圖層開關（add-map-overlays D1）：Maidenhead Grid、CQ Zone、ITU Zone、州界（一級行政區界線）
export const OVERLAY_KEYS = Object.freeze(['grid', 'cqZones', 'ituZones', 'states']);
// 預設與改版前的畫面相同（舊版存的設定缺這四欄 → 關）
export const DEFAULT_MAP_SETTINGS = Object.freeze({
  type: 'outline', borders: false, names: false, daynight: false, view: '2d', grid: false, cqZones: false, ituZones: false, states: false,
});

export function normalizeMapSettings(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = DEFAULT_MAP_SETTINGS;
  return {
    type: MAP_TYPES.includes(o.type) ? o.type : d.type,
    borders: typeof o.borders === 'boolean' ? o.borders : d.borders,
    names: typeof o.names === 'boolean' ? o.names : d.names,
    daynight: typeof o.daynight === 'boolean' ? o.daynight : d.daynight,
    view: MAP_VIEWS.includes(o.view) ? o.view : d.view,
    ...Object.fromEntries(OVERLAY_KEYS.map((k) => [k, typeof o[k] === 'boolean' ? o[k] : d[k]])),
  };
}

export function loadMapSettings(storage) {
  try {
    const text = storage?.getItem(MAP_SETTINGS_KEY);
    return normalizeMapSettings(text ? JSON.parse(text) : null);
  } catch {
    return { ...DEFAULT_MAP_SETTINGS };
  }
}

// 回傳是否存成功（失敗只是下次不記得）
export function saveMapSettings(storage, settings) {
  try {
    if (!storage) return false;
    storage.setItem(MAP_SETTINGS_KEY, JSON.stringify({ v: 1, ...normalizeMapSettings(settings) }));
    return true;
  } catch {
    return false;
  }
}
