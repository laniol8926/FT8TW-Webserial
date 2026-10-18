// 底圖影像、國界、國名素材的載入快取（add-map-settings-globe D6）：2D 與 3D 共用，第一次用到才下載，失敗回 null／空陣列。
// 只有瀏覽器用（Image、fetch）；解析邏輯在 countrylayer.mjs（有單元測試）。
import { parseBorders, parseCountries } from './countrylayer.mjs';
import { parseStates, parseZones } from './overlays.mjs';
import { DETAIL_FILES, parseDetailLines, parseLand } from './detail.mjs';

const ASSETS = new URL('../../assets/map/', import.meta.url);
export const BASEMAP_URLS = Object.freeze({
  satellite: new URL('bluemarble-4096.jpg', ASSETS).href,
  relief: new URL('relief-4096.jpg', ASSETS).href,
});

const cache = new Map();
const once = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

// type：'satellite' | 'relief'；回 HTMLImageElement（已 decode）或 null
export function loadBasemap(type) {
  const url = BASEMAP_URLS[type];
  if (!url) return Promise.resolve(null);
  return once(`img:${type}`, () => new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => {
      cache.delete(`img:${type}`); // 網路壞了下次再試
      resolve(null);
    };
    img.src = url;
  }));
}

// 影像最上、最下一條的平均色（2D 視野超出南北極時填這個色，不留一大片海洋色；手機直向看全世界時很明顯）
const edges = new WeakMap();
export function edgeColors(img) {
  if (edges.has(img)) return edges.get(img);
  let out = null;
  try {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 2;
    const g = c.getContext('2d', { willReadFrequently: true });
    const strip = Math.max(1, Math.round(img.naturalHeight / 128));
    g.drawImage(img, 0, 0, img.naturalWidth, strip, 0, 0, 1, 1);
    g.drawImage(img, 0, img.naturalHeight - strip, img.naturalWidth, strip, 0, 1, 1, 1);
    const d = g.getImageData(0, 0, 1, 2).data;
    out = { top: `rgb(${d[0]} ${d[1]} ${d[2]})`, bottom: `rgb(${d[4]} ${d[5]} ${d[6]})` };
  } catch {
    // 讀不到像素（理論上同源不會）：照舊用海洋色
  }
  edges.set(img, out);
  return out;
}

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

export function loadBorders() {
  return once('borders', () => json(new URL('borders.json', ASSETS)).then(parseBorders, () => {
    cache.delete('borders');
    return [];
  }));
}

export function loadCountries() {
  return once('countries', () => json(new URL('countries.json', ASSETS)).then(parseCountries, () => {
    cache.delete('countries');
    return [];
  }));
}

// 圖層（add-map-overlays）：第一次打開開關才下載；失敗回空、下次再試
const ZONE_FILES = Object.freeze({ cqZones: ['cqzones.json', 40], ituZones: ['ituzones.json', 90] });
const EMPTY = Object.freeze({ lines: [], labels: [] });
/** layer：'cqZones' | 'ituZones' → { lines, labels } */
export function loadZones(layer) {
  const [file, maxNumber] = ZONE_FILES[layer] ?? [];
  if (!file) return Promise.resolve(EMPTY);
  return once(layer, () => json(new URL(file, ASSETS)).then((j) => parseZones(j, { maxNumber }), () => {
    cache.delete(layer);
    return EMPTY;
  }));
}
export function loadStates() {
  return once('states', () => json(new URL('admin1.json', ASSETS)).then(parseStates, () => {
    cache.delete('states');
    return [];
  }));
}

// 放大後的向量圖（add-map-overlays D14）：tier '50m'／'10m'，kind 'land'｜'borders'｜'states'；放大到該級才下載，失敗回空、下次再試。
// 1:50m 的州界就是 admin1.json（loadStates）
/** → land：{ tile, rings }；borders／states：[{ pts, w, s, e, n }] */
export function loadDetail(tier, kind) {
  const file = DETAIL_FILES[tier]?.[kind];
  const empty = kind === 'land' ? { tile: 0, rings: [] } : [];
  if (kind === 'states' && tier === '50m') return loadStates();
  if (!file) return Promise.resolve(empty);
  const key = `detail:${tier}:${kind}`;
  return once(key, () => json(new URL(file, ASSETS)).then((j) => (kind === 'land' ? parseLand(j) : parseDetailLines(j)), () => {
    cache.delete(key);
    return empty;
  }));
}

// 深色主題（同 app.css：data-theme 優先，否則跟系統）
export function isDarkTheme(doc = document) {
  const t = doc.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches));
}
