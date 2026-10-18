// 呼號 → 國別（add-web-transmit 3.1、design D15）：解析 AD1C Country Files 的 cty.dat，比對規則同 FT8TW
// CallsignDatabase.getCallsignInfo（SQL：`SUBSTR(call,1,LENGTH(prefix))=prefix OR prefix='='||call`，依前綴長度取最長）：
//   1. `=完整呼號` 優先（長度比任何前綴都長一碼，所以 SQL 也是它贏）
//   2. 否則取最長的相符前綴
// 比 FT8TW 多做的兩件事（FT8TW 的 CallsignFileOperation.getCallsigns 把 `(`、`[` 之後砍掉、也不拆 `/`）：
//   - 前綴後面的 `(CQ區)`、`[ITU區]` 覆寫：命中的前綴帶覆寫時改用覆寫值（例 BA0(23)[42]）
//   - 複合呼號 `/`：去掉 /P、/M、/QRP 這類後綴；剩兩段時取較短的一段當前綴（W1ABC/KH6 → 夏威夷，
//     KH6/W1ABC 同），單一數字後綴（W1ABC/4）不改區域。FT8TW 對 W1ABC/KH6 會回美國。
// 經度：cty.dat 西經為正，回傳前乘 -1 變成「東經為正」（同 CallsignDatabase.getMessagesLocation），
// 與 Maidenhead 換算同一套，可以直接算距離。純函式，不碰 fetch（載入在 loader.mjs）。

const SUFFIX = new Set(['P', 'M', 'MM', 'AM', 'QRP', 'QRPP', 'R', 'A', 'B', 'LH', 'J', 'T', 'X', 'LGT', 'SAT']);

// 英文國名修飾（CountryNameLocalizer.normalizeEn）：DXCC 實體名「Taiwan China」統一為「Taiwan」
export function normalizeEn(name) {
  if (name == null) return '';
  const n = String(name).trim();
  return n.toLowerCase() === 'taiwan china' ? 'Taiwan' : n;
}

// 一個前綴 token：=完整呼號、前綴，可帶 (cq)[itu]（其餘 <…>{…}~…~ 這份檔沒有用到，一併剝掉）
function parseToken(raw) {
  const t = raw.trim();
  if (!t) return null;
  const cq = t.match(/\((\d+)\)/);
  const itu = t.match(/\[(\d+)\]/);
  const body = t.replace(/\(.*?\)|\[.*?\]|<.*?>|\{.*?\}|~.*?~/g, '').trim();
  if (!body) return null;
  const exact = body.startsWith('=');
  return { key: exact ? body.slice(1) : body, exact, cq: cq ? Number(cq[1]) : null, itu: itu ? Number(itu[1]) : null };
}

// 回傳 { entities, prefixes: Map, exact: Map }；同一前綴出現在兩個實體時保留先出現的
export function parseCty(text) {
  const entities = [];
  const prefixes = new Map();
  const exact = new Map();
  for (const record of String(text).split(';')) {
    if (!record.includes(':')) continue;
    const f = record.split(':');
    if (f.length < 9) continue;
    const entity = {
      nameEn: normalizeEn(f[0].replace(/\s+/g, ' ')),
      cq: Number.parseInt(f[1], 10),
      itu: Number.parseInt(f[2], 10),
      continent: f[3].trim(),
      lat: Number.parseFloat(f[4]),
      lon: -Number.parseFloat(f[5]), // 西經為正 → 東經為正
      gmtOffset: Number.parseFloat(f[6]),
      dxcc: f[7].trim(),
    };
    entities.push(entity);
    for (const raw of f.slice(8).join(':').split(',')) {
      const tok = parseToken(raw);
      if (!tok) continue;
      const map = tok.exact ? exact : prefixes;
      if (!map.has(tok.key)) map.set(tok.key, { entity, cq: tok.cq, itu: tok.itu });
    }
  }
  return { entities, prefixes, exact };
}

function result(hit) {
  const e = hit.entity;
  return { ...e, cq: hit.cq ?? e.cq, itu: hit.itu ?? e.itu, zoneOverride: hit.cq !== null || hit.itu !== null };
}

function longestPrefix(db, s) {
  for (let i = s.length; i > 0; i--) {
    const hit = db.prefixes.get(s.slice(0, i));
    if (hit) return hit;
  }
  return null;
}

// 複合呼號要拿來比對的那一段；沒有 / 時就是呼號本身
export function prefixPart(call) {
  if (!call.includes('/')) return call;
  const parts = call.split('/').filter((p) => p && !SUFFIX.has(p) && !/^\d$/.test(p));
  if (parts.length === 0) return call.split('/')[0];
  if (parts.length === 1) return parts[0];
  const [a, b] = parts;
  return b.length < a.length ? b : a;
}

// 查不到（或不是呼號）回 null
export function lookupCall(db, callsign) {
  if (!db || callsign == null) return null;
  const call = String(callsign).replaceAll('<', '').replaceAll('>', '').trim().toUpperCase();
  if (!call || call.includes('...')) return null;
  const ex = db.exact.get(call);
  if (ex) return result(ex);
  const hit = longestPrefix(db, prefixPart(call));
  return hit ? result(hit) : null;
}
