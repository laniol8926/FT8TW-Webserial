// 國旗：DXCC 前綴／英文國名 → 兩碼國碼（FT8TW DxccCountryCode，資料 dxcc_list.json）→ 系統 emoji（StationFormat.flagEmoji）。
// dxcc_list.json 的國碼不全是 ISO（例：Asiatic Russia 是 RX），那種組合字型畫不出國旗，瀏覽器會顯示兩個字母方塊。

export function parseDxccList(json) {
  const byPrefix = new Map();
  const byAname = new Map();
  const byName = new Map();
  for (const [key, e] of Object.entries(json ?? {})) {
    if (key === '-1' || !e || typeof e !== 'object') continue;
    const cc = String(e.cc ?? '').trim();
    if (!cc) continue;
    const pp = String(e.pp ?? '').trim().toUpperCase();
    const aname = String(e.aname ?? '').trim();
    const name = String(e.name ?? '').trim();
    if (pp) byPrefix.set(pp, cc);
    if (aname) byAname.set(aname, cc);
    if (name) byName.set(name, cc);
  }
  return { byPrefix, byAname, byName };
}

// 先用 DXCC 前綴，再用英文國名、中文國名；查不到回空字串
export function countryCode(index, dxccPrefix, nameEn, nameZh) {
  if (!index) return '';
  const pp = String(dxccPrefix ?? '').trim().toUpperCase();
  const cc = (pp && index.byPrefix.get(pp)) || (nameEn && index.byAname.get(String(nameEn).trim()))
    || (nameZh && index.byName.get(String(nameZh).trim())) || '';
  return cc.trim().toUpperCase();
}

// 兩碼 A–Z 才轉；否則 null
export function flagEmoji(cc) {
  if (cc == null) return null;
  const s = String(cc).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return null;
  return String.fromCodePoint(0x1f1e6 + s.charCodeAt(0) - 65, 0x1f1e6 + s.charCodeAt(1) - 65);
}

// 國旗圖檔（使用者 2026-10-06）：Windows 的瀏覽器畫不出國旗 emoji（只顯示兩個字母），改用 flag-icons 的 SVG（MIT，web/data/flags/）。
// dxcc_list.json 的非 ISO 國碼：RX（亞洲俄羅斯）用俄羅斯、AC（阿森松島）用 sh-ac；AN（荷屬安地列斯，已解散）、IG（ITU 總部）沒有國旗
const FLAG_ALIAS = Object.freeze({ rx: 'ru', ac: 'sh-ac' });
const NO_FLAG = new Set(['an', 'ig']);
export function flagUrl(cc) {
  if (cc == null) return null;
  const s = String(cc).trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(s) || NO_FLAG.has(s)) return null;
  // 相對於本模組（web/js/country/）算出絕對網址：頁面掛在子路徑也找得到
  return new URL(`../../data/flags/${FLAG_ALIAS[s] ?? s}.svg`, import.meta.url).href;
}

// 國旗 <img>（url 由 flagUrl 產生）；alt 預設空白（旁邊已有國名文字）。固定 4:3 的尺寸屬性，載入時版面不跳動
export function flagImg(url, { className = 'flag', alt = '', doc = globalThis.document } = {}) {
  if (!url) return '';
  const img = Object.assign(doc.createElement('img'), { className, src: url, alt, loading: 'lazy', decoding: 'async' });
  img.width = 16;
  img.height = 12;
  return img;
}
