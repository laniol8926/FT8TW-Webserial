// 國別資料庫：把 cty.dat、country_en2hk.dat、dxcc_list.json 組成一個查詢物件（design D15、W5）。
// createCountryDb 是純函式（單元測試直接餵檔案內容）；loadCountryDb 在第一次需要時 fetch 三個檔，
// 只載一次（之後回同一個 Promise），失敗時下次再試。三個檔約 1 MB，Cloudflare Pages 會壓縮與快取。
import { lookupCall, parseCty } from './cty.mjs';
import { localizeCountry, parseCountryNames } from './names.mjs';
import { countryCode, flagEmoji, flagUrl, parseDxccList } from './flag.mjs';
import { locale } from '../i18n/index.mjs';

// 依目前語系取國名（使用者 2026-10-07）：英文用 cty.dat 的原名（太長也不自己縮寫），繁中用 nameZh；
// 卡片、電台卡、右鍵選單共用。缺一邊時退回另一邊；info 是 null（查不到）回空字串
export function countryName(info, loc = locale) {
  if (!info) return '';
  return (loc === 'zh-TW' ? info.nameZh || info.nameEn : info.nameEn || info.nameZh) ?? '';
}

export function createCountryDb({ ctyText, namesText = '', dxccJson = null }) {
  const cty = parseCty(ctyText);
  const names = parseCountryNames(namesText);
  const dxcc = parseDxccList(dxccJson);
  const cache = new Map();
  return {
    size: cty.entities.length,
    // { nameEn, nameZh, cq, itu, continent, lat, lon（東經為正）, dxcc, cc, flag（emoji）, flagUrl（圖檔）, zoneOverride } 或 null
    lookup(callsign) {
      const key = String(callsign ?? '').toUpperCase();
      if (cache.has(key)) return cache.get(key);
      const hit = lookupCall(cty, key);
      let info = null;
      if (hit) {
        const nameZh = localizeCountry(names, hit.nameEn);
        const cc = countryCode(dxcc, hit.dxcc, hit.nameEn, nameZh);
        info = { ...hit, nameZh, cc, flag: flagEmoji(cc), flagUrl: flagUrl(cc) };
      }
      if (cache.size > 5000) cache.clear();
      cache.set(key, info);
      return info;
    },
  };
}

let pending = null;

// fetchFn：瀏覽器的 fetch；base：資料目錄的 URL
export function loadCountryDb({ fetchFn = globalThis.fetch, base }) {
  pending ??= (async () => {
    const get = async (name) => {
      const res = await fetchFn(new URL(name, base));
      if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
      return res;
    };
    const [cty, names, dxcc] = await Promise.all([get('cty.dat'), get('country_en2hk.dat'), get('dxcc_list.json')]);
    return createCountryDb({ ctyText: await cty.text(), namesText: await names.text(), dxccJson: await dxcc.json() });
  })().catch((err) => {
    pending = null; // 下次再試
    throw err;
  });
  return pending;
}
