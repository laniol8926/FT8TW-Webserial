// 地圖「誰呼叫誰」連線（使用者 2026-10-07，仿 FT8TW 網格追蹤地圖 GridOsmMapView.drawLine）。純邏輯，有單元測試。
// 右邊清單裡最近 LINK_SLOTS 個 slot 的訊息，每則「發話方 → 接收方」一條；CQ、雜湊呼號、自由文字、我方發射的列不畫。
// 位置同 App getMessageLatLng：訊息帶的網格 → 記住的網格 → 國家中心點（概略，畫虛線）；任一端定位不到就不畫。
import { locate, messageInfo } from './stations.mjs';
import { greatCircle } from './projection.mjs';

export const LINK_SLOTS = 2; // 奇偶兩個時序都看得到（一問一答兩邊都在；使用者 2026-10-07 選定）

const CALL_RE = /^(?=.*\d)[A-Z0-9/]{3,}$/; // 至少一個數字：擋掉 TNX、GL 之類的自由文字

/**
 * @param rows 清單的列（{ text, startUtc, own? }）
 * @param opts.myCall 我的呼號（標 toMe）；opts.gridOf(call) 記住的網格；opts.approxLocate(call) 國家中心點
 * @returns [{ from, to, a: { lat, lon, approx }, b: { lat, lon, approx }, toMe, utc }]，a＝發話方、b＝接收方
 */
export function linksFromRows(rows, { myCall = '', gridOf = () => null, approxLocate = null, slots = LINK_SLOTS } = {}) {
  const usable = (rows ?? []).filter((r) => r?.text && !r.own && Number.isFinite(r.startUtc));
  const recent = new Set([...new Set(usable.map((r) => r.startUtc))].sort((x, y) => y - x).slice(0, slots));
  const me = String(myCall).trim().toUpperCase();
  const byPair = new Map();
  for (const r of usable) {
    if (!recent.has(r.startUtc) || r.text.includes('<')) continue; // 雜湊呼號：不知道是誰，也就沒有位置
    const info = messageInfo(r.text, me);
    if (!info || info.isCq || !info.to || !CALL_RE.test(info.to) || !CALL_RE.test(info.sender)) continue;
    const a = locate({ call: info.sender, grid: info.grid ?? gridOf(info.sender) }, approxLocate);
    const b = locate({ call: info.to, grid: gridOf(info.to) }, approxLocate);
    if (!a || !b) continue;
    const key = `${info.sender}>${info.to}`;
    const old = byPair.get(key);
    if (old && old.utc > r.startUtc) continue;
    byPair.set(key, { from: info.sender, to: info.to, a, b, toMe: Boolean(me) && info.to === me, utc: r.startUtc });
  }
  return [...byPair.values()];
}

// ── JS8 模式（使用者 2026-10-07：地圖只顯示目前紀錄中的 JS8 站台）──
// 輸入 JS8 對話紀錄（js8chat store 的訊息：dir、from、to、grid、isCq、snr、utc），輸出地圖的電台點與「誰呼叫誰」連線。
// 電台點＝收到的發話台；網格：訊息帶的 → 該台在對話裡出現過的 → gridOf（FT8 聽過的）→ 國家中心點（由地圖 locate）。
// 連線＝指名訊息 A → B（B 是 @群組、雜湊就不畫）；JS8 訊息時間不對齊 slot，用「最新一則往前 slots×periodMs」的時間窗。
const isCall = (c) => Boolean(c) && !/^[<@]/.test(c) && CALL_RE.test(c);

export function js8MapData(messages, { myCall = '', myGrid = '', gridOf = () => null, approxLocate = null, slots = LINK_SLOTS, periodMs = 15000 } = {}) {
  const list = (messages ?? []).filter((m) => m && Number.isFinite(m.utc)).sort((a, b) => a.utc - b.utc);
  const me = String(myCall).trim().toUpperCase();
  const chatGrid = new Map();
  for (const m of list) if (m.dir === 'rx' && m.grid && isCall(m.from)) chatGrid.set(m.from, m.grid);
  const gridFor = (call) => chatGrid.get(call) ?? (call === me && myGrid ? myGrid : null) ?? gridOf(call);

  const byCall = new Map();
  for (const m of list) {
    if (m.dir !== 'rx' || !isCall(m.from) || m.from === me) continue;
    byCall.delete(m.from); // 重新插入：最近聽到的在最後
    byCall.set(m.from, {
      call: m.from, grid: m.grid || gridFor(m.from), snr: m.snr, isCq: Boolean(m.isCq), callsMe: Boolean(me) && m.to === me, to: isCall(m.to) ? m.to : null, lastUtc: m.utc,
    });
  }
  const stations = [...byCall.values()].reverse();

  const latest = list.at(-1)?.utc ?? 0;
  const byPair = new Map();
  for (const m of list) {
    if (latest - m.utc >= slots * periodMs || !isCall(m.from) || !isCall(m.to)) continue;
    const a = locate({ call: m.from, grid: (m.dir === 'rx' && m.grid) || gridFor(m.from) }, approxLocate);
    const b = locate({ call: m.to, grid: gridFor(m.to) }, approxLocate);
    if (!a || !b) continue;
    byPair.set(`${m.from}>${m.to}`, { from: m.from, to: m.to, a, b, toMe: Boolean(me) && m.to === me, utc: m.utc });
  }
  return { stations, links: [...byPair.values()] };
}

/**
 * 自動框住地圖時要包含的連線點（使用者 2026-10-08：沒有把所有站台跟通訊線條都包含）：
 * 兩端點（可能不在目前清單裡）加上大圓航線的取樣點（等距圓柱投影上航線會往極區凸出，只框端點會被切掉）。
 * @param links [{ a: {lat, lon}, b: {lat, lon} }]（linksFromRows 的結果，或我方→對象的航線）
 */
export function linkFramePoints(links, segments = 16) {
  const out = [];
  for (const l of links ?? []) {
    if (!l?.a || !l?.b) continue;
    out.push({ lat: l.a.lat, lon: l.a.lon }, { lat: l.b.lat, lon: l.b.lon });
    for (const p of greatCircle(l.a.lat, l.a.lon, l.b.lat, l.b.lon, segments).slice(1, -1)) out.push({ lat: p.lat, lon: p.lon });
  }
  return out;
}
