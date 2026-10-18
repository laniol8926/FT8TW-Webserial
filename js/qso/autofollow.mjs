// 自動回應 CQ（autoFollowCQ）的挑選對象與評分（qso-automation spec「自動回應 CQ」、design D12）。
// 移植自 FT8TW FT8TransmitSignal.parseMessagesLegacy() 的「找最佳呼號」迴圈、第二階段（callFromCQME）
// 與 setScoreWeight()；GeneralVariables 的 checkFun1–5、checkIsMyCallsign、isAlreadyWorked、
// 失敗清單放行、候選清單；MaidenheadGrid.gridToLatLng／getDist。
// 黃金向量：tools/qsogolden-follow/（javac 跑 FT8TW 原碼）→ webtest/fixtures/qso-autofollow-golden.json。
//
// 純函式：只看「同一個 slot 的解碼」與傳進來的狀態，不改任何輸入；
// 要改的狀態（失敗清單放行、叫我的人移出失敗清單）放在回傳值裡，由呼叫端套用。
//
// 優先序怎麼來的（不是三段 if，是 FT8TW 的兩階段機制自然形成）：
//   第一階段：逐則評分，取最高分（> 0 才算）。叫我＝1300×步驟號；CQ SOTA/POTA 加 500；關注呼號加 1300。
//   第二階段：最高分那則的「下一步」≤ 2（他在 CQ，或只回了我網格）而候選清單非空 → 改從候選清單挑
//            步驟號最大的。候選清單＝本 slot 叫我的人（步驟 1–3）＋ CQ SOTA/POTA（步驟 0）。
//   所以：有人叫我 > CQ SOTA/POTA > 評分。例：遠距方案下 10000 km 的 CQ 有 2000 分，比叫我的 1300 高，
//   但它的下一步是 1，於是仍交給叫我的人。
//
// 與 FT8TW 不同之處：
//   - 候選清單在 FT8TW 跨 slot 保存 15 分鐘；這裡只看本 slot（跨 slot 記憶屬於 sequencer）。
//   - 寄件人是自己、未解開的雜湊 <...>、不合格式（自由文字等）一律不列入（FT8TW 會把 <...> 當成 "..." 叫）。
//   - 追蹤（trackOnly、換公園例外，T7）、野外日交換、跟頻不在範圍內。
import { isValidCallsign } from '../settings.mjs';
import { t } from '../i18n/index.mjs';

/** 方案 0–6 的名稱（FT8TW cq_order_opt_str_array 繁中） */
export const SCHEME_LABELS = Object.freeze([
  t('qso.scheme0'),
  t('qso.scheme1'),
  t('qso.scheme2'),
  t('qso.scheme3'),
  t('qso.scheme4'),
  t('qso.scheme5'),
  t('qso.scheme6'),
]);

export const WEIGHT_CALLING_ME = 1300;
export const WEIGHT_FOLLOW_CALLSIGN = 1300;
export const WEIGHT_IS_CQ = 1.5;
export const WEIGHT_OTA = 500;
export const FAIL_CALLSIGN_DWELL_MS = 5 * 60 * 1000;
export const QSO_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_RELEASE_LOOPS = 10;
const CANDIDATE_MAX = 200;
const EARTH_RADIUS = 6371393; // m，同 MaidenheadGrid

/**
 * 方案的權重。FT8TW 只在建構時呼叫 setScoreWeight()，所以是「預設值＋該方案覆寫」，不會殘留上一個方案。
 * 距離的單位是「千公里（整數）」：原碼 (int) getDist(km) / 1000 是整數除法。
 */
export function schemeWeights(scheme) {
  const w = { cqZone: 20, ituZone: 20, dxccZone: 20, dist: 1, snr: 1 };
  switch (scheme) {
    case 1: w.dist = 200; break;
    case 2: w.dist = -200; break;
    case 3: w.cqZone = 201; w.ituZone = 201; w.dxccZone = 201; break;
    case 4: w.cqZone = 1; w.ituZone = 201; w.dxccZone = 1; break;
    case 5: w.cqZone = 201; w.ituZone = 1; w.dxccZone = 1; break;
    case 6: w.cqZone = 1; w.ituZone = 1; w.dxccZone = 201; break;
    default: w.snr = 20; break; // 0 ASAP（含未知值，同 Java switch default）
  }
  return w;
}

// ---------------- 訊息解析（對應原生解碼器填的 Ft8Message 欄位） ----------------

const CQ_WORDS = new Set(['CQ', 'DE', 'QRZ']);
const CQ_MODIFIER = /^(?:[A-Z]{1,4}|[0-9]{3})$/;
const OTA = /^CQ\s+(SOTA|POTA|OTA)\b/i;
const strip = (s) => s.replace(/[<>]/g, '');

/**
 * 解碼文字 → { toRaw, to, from, fromRaw, extra, isCq, otaKind }；少於兩個字回 null。
 * to／from 同 Ft8Message.getCallsignTo／getCallsignFrom：去角括號，CQ/DE/QRZ 開頭的收訊方回 ''。
 */
export function parseCandidate(text) {
  const t = String(text).trim().split(/\s+/).filter(Boolean);
  if (t.length < 2) return null;
  let toRaw = t[0];
  let idx = 1;
  if (CQ_WORDS.has(t[0]) && t.length >= 3 && CQ_MODIFIER.test(t[1])) {
    toRaw = `${t[0]} ${t[1]}`;
    idx = 2;
  }
  const fromRaw = t[idx];
  const extra = t.slice(idx + 1).join(' ');
  const ota = OTA.exec(toRaw.trim());
  return {
    toRaw,
    to: callsignTo(toRaw),
    fromRaw,
    from: strip(fromRaw),
    extra,
    isCq: CQ_WORDS.has(toRaw.trim().split(' ')[0]),
    otaKind: ota ? ota[1].toUpperCase() : null,
  };
}

function callsignTo(raw) {
  if (raw.length < 2) return '';
  if (raw.startsWith('CQ') || raw.startsWith('DE') || raw.startsWith('QRZ')) return '';
  return strip(raw);
}

// ---------------- 步驟判斷（GeneralVariables.checkFun1–5） ----------------

// Java Integer.parseInt：可帶正負號的十進位整數，其他都是 NumberFormatException
function parseJavaInt(s) {
  return /^[+-]?\d+$/.test(s) ? Number(s) : NaN;
}
const isReport = (n) => (n >= -99 && n <= -1) || (n >= 0 && n <= 72);

const fun1 = (e) => (/^[A-Z][A-Z][0-9][0-9]$/.test(e.trim()) && e !== 'RR73') || e.trim().length === 0;
const fun2 = (e) => e.trim().length >= 2 && isReport(parseJavaInt(e.trim()));
function fun3(e) {
  if (/^R ([A-R][A-R][0-9][0-9])$/.test(e.trim())) return true; // GridExchange.isRGrid
  const s = e.trim();
  if (s.length < 2) return false;
  if (!(s[0] === 'R' || s[1] === 'R')) return false;
  return isReport(parseJavaInt(s.replace('R', '').trim()));
}
const fun4 = (e) => e.trim() === 'RR73' || e.trim() === 'RRR';
const fun5 = (e) => e.trim() === '73';

/** 訊息的序列步驟：CQ＝6、73＝5、RR73/RRR＝4、R 報告＝3、報告＝2、網格或空＝1、其他 -1 */
export function funOrder(p) {
  if (p.isCq) return 6;
  if (fun5(p.extra)) return 5;
  if (fun4(p.extra)) return 4;
  if (fun3(p.extra)) return 3;
  if (fun2(p.extra)) return 2;
  if (fun1(p.extra)) return 1;
  return -1;
}

/** GeneralVariables.checkIsMyCallsign：完全相同、BV6LC/P、HB9/BV6LC 都算 */
export function isMyCallsign(myCall, call) {
  if (!myCall || !call || call.trim().length === 0) return false;
  const my = myCall.trim().toUpperCase();
  const c = call.trim().toUpperCase();
  return c === my || c.startsWith(`${my}/`) || c.endsWith(`/${my}`);
}

// ---------------- 距離（MaidenheadGrid） ----------------

const isAlpha = (ch) => /\p{L}/u.test(ch);
const isDigit = (ch) => /\p{Nd}/u.test(ch);

/** MaidenheadGrid.checkMaidenhead：4 或 6 字、字母字母數字數字、不是 RR73 */
export function looksLikeGrid(s) {
  if (typeof s !== 'string' || (s.length !== 4 && s.length !== 6)) return false;
  if (s === 'RR73') return false;
  return isAlpha(s[0]) && isAlpha(s[1]) && isDigit(s[2]) && isDigit(s[3]);
}

/** MaidenheadGrid.gridToLatLng：最細一級的中心點，緯度夾在 ±85；格式不對回 null */
export function gridToLatLon(grid) {
  if (grid == null) return null;
  const g = String(grid).trim().toUpperCase();
  if (![2, 4, 6, 8, 10].includes(g.length) || g === 'RR73' || g === 'RR') return null;
  let lon = -180;
  let lat = -90;
  let lonSize = 360;
  let latSize = 180;
  for (let k = 0; k < g.length / 2; k++) {
    const base = k === 0 ? 18 : k % 2 === 1 ? 10 : 24;
    lonSize /= base;
    latSize /= base;
    const zero = base === 10 ? 48 : 65; // '0' 或 'A'
    lon += (g.charCodeAt(2 * k) - zero) * lonSize;
    lat += (g.charCodeAt(2 * k + 1) - zero) * latSize;
  }
  lon += lonSize / 2;
  lat += latSize / 2;
  return { lat: Math.max(-85, Math.min(85, lat)), lon };
}

/** MaidenheadGrid.getDist(grid, grid)：球面餘弦，km；任一格式不對回 0 */
export function gridDistanceKm(g1, g2) {
  const a = gridToLatLon(g1);
  const b = gridToLatLon(g2);
  if (!a || !b) return 0;
  const rad = Math.PI / 180;
  const cos = Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((a.lon - b.lon) * rad)
    + Math.sin(a.lat * rad) * Math.sin(b.lat * rad);
  return (EARTH_RADIUS * Math.acos(cos)) / 1000;
}

// Java 的 (int) 轉型：NaN→0、截斷、夾在 int 範圍
function javaInt(x) {
  if (Number.isNaN(x)) return 0;
  return Math.max(-2147483648, Math.min(2147483647, Math.trunc(x)));
}

// ---------------- 主程式 ----------------

const toSet = (it) => new Set(it ?? []);
function toMap(it) {
  if (it instanceof Map) return new Map(it);
  if (Array.isArray(it)) return new Map(it);
  return new Map(Object.entries(it ?? {}));
}

/**
 * 從同一個 slot 的解碼挑出下一個要叫的對象。
 *
 * @param {Array<{text:string, snr:number, freqHz?:number, timeSec?:number, slotUtc?:number}>} candidates
 * @param {object} o
 * @param {string} o.myCall
 * @param {string} [o.myGrid]          只取前 4 碼（同 getMyGrid）
 * @param {number} [o.scheme=0]        評分方案 0–6
 * @param {Iterable<string>} [o.watchList]  關注呼號
 * @param {Map|Array|object} [o.failed]     失敗清單：呼號→入列時間 ms（順序＝入列順序）
 * @param {Iterable<string>} [o.worked]     已通聯呼號（呼叫端已依 Exclude QSOs 的時間範圍、波段、模式篩好）
 * @param {boolean} [o.qsoFilterOff=false]  Exclude QSOs 設成 Off：不排除已通聯，冷卻也停用
 * @param {Map|Array|object} [o.cooldown]   剛完成 QSO 的呼號→完成時間 ms（本波段，10 分鐘冷卻）
 * @param {{dxcc?:Iterable<string>, cq?:Iterable<number>, itu?:Iterable<number>}} [o.workedZones] 已通聯的分區
 * @param {Iterable<string>} [o.excludePrefixes] 忽略的呼號字首
 * @param {boolean} [o.autoFollow=true]  關閉時只回應叫我的人（同 FT8TW 開關關閉）
 * @param {number} o.now                 ms
 * @param {(call:string)=>({dxcc?:string, cqZone?:number, ituZone?:number, grid?:string, lat?:number, lon?:number}|null)} [o.lookup]
 *   呼號查詢（cty.dat 分區＋呼號→網格表）。分區加分要靠它；訊息沒帶網格時用它的 grid 算距離。lat/lon 不用（FT8TW 也不用）。
 * @returns {null | {target:string|null, reason:'calling-me'|'ota'|'watch'|'score'|null, score:number|null,
 *   nextOrder:number, candidate:object|null, released:string[], unfailed:string[], cooldownRetry:string|null}}
 *   target 為 null 但仍回物件＝沒有對象，但失敗清單有變動或有冷卻中的對象在等我補 RR73。
 */
export function pickTarget(candidates, o) {
  const myCall = o.myCall ?? '';
  if (myCall.length < 3) return null;
  const myGrid = o.myGrid && o.myGrid.length > 4 ? o.myGrid.slice(0, 4) : (o.myGrid ?? '');
  const w = schemeWeights(o.scheme ?? 0);
  const watch = toSet(o.watchList);
  const worked = toSet(o.worked);
  const failed = toMap(o.failed);
  const cooldown = new Map([...toMap(o.cooldown)].map(([k, v]) => [k.toUpperCase(), v]));
  const zones = { dxcc: toSet(o.workedZones?.dxcc), cq: toSet(o.workedZones?.cq), itu: toSet(o.workedZones?.itu) };
  const excludes = [...toSet(o.excludePrefixes)];
  const filterOff = o.qsoFilterOff === true;
  const autoFollow = o.autoFollow !== false;
  const now = o.now;
  const lookup = typeof o.lookup === 'function' ? o.lookup : () => null;
  const isMe = (c) => isMyCallsign(myCall, c);

  const inCooldown = (c) => {
    const done = cooldown.get(c.toUpperCase());
    return done !== undefined && now - done <= QSO_COOLDOWN_MS;
  };
  const alreadyWorked = (c) => !filterOff && (worked.has(c) || inCooldown(c));

  // 解析＋與 slot 狀態無關的屬性
  const msgs = [];
  for (const cand of candidates ?? []) {
    const p = parseCandidate(cand.text);
    if (!p || p.fromRaw === '<...>' || !isValidCallsign(p.from) || isMe(p.from)) continue;
    const info = lookup(p.from) ?? null;
    const lastToken = String(cand.text).trim().split(' ').pop();
    const grid = looksLikeGrid(lastToken) ? lastToken : (info?.grid ?? '');
    msgs.push({
      cand,
      p,
      snr: javaInt(Number(cand.snr)),
      grid,
      isQsl: worked.has(p.from),
      newCq: info != null && !zones.cq.has(info.cqZone),
      newItu: info != null && !zones.itu.has(info.ituZone),
      newDxcc: info != null && !zones.dxcc.has(info.dxcc),
    });
  }

  const cqme = []; // 候選清單：{ call, order, m }
  const addCandidate = (m, order) => {
    if (cqme.length >= CANDIDATE_MAX) cqme.shift();
    if (order >= 4) return;
    const old = cqme.find((c) => c.call === m.p.from);
    if (!old) cqme.push({ call: m.p.from, order, m });
    else if (order > old.order) Object.assign(old, { order, m });
  };
  const scores = new Map();
  const released = [];
  const unfailed = [];
  let cooldownRetry = null;
  let best = null;
  let bestOrder = 0;
  let highest = 0;

  for (let loops = 0; ; ) {
    highest = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const { p } = m;
      let order = funOrder(p);
      if (order >= 6) order = 0;
      if (!isMe(p.to)) order = 0; // 非指名給我：一律從第 1 步開始叫，不接別人的序列
      const toMeNotDone = isMe(p.to) && !fun4(p.extra) && !fun5(p.extra);

      if (failed.has(p.from) && !toMeNotDone) continue;
      if (excludes.some((k) => p.from.toUpperCase().startsWith(k))) continue;
      if (alreadyWorked(p.from)) {
        // 對方送第 3 步＝在等我的收尾：記下來讓呼叫端補一次 RR73，但不列入候選
        if (toMeNotDone && myCall !== p.from && fun3(p.extra)) cooldownRetry = p.from;
        continue;
      }

      let scored = false;
      let score = 0;
      m.watched = false;
      if (watch.has(p.from) && !m.isQsl) {
        score += WEIGHT_FOLLOW_CALLSIGN;
        scored = true;
        m.watched = true;
      }
      if (toMeNotDone && myCall !== p.from) {
        score += WEIGHT_CALLING_ME * order;
        scored = true;
        addCandidate(m, order);
        if (failed.delete(p.from)) unfailed.push(p.from);
      }
      const workedBefore = m.isQsl && !filterOff;
      if (p.to === '' && workedBefore) scored = true;
      if (p.to === '' && !workedBefore) {
        score += WEIGHT_IS_CQ;
        scored = true;
        if (p.otaKind) {
          score += WEIGHT_OTA;
          if (autoFollow) addCandidate(m, order);
        }
        if (m.newCq) score += w.cqZone;
        if (m.newItu) score += w.ituZone;
        if (m.newDxcc) score += w.dxccZone;
        const dist = Math.trunc(javaInt(gridDistanceKm(m.grid, myGrid)) / 1000);
        score += dist * w.dist;
        score += (m.snr + 30) * w.snr;
      }
      scores.set(m, score);
      if (scored && autoFollow && score > 0 && score > highest) {
        highest = score;
        best = m;
        bestOrder = order;
      }
    }

    if (best || failed.size === 0) break;
    // 找不到對象：放行失敗清單裡待最久、且已待滿 5 分鐘的那一個，重算
    const r = releaseOldest(failed, now);
    if (r === null) break;
    released.push(r);
    if (++loops > MAX_RELEASE_LOOPS) break;
  }

  const result = (m, nextOrder, score, path) => ({
    target: m.p.from,
    reason: reasonOf(m, path, isMe),
    score,
    nextOrder,
    candidate: m.cand,
    released,
    unfailed,
    cooldownRetry,
  });
  const fromCandidates = () => {
    // 候選清單挑步驟號最大的；同號取最後加入的（原碼 >=）
    while (cqme.length > 0) {
      let k = 0;
      for (let i = 1; i < cqme.length; i++) if (cqme[i].order >= cqme[k].order) k = i;
      const [c] = cqme.splice(k, 1);
      if (alreadyWorked(c.call)) continue;
      return result(c.m, wrapOrder(c.order + 1), scores.get(c.m) ?? null, 'cqme');
    }
    return null;
  };

  let picked = null;
  if (best) {
    const next = bestOrder + 1 === 0 ? 1 : bestOrder + 1;
    picked = next <= 2 && cqme.length > 0 ? fromCandidates() : result(best, wrapOrder(bestOrder + 1), highest, 'best');
  } else if (cqme.length > 0) {
    picked = fromCandidates();
  }
  if (picked) return picked;
  if (released.length || unfailed.length || cooldownRetry) {
    return { target: null, reason: null, score: null, nextOrder: 0, candidate: null, released, unfailed, cooldownRetry };
  }
  return null;
}

const wrapOrder = (n) => (n >= 6 ? 1 : n);

function reasonOf(m, path, isMe) {
  if (isMe(m.p.to)) return 'calling-me';
  if (path === 'cqme' || (m.p.otaKind && !m.watched)) return 'ota';
  return m.watched ? 'watch' : 'score';
}

// GeneralVariables.releaseOldestFailCallSign：最早入列（同時戳取先入列）且待滿 5 分鐘才放
function releaseOldest(failed, now) {
  let oldest = null;
  let oldestAt = Infinity;
  for (const [call, at] of failed) {
    const t = at ?? 0;
    if (t < oldestAt) {
      oldestAt = t;
      oldest = call;
    }
  }
  if (oldest === null || now - oldestAt < FAIL_CALLSIGN_DWELL_MS) return null;
  failed.delete(oldest);
  return oldest;
}
