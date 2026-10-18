// 摩登電台卡的畫面（add-web-transmit 3.5、design D17）：仿 FT8TW StationViewFragment／StationListAdapter／station_card_item。
// 卡片三行：國旗 呼號 網格 強度格 SNR／標籤 ● UTC／國名 · km · Hz  最新訊息；左側色條：叫我洋紅（粗）、CQ 綠（細）；
// 已通聯半透明、五分鐘沒聽到變淡。呼叫：觸控長按、滑鼠點按（spec「長按（桌機點按）」）、鍵盤 Enter。
// 彙整與篩選在 aggregator.mjs（純函式）；本檔只做 DOM，以真瀏覽器檢查（tools/ui-cards-check.mjs）驗證。
import { CHIPS, SORT, WINDOW_CHOICES, DEFAULT_WINDOW_MINUTES, applyFilterToggle, build, count, distanceText, frequencyText,
  isFresh, isStale, normalizeWindowMinutes, sanitizeMask, signalBars, snrText, tagsOf } from './aggregator.mjs';
import { formatUtc } from '../format.mjs';
import { flagImg } from '../country/flag.mjs';
import { countryName } from '../country/db.mjs';
import { t } from '../i18n/index.mjs';
import { emptyState } from '../radar.mjs';
import { createRadar } from '../radar-ui.mjs';

const STORE_KEY = 'ft8tw.stationView';
const SORT_LABELS = [[SORT.RECENT, t('station.sort.recent')], [SORT.SNR, t('station.sort.snr')], [SORT.DISTANCE, t('station.sort.distance')], [SORT.CALL, t('station.sort.call')]];

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function load(storage) {
  let raw = {};
  try {
    raw = JSON.parse(storage?.getItem(STORE_KEY) ?? 'null') ?? {};
  } catch { /* 壞掉的設定：用預設 */ }
  return {
    windowMinutes: normalizeWindowMinutes(raw.windowMinutes ?? DEFAULT_WINDOW_MINUTES),
    sort: Object.values(SORT).includes(raw.sort) ? raw.sort : SORT.RECENT,
    mask: sanitizeMask(raw.mask ?? 0),
  };
}

// root：#station-view；getParams()：彙整參數（不含時間窗、排序、篩選）；lookup(call)：國別；callRow(row)：呼叫
// isRunning()：接收中（空清單雷達的說明）；radarOn()：要不要顯示雷達（FT8／FT4／FT2）
export function initStationView({ root, storage, getParams, lookup, callRow, isRunning = () => false, radarOn = () => true }) {
  const prefs = load(storage);
  const save = () => {
    try {
      storage?.setItem(STORE_KEY, JSON.stringify(prefs));
    } catch { /* 無痕模式 */ }
  };
  let lastRows = [];
  const cardRow = new WeakMap();

  // ── 工具列：排序、時間窗、篩選 chip ──
  const sortSel = el('select', 'st-sort');
  sortSel.setAttribute('aria-label', t('station.sortAria'));
  sortSel.append(...SORT_LABELS.map(([v, label]) => new Option(label, v)));
  sortSel.value = prefs.sort;
  const winSel = el('select', 'st-window');
  winSel.setAttribute('aria-label', t('station.windowAria'));
  winSel.append(...WINDOW_CHOICES.map((m) => new Option(t('station.windowItem', { n: m }), String(m))));
  winSel.value = String(prefs.windowMinutes);
  const tools = el('div', 'st-tools');
  tools.append(sortSel, winSel);
  const chipBox = el('div', 'st-chips');
  chipBox.setAttribute('role', 'group');
  chipBox.setAttribute('aria-label', t('station.filterAria'));
  const chips = CHIPS.map(([bit, label]) => {
    const b = el('button', 'st-chip', label);
    b.type = 'button';
    b.dataset.bit = String(bit);
    b.dataset.label = label;
    b.addEventListener('click', () => {
      prefs.mask = applyFilterToggle(prefs.mask, bit);
      save();
      render(lastRows);
    });
    return b;
  });
  chipBox.append(...chips);
  const list = el('div', 'st-list');
  list.setAttribute('role', 'list');
  list.id = 'station-list';
  // 空清單：雷達掃描＋說明（使用者 2026-10-09，同 App stationEmptyBox；取代原本的一行提示）
  const radar = createRadar();
  const counts = { shown: 1, total: 0 };
  const updateEmpty = () => radar.set(radarOn() ? emptyState({ ...counts, running: isRunning(), minutes: prefs.windowMinutes }) : null);
  root.replaceChildren(tools, chipBox, list, radar.el);
  sortSel.addEventListener('change', () => { prefs.sort = sortSel.value; save(); render(lastRows); });
  winSel.addEventListener('change', () => { prefs.windowMinutes = Number(winSel.value); save(); render(lastRows); });

  // ── 呼叫手勢 ──
  const cardOf = (t) => {
    const c = t?.closest?.('.st-card');
    return c && list.contains(c) ? c : null;
  };
  const call = (card) => {
    const r = cardRow.get(card);
    if (!r) return;
    const now = Date.now();
    if (r === lastCall.row && now - lastCall.at < 1000) return; // 雙擊產生兩個 click：同一張卡一秒內只呼叫一次
    lastCall.row = r;
    lastCall.at = now;
    callRow(r.latest);
  };
  const lastCall = { row: null, at: 0 };
  // 雙擊呼叫（同解碼清單）；單擊不呼叫。右鍵與手機長按開選單（qso/contextmenu.mjs，使用者 2026-10-06）
  list.addEventListener('dblclick', (e) => {
    const c = cardOf(e.target);
    if (c) call(c);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const c = cardOf(e.target);
      if (c) {
        e.preventDefault();
        call(c);
      }
    }
  });
  // 長按與右鍵由 qso/contextmenu.mjs 開選單（不直接呼叫）

  function bars(n) {
    const b = el('span', 'st-bars');
    b.setAttribute('aria-hidden', 'true');
    for (let i = 1; i <= 5; i++) b.append(el('i', i <= n ? 'on' : ''));
    return b;
  }

  function card(r, now) {
    const info = lookup(r.callsign);
    const c = el('div', `st-card${r.callingMe ? ' me' : r.isCq ? ' cq' : ''}${r.worked ? ' worked' : isStale(r.lastHeardUtcMs, now) ? ' stale' : ''}`);
    c.setAttribute('role', 'listitem');
    c.tabIndex = 0;
    c.dataset.call = r.callsign;
    const label = `${r.callsign} ${r.snr} dB${r.isCq ? ' CQ' : ''}${r.callingMe ? ` ${t('station.ariaCallingMe')}` : ''}`;
    c.setAttribute('aria-label', t('station.cardAria', { label }));
    cardRow.set(c, r);
    const country = countryName(info);
    const line1 = el('div', 'st-l1');
    if (info?.flagUrl) line1.append(flagImg(info.flagUrl, { className: 'st-flag flag', alt: country }));
    line1.append(el('span', 'st-call', r.callsign), el('span', 'st-grid', r.grid ?? ''), bars(signalBars(r.snr)), el('span', 'st-snr', snrText(r.snr)));
    const line2 = el('div', 'st-l2');
    const tags = el('span', 'st-tags');
    for (const [text, style] of tagsOf(r)) tags.append(el('span', `st-tag t-${style}`, text));
    const dot = el('span', `st-dot${isFresh(r.lastHeardUtcMs, now) ? ' on' : ''}`);
    dot.setAttribute('aria-hidden', 'true');
    line2.append(tags, dot, el('span', 'st-time', formatUtc(r.lastHeardUtcMs)));
    const meta = [country, distanceText(r.distanceKm), frequencyText(r.freqHz)].filter(Boolean).join(' · ');
    const line3 = el('div', 'st-l3');
    line3.append(el('span', 'st-meta', meta), el('span', 'st-msg', r.latest.text.trim()));
    c.append(line1, line2, line3);
    return c;
  }

  function render(rows) {
    lastRows = rows;
    if (root.hidden) return;
    const base = getParams();
    const params = { ...base, windowMinutes: prefs.windowMinutes, sort: prefs.sort };
    const all = build(rows, { ...params, filterMask: 0 });
    const shown = prefs.mask === 0 ? all : build(rows, { ...params, filterMask: prefs.mask });
    for (const b of chips) {
      const bit = Number(b.dataset.bit);
      const on = bit === 0 ? prefs.mask === 0 : (prefs.mask & bit) !== 0;
      b.setAttribute('aria-pressed', String(on));
      b.textContent = `${b.dataset.label} ${count(all, bit)}`;
    }
    const now = base.nowUtcMs;
    list.replaceChildren(...shown.map((r) => card(r, now)));
    counts.shown = shown.length;
    counts.total = rows.length;
    updateEmpty();
  }

  return {
    render,
    // 點到的電台卡 → 該台最新一則訊息（右鍵選單用）
    rowFor(target) {
      const c = cardOf(target);
      return c ? cardRow.get(c)?.latest ?? null : null;
    },
    updateEmpty, // 接收開始／停止時更新說明（cards/ui.mjs 每秒呼叫）
    setVisible(on) {
      root.hidden = !on;
    },
  };
}
