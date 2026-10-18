// 英文國名 → 繁體中文（FT8TW CountryNameLocalizer，來源 country_en2hk.dat：每行「英文:中文」，UTF-8 可能帶 BOM）
import { normalizeEn } from './cty.mjs';

export function parseCountryNames(text) {
  const map = new Map();
  for (const line of String(text).replace(/^﻿/, '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).replace('\r', '').trim();
    if (key && val) map.set(key, val);
  }
  return map;
}

// 查不到回（正規化後的）英文名，至少不空白
export function localizeCountry(map, englishName) {
  const en = englishName == null ? '' : String(englishName).trim();
  return map?.get(en) ?? normalizeEn(en);
}
