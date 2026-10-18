// JS8 通訊畫面的泡泡顯示（純函式，add-web-js8-chat js8-chat spec「對話泡泡」）。
// 對照 FT8TW Js8ChatAdapter.buildMeta／onBindViewHolder 與 Js8TimeFormat：
// 泡泡時刻、日期分隔線一定用同一個時區（UTC 帶 Z、本地不帶），否則 UTC+8 凌晨會出現「時刻是今天、日期是昨天」。

const PERIOD_SEC = { 0: 15, 1: 10, 2: 6, 4: 30, 8: 4 }; // design D2
const FT8TW_ONLY_SUBMODES = new Set([8]); // FTW 4S 只與 FT8TW 互通（design D9）

export function periodSec(submode) {
  return PERIOD_SEC[submode] ?? null;
}

function parts(ms, { local = false, timeZone } = {}) {
  if (!local) {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const o = Object.fromEntries(f.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}
const p2 = (n) => String(n).padStart(2, '0');

/** 泡泡上的時刻：UTC `13:40:16Z`、本地 `21:40:16` */
export function timeText(ms, opts = {}) {
  const t = parts(ms, opts);
  return `${p2(t.h)}:${p2(t.mi)}:${p2(t.s)}${opts.local ? '' : 'Z'}`;
}

/** 當日第一則上方的日期分隔線 `yyyy-mm-dd`，與 timeText 同一時區 */
export function dayText(ms, opts = {}) {
  const t = parts(ms, opts);
  return `${t.y}-${p2(t.mo)}-${p2(t.d)}`;
}

const signed2 = (n) => `${n < 0 ? '-' : '+'}${p2(Math.abs(Math.round(n)))}`;

/** 泡泡上方那一列（顯示與「複製完整內容」共用） */
export function bubbleMeta(m, opts = {}) {
  const out = [timeText(m.utc, opts)];
  if (m.dir === 'tx') {
    out.push(m.to ? `TX → ${m.to}` : 'TX');
  } else {
    // showTo（JTTY）：有收話者時顯示「發話者 → 收話者」
    const to = opts.showTo && m.to ? m.to : '';
    if (m.from) out.push(to ? `${m.from} → ${to}` : m.from);
    else if (to) out.push(`→ ${to}`);
    out.push(signed2(m.snr ?? 0), `${Math.round(m.freqHz ?? 0)}Hz`);
  }
  // 用秒數標速度（App：使用者是色盲，秒數對得上速度選單）；-1／缺值是舊記錄，不畫
  const sec = periodSec(m.submode);
  if (sec) out.push(`${sec}s`);
  // utxLabel（JTTY 強化編碼，add-jtty-utx U7）：由呼叫端依語系給，例如「強化·只與 FT8TW 互通」
  if (m.utx && opts.utxLabel) out.push(opts.utxLabel);
  else if (FT8TW_ONLY_SUBMODES.has(m.submode) || m.utx) out.push('FT8TW');
  // JTTY 糾錯修復（add-jtty-fec）：修復的 frame 數，文字由呼叫端給（opts.repairedLabel(n) → 字串）
  if (m.repaired && opts.repairedLabel) out.push(opts.repairedLabel(m.repaired));
  // JTTY 自動分則（add-jtty-utx U12）：第幾則／休息中，文字由呼叫端給（opts.partLabel(m) → 字串或空）
  const part = opts.partLabel?.(m);
  if (part) out.push(part);
  // 發射被中斷（JTTY，add-web-jtty jtty-chat「中途停止」）：標示文字由呼叫端依語系給（opts.abortedLabel）；分則沒發就取消的標 cancelledLabel
  if (m.aborted) out.push(opts.abortedLabel ?? '×');
  else if (m.cancelled) out.push(opts.cancelledLabel ?? opts.abortedLabel ?? '×');
  return out.join('  ');
}

/** 泡泡本文：接收中後面跑「.」「..」「...」；不完整半透明並以「 …」結尾 */
export function bubbleText(m, nowMs = Date.now()) {
  const text = m.text ?? '';
  if (m.live) return { text: `${text} ${'.'.repeat(1 + (Math.floor(nowMs / 400) % 3))}`, dim: false, live: true };
  return m.complete ? { text, dim: false, live: false } : { text: `${text} …`, dim: true, live: false };
}

/** 依時間順序的訊息前插日期分隔：[{type:'day', text} | {type:'msg', m}] */
export function withDaySeparators(messages, opts = {}) {
  const out = [];
  let prev = null;
  for (const m of messages) {
    const day = dayText(m.utc, opts);
    if (day !== prev) out.push({ type: 'day', text: day });
    prev = day;
    out.push({ type: 'msg', m });
  }
  return out;
}

/** 「複製完整內容」：資訊列＋換行＋本文 */
export function fullText(m, opts = {}) {
  return `${bubbleMeta(m, opts)}\n${m.text ?? ''}`;
}
