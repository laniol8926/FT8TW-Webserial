// 線上地圖來源（add-map-tile-source S1～S4）：內建 EOX Sentinel-2 cloudless 2025／2024，或使用者自訂的 XYZ 圖磚網址樣板（只存一組）。
// 純函式，有單元測試；設定存在 ft8tw.config（config/model.mjs 的 mapTileSource、mapTileUrl、mapTileAttribution），
// 由 panel 交給 eoxsource.mjs（換來源時清快取）。自訂只支援 Web Mercator（EPSG:3857）XYZ、256 px 圖磚。層級上限：EOX 14、自訂 18（使用者 2026-10-09 放寬）。
import { EOX_ATTRIBUTION, EOX_LAYER_2025, EOX_MAX_Z, eoxTileUrl, isTileInt } from './tiles.mjs';

export const TILE_SOURCE_IDS = Object.freeze(['eox2025', 'eox2024', 'custom']);
export const DEFAULT_TILE_SOURCE = 'eox2025';
export const TEMPLATE_MAX = 512;
export const ATTRIBUTION_MAX = 200;
export const CUSTOM_MAX_Z = 18; // 自訂來源的最大層級（使用者 2026-10-09 放寬；EOX 是 EOX_MAX_Z＝14）

// 內建來源：EOX 圖層與標示年份（授權都是 CC BY-NC-SA 4.0，https://cloudless.eox.at/documentation/license）
export const EOX_LAYERS = Object.freeze({
  eox2025: Object.freeze({ layer: EOX_LAYER_2025, year: 2025 }),
  eox2024: Object.freeze({ layer: 's2cloudless-2024_3857', year: 2024 }),
});

/** EOX 規定的標示（年份對應圖層）：{ before, href, after, text } */
export function eoxAttribution(year) {
  const after = ` by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${year})`;
  return { before: EOX_ATTRIBUTION.before, href: EOX_ATTRIBUTION.href, after, text: `${EOX_ATTRIBUTION.before}${EOX_ATTRIBUTION.href}${after}` };
}

// 空白（含全形空白）與控制字元一律不收
const SPACE_OR_CONTROL = /[\s\x00-\x1f\x7f-\x9f]/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const PLACEHOLDERS = ['{z}', '{x}', '{y}'];

/**
 * 網址樣板驗證 → null（合法）或錯誤代碼：'empty'｜'long'｜'space'｜'https'｜'placeholder'｜'host'。
 * https 開頭；{z}{x}{y} 各恰好一次、不可有其他大括號；主機不可有佔位、不可帶帳密
 */
export function validateTileTemplate(s) {
  if (typeof s !== 'string' || s === '') return 'empty';
  if (s.length > TEMPLATE_MAX) return 'long';
  if (SPACE_OR_CONTROL.test(s)) return 'space';
  if (!/^https:\/\//i.test(s)) return 'https';
  let rest = s;
  for (const p of PLACEHOLDERS) {
    if (rest.split(p).length !== 2) return 'placeholder';
    rest = rest.replace(p, '');
  }
  if (/[{}]/.test(rest)) return 'placeholder';
  const authority = s.slice('https://'.length).split(/[/?#]/)[0];
  if (!authority || /[{}@]/.test(authority)) return 'host';
  let url;
  try {
    url = new URL(PLACEHOLDERS.reduce((u, p) => u.replace(p, '0'), s));
  } catch {
    return 'host';
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return 'host';
  return null;
}

/** 出處標示驗證 → null 或 'long'｜'control'（可留空；前後空白不算） */
export function validateTileAttribution(s) {
  if (typeof s !== 'string' || CONTROL.test(s)) return 'control';
  return s.trim().length > ATTRIBUTION_MAX ? 'long' : null;
}

/** 樣板 → (z, x, y) => 網址｜null（z 0～CUSTOM_MAX_Z、x／y 0～2^z−1 的整數才組）；樣板不合法回 null */
export function templateUrlOf(template) {
  if (validateTileTemplate(template) !== null) return null;
  return (z, x, y) => {
    if (!isTileInt(z, 0, CUSTOM_MAX_Z)) return null;
    const n = 2 ** z;
    if (!isTileInt(x, 0, n - 1) || !isTileInt(y, 0, n - 1)) return null;
    return template.split('{z}').join(String(z)).split('{x}').join(String(x)).split('{y}').join(String(y));
  };
}

/**
 * 設定 → 目前的來源 { id, key, urlOf, attribution, custom, maxZ }。
 * attribution：內建 { before, href, after, text }、自訂 { text }（純文字，可能是空字串）。
 * 不認得的來源、選了自訂但網址不合法 → EOX 2025
 */
export function resolveTileSource(config) {
  const c = config && typeof config === 'object' ? config : {};
  if (c.mapTileSource === 'custom') {
    const urlOf = templateUrlOf(c.mapTileUrl);
    if (urlOf) {
      const raw = c.mapTileAttribution;
      const text = typeof raw === 'string' && validateTileAttribution(raw) === null ? raw.trim() : '';
      return { id: 'custom', key: `custom|${c.mapTileUrl}`, urlOf, attribution: { text }, custom: true, maxZ: CUSTOM_MAX_Z };
    }
  }
  const id = Object.hasOwn(EOX_LAYERS, c.mapTileSource) ? c.mapTileSource : DEFAULT_TILE_SOURCE;
  const { layer, year } = EOX_LAYERS[id];
  return { id, key: id, urlOf: (z, x, y) => eoxTileUrl(z, x, y, layer), attribution: eoxAttribution(year), custom: false, maxZ: EOX_MAX_Z };
}
