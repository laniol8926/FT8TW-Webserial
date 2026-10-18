// 解碼卡片、呼叫清單、摩登電台卡的畫面（add-web-transmit 3.2、3.4 部分、3.5）。
// 規則在 rules.mjs 與 station/aggregator.mjs（純函式，有單元測試）；這裡只做 DOM，以真瀏覽器檢查（tools/ui-cards-check.mjs）驗證。
// 解碼表格的 <table>/<tr>/<td> 與 role 不變（報讀軟體讀得到欄名），列的原始資料仍由 main.mjs 的 rowData 保存、
// 呼叫手勢仍由 tx/rowcall.mjs 處理；本模組只負責把一列填成 FT8TW 卡片的樣子。
import { cardModel, callListRows, CALL_FILTERS, EMPTY_WORKED, parseRow, workedSets, normalizeTarget, rowsForMode,
  LIST_FILTERS, TIME_FILTERS, filterActive, matchesListFilter, filterCounts } from './rules.mjs';
import { countryName, loadCountryDb } from '../country/db.mjs';
import { flagImg } from '../country/flag.mjs'; // 國名前的國旗；清單太窄時由 CSS 藏起來（cards.css）
import { formatUtc } from '../format.mjs';
import { selectedDial } from '../bands.mjs';
import { initRowCall } from '../tx/rowcall.mjs';
import { initStationView } from '../station/ui.mjs';
import { t } from '../i18n/index.mjs';
import { emptyState } from '../radar.mjs';
import { createRadar } from '../radar-ui.mjs';

const KEEP_MS = 60 * 60_000; // 呼叫清單與電台卡保留最近一小時的解碼
const KEEP_ROWS = 3000; // 同 FT8TW transmitMessages 的上限
const SHOW_ROWS = 300; // 傳統清單最多畫幾列
const REDRAW_MS = 300; // 至多每 300 ms 重算一次（spec 摩登電台卡）
const QSO_MODES = new Set(['FT8', 'FT4', 'FT2']);
const STORE_KEY = 'ft8tw.callList';
const DECODE_STORE_KEY = 'ft8tw.decodeList'; // 解碼清單的篩選（與呼叫清單各自記住）
const FILTER_TICK_MS = 15_000; // 時間篩選：每 15 s 重算一次，過時的列自動隱藏
const MARK_NAMES = { d: 'DXCC', i: 'ITU', c: t('cards.mark.cq') };

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function marksEl(marks) {
  const span = el('span', 'marks');
  if (!marks) return span;
  const on = Object.keys(MARK_NAMES).filter((k) => marks[k]);
  for (const k of on) span.append(el('span', `mk mk-${k}`, k.toUpperCase()));
  if (on.length) span.setAttribute('aria-label', t('cards.notWorked', { list: on.map((k) => MARK_NAMES[k]).join(t('cards.listSep')) }));
  return span;
}

// dB 欄：只顯示數字（強度格已拿掉，使用者需求）
function snrCell(m) {
  const td = el('td', 'num snr');
  if (m.own) return td;
  td.append(el('span', 'snr-num', m.snr));
  td.setAttribute('aria-label', t('cards.snrAria', { snr: m.snr }));
  return td;
}

// 把一列填成卡片：欄位順序＝thead 的欄名（UTC S. dB Δt Hz 訊息 距離 發話方 接收方）
// 撥號頻率欄已拿掉：畫面上方已經常駐顯示目前波段／頻率，每列再重複一次是多餘的（使用者需求）
// UTC 移到最前、距離搬到原撥號頻率的位置（使用者需求）
export function fillCard(tr, m, startUtc) {
  const keep = tr.classList.contains('slot-start') ? 'slot-start ' : '';
  const sel = tr.classList.contains('selected') ? ' selected' : '';
  tr.className = `${keep}card tone-${m.tone} q${m.seq4}${m.strike ? ' worked' : ''}${m.bold ? ' strong' : ''}${m.own ? ' own' : ''} ${m.mine ? 'mine' : 'theirs'}${sel}`;
  tr.setAttribute('role', 'row');
  const msg = el('td', 'msg');
  if (m.star) {
    msg.append(el('span', 'star', '★'), ` ${m.message.slice(2)}`);
  } else msg.textContent = m.message;
  const from = el('td', 'from');
  from.append(marksEl(m.fromMarks), flagImg(m.fromFlag), el('span', 'cty', m.fromCountry));
  const to = el('td', 'to');
  to.append(flagImg(m.toFlag), el('span', 'cty', m.toCountry), marksEl(m.toMarks));
  const cells = [
    el('td', 'utc', m.utcText ?? formatUtc(startUtc)), el('td', 'seq', String(m.seq)), snrCell(m),
    el('td', `num dt${m.dtBold ? ' bold' : ''}`, m.dt), el('td', 'num hz', m.hz), msg,
    el('td', 'num dist', m.km === null ? '' : `${m.km} km`), from, to,
  ];
  for (const td of cells) td.setAttribute('role', 'cell');
  tr.replaceChildren(...cells);
}

function readStore(storage, key = STORE_KEY) {
  try {
    return JSON.parse(storage?.getItem(key) ?? 'null') ?? {};
  } catch {
    return {};
  }
}
function writeStore(storage, patch, key = STORE_KEY) {
  try {
    storage?.setItem(key, JSON.stringify({ ...readStore(storage, key), ...patch }));
  } catch { /* 無痕模式：只是不記得 */ }
}

// 存的篩選不在清單上（改版、亂改）就退回全部
function loadFilterState(storage, key, kinds) {
  const st = readStore(storage, key);
  return {
    filter: kinds.some(([k]) => k === st.filter) ? st.filter : 'all',
    minutes: TIME_FILTERS.includes(st.minutes) ? st.minutes : 0,
  };
}

// 篩選列：時間下拉＋類別分段按鈕；state 就地修改後呼叫 onChange。回傳 sync()（更新按下狀態）
function buildFilterBar(box, kinds, state, onChange) {
  const time = el('select', 'list-time');
  time.setAttribute('aria-label', t('cards.time.label'));
  for (const m of TIME_FILTERS) time.append(new Option(m ? t('cards.time.min', { n: m }) : t('cards.time.all'), String(m)));
  time.addEventListener('change', () => {
    state.minutes = Number(time.value);
    onChange();
  });
  const buttons = kinds.map(([key, label]) => {
    const b = el('button', 'seg-btn', label);
    b.append(el('span', 'seg-n', '')); // 筆數（使用者 2026-10-10，同 FT8TW「CQ 12」）
    b.type = 'button';
    b.dataset.filter = key;
    b.addEventListener('click', () => {
      state.filter = key;
      onChange();
    });
    return b;
  });
  box.replaceChildren(time, ...buttons);
  // counts：{ all: n, cq: n, … }（不給＝維持上次的）
  return function sync(counts) {
    time.value = String(state.minutes);
    for (const b of buttons) {
      b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter));
      if (counts) b.querySelector('.seg-n').textContent = ` ${counts[b.dataset.filter] ?? 0}`;
    }
  };
}

// decodes：解碼清單的 <tbody>；getRowData(tr)：main.mjs 的 rowData；getSettings／getConfig：接收設定與 ft8tw.config；
// getTarget()：目前（或最後一次）呼叫的對象；callRow(row)：qsoUi.callRow；qsoLog：Promise<openQsoLog 的結果>
// getDialHz(settings)：撥號頻率（CAT 時是電台實際頻率，與摘要列、回報、通聯紀錄一致）
// getMode()：目前模式；呼叫清單與電台卡只列這個模式的（Codex 2026-10-09）；不給就不過濾
export function initCards({ decodes, getRowData, getSettings, getConfig, getTarget, callRow, qsoLog, storage, utcNow = () => Date.now(), getDialHz = (s) => selectedDial(s),
  getMode = () => null, onDecodeFilter = () => {}, isRunning = () => false,
  dataBase = new URL('../../data/', import.meta.url) }) {
  const $ = (id) => document.getElementById(id);
  let country = null; // 國別資料庫（載入前國名、D／I／C、國旗都留空）
  let worked = EMPTY_WORKED;
  let qsos = [];
  const grids = new Map(); // 呼號 → 最近一次送過的網格（GeneralVariables.getGridByCallsign）
  const recent = []; // 呼叫清單與電台卡的資料：{ text, snr, freqHz, timeSec, startUtc, mode, own? }
  const clearedRows = new WeakSet(); // 呼叫清單的清除鍵：只清畫面，電台卡不受影響（之後的新訊息照常列出）
  const callState = loadFilterState(storage, STORE_KEY, CALL_FILTERS); // 呼叫清單：{ filter, minutes }
  const decodeState = loadFilterState(storage, DECODE_STORE_KEY, LIST_FILTERS); // 解碼清單
  const filtersOn = () => QSO_MODES.has(getMode()); // 篩選只在 FT8／FT4／FT2（JS8、JTTY 隱藏篩選列且不套用）

  const lookup = (call) => country?.lookup(call) ?? null;
  const followSet = () => new Set(getConfig().followCallsigns ?? []);
  function ctx() {
    const s = getSettings();
    const c = getConfig();
    return {
      myCall: s.callsign ?? '', myGrid: s.grid ?? '', follow: followSet(), worked, lookup, gridOf: (call) => grids.get(call) ?? null,
      dialHz: getDialHz(s) ?? selectedDial(s), target: getTarget(), excluded: c.excludedCallsigns ?? [], showWorked: c.showWorkedStations,
    };
  }
  function learn(row) {
    const p = parseRow(row.text);
    if (p.grid && p.from) grids.set(p.from.toUpperCase(), p.grid);
  }

  // ── 解碼清單 ──
  function fillRow(tr, row) {
    learn(row);
    fillCard(tr, cardModel(row, ctx()), row.startUtc);
  }
  function refreshDecodes() {
    const c = ctx();
    for (const tr of decodes.rows) {
      const row = getRowData(tr);
      if (row) fillCard(tr, cardModel(row, c), row.startUtc);
    }
  }

  // ── 呼叫清單（傳統）＋電台卡 ──
  const panel = $('call-list-panel');
  const callBody = $('call-list');
  const callData = new WeakMap();
  initRowCall(callBody, { getData: (tr) => callData.get(tr), onCall: (row) => callRow(row) });
  const station = initStationView({
    root: $('station-view'), storage, callRow,
    getParams: () => {
      const c = ctx();
      return {
        nowUtcMs: utcNow(), myGrid: c.myGrid, myCall: c.myCall, currentTarget: c.target, showWorked: c.showWorked,
        tracked: c.follow, workedCalls: worked.calls,
        newFlags: (call) => {
          const info = lookup(call);
          return info ? { newDxcc: !worked.dxcc.has(info.dxcc), newItu: !worked.itu.has(info.itu), newCqZone: !worked.cq.has(info.cq) } : {};
        },
      };
    },
    lookup,
    isRunning,
    radarOn: () => filtersOn(),
  });

  const filterBox = $('call-list-filters');
  const syncCallBar = buildFilterBar(filterBox, CALL_FILTERS, callState, () => {
    writeStore(storage, callState);
    redrawNow();
  });
  // 解碼清單的篩選列（列由 main.mjs 管：改了就請它重算 hidden 與計數）
  const decodeBox = $('decode-filters');
  const decodeBar = decodeBox ? buildFilterBar(decodeBox, LIST_FILTERS, decodeState, () => {
    writeStore(storage, decodeState, DECODE_STORE_KEY);
    syncDecodeBar();
    onDecodeFilter();
  }) : () => {};
  // 解碼清單按鈕的筆數：目前模式的列、在時間範圍內各類別各算
  function syncDecodeBar() {
    if (!decodeBox) return;
    const mode = getMode();
    const rows = [...decodes.rows].map((tr) => getRowData(tr)).filter((r) => r && (!mode || r.mode === mode));
    decodeBar(filterCounts(rows, LIST_FILTERS, { minutes: decodeState.minutes, nowUtc: utcNow() }, ctx()));
  }
  // 空清單的雷達（使用者 2026-10-09）：解碼清單、呼叫清單各一個，蓋在清單區正中間；有列看得到就隱藏
  const decodeRadar = createRadar();
  decodes.closest('.cards-wrap')?.append(decodeRadar.el);
  const callRadar = createRadar();
  $('call-list-classic').append(callRadar.el);
  $('call-list-empty').hidden = true; // 原本的一行提示改由雷達的說明取代
  const decodeCounts = { shown: 0, total: 0 };
  const callCounts = { shown: 0, total: 0 };
  function updateRadars() {
    const on = filtersOn();
    const running = isRunning();
    decodeRadar.set(on ? emptyState({ ...decodeCounts, running, minutes: decodeState.minutes }) : null);
    callRadar.set(on ? emptyState({ ...callCounts, running, minutes: callState.minutes }) : null);
    station.updateEmpty();
  }

  function syncBars() {
    const on = filtersOn();
    filterBox.hidden = !on;
    if (decodeBox) decodeBox.hidden = !on;
    syncCallBar();
    syncDecodeBar();
  }

  // 電台卡是獨立的分頁（使用者 2026-10-06）：呼叫清單與電台卡都每次更新。
  // 「呼叫畫面使用電台卡（摩登）」只決定手機「呼叫」分頁顯示哪一個（body.modern-calling，CSS 處理）
  function drawCallList() {
    const modern = Boolean(getConfig().modernCalling);
    document.body.classList.toggle('modern-calling', modern);
    const mine = rowsForMode(recent, getMode()); // 只列目前模式（切回原模式時舊資料還在）
    station.render(mine);
    $('station-count').textContent = '';
    syncBars();
    const c = ctx();
    const kept = mine.filter((r) => !clearedRows.has(r));
    const on = filtersOn();
    const rows = callListRows(kept, on ? callState.filter : 'all', c, on ? { minutes: callState.minutes, nowUtc: utcNow() } : {});
    syncCallBar(filterCounts(callListRows(kept, 'all', c), CALL_FILTERS, { minutes: callState.minutes, nowUtc: utcNow() }, c)); // 按鈕後面的筆數
    const shown = rows.slice(-SHOW_ROWS).reverse().sort((a, b) => b.startUtc - a.startUtc); // 新的在上（同解碼清單）
    const frag = document.createDocumentFragment();
    let lastSlot = null;
    for (const row of shown) {
      const tr = document.createElement('tr');
      callData.set(tr, row);
      if (row.startUtc !== lastSlot) tr.classList.add('slot-start');
      lastSlot = row.startUtc;
      fillCard(tr, cardModel(row, c), row.startUtc);
      frag.append(tr);
    }
    callBody.replaceChildren(frag);
    callCounts.shown = rows.length;
    callCounts.total = callListRows(kept, 'all', c).length;
    $('call-list-count').textContent = on && filterActive(callState)
      ? t('cards.countOf', { shown: rows.length, total: callCounts.total }) // 顯示中／總數
      : t('cards.count', { n: rows.length });
    updateRadars();
  }

  let timer = null;
  let lastDraw = 0;
  function redraw() {
    if (timer) return;
    const wait = Math.max(0, lastDraw + REDRAW_MS - Date.now());
    timer = setTimeout(redrawNow, wait);
  }
  function redrawNow() {
    clearTimeout(timer);
    timer = null;
    lastDraw = Date.now();
    drawCallList();
  }

  function push(rows) {
    recent.push(...rows);
    const cutoff = utcNow() - KEEP_MS;
    let drop = 0;
    while (drop < recent.length && (recent[drop].startUtc < cutoff || recent.length - drop > KEEP_ROWS)) drop++;
    if (drop) recent.splice(0, drop);
  }

  async function refreshWorked() {
    try {
      qsos = await (await qsoLog).list();
    } catch {
      qsos = [];
    }
    worked = workedSets(qsos, lookup);
    refreshAll();
  }

  function refreshAll() {
    refreshDecodes();
    onDecodeFilter(); // 已通聯、國別、追蹤清單、我的呼號變了：NEW DXCC 等篩選結果跟著變
    redrawNow();
  }

  loadCountryDb({ base: dataBase }).then((db) => {
    country = db;
    worked = workedSets(qsos, lookup);
    refreshAll();
  }, () => { /* 國別資料載入失敗：卡片照常，只是沒有國名與分區標記 */ });
  refreshWorked();
  // 電台卡的「剛收到」圓點與變淡要隨時間更新；目前對象改變時呼叫清單的「目前對象」篩選也要跟上
  let lastTarget = normalizeTarget(getTarget());
  setInterval(() => {
    const t = normalizeTarget(getTarget());
    if (t !== lastTarget || getConfig().modernCalling) {
      lastTarget = t;
      redraw();
    }
  }, 5000);
  // 時間篩選：過時的列自動隱藏
  setInterval(() => {
    if (!filtersOn()) return;
    if (decodeState.minutes) onDecodeFilter();
    if (callState.minutes) redraw();
  }, FILTER_TICK_MS);
  setInterval(updateRadars, 1000); // 開始／停止接收時說明跟著換（文字沒變不動 DOM）
  drawCallList();

  return {
    fillRow,
    refreshAll,
    refreshWorked,
    lookup, // 國別
    countryOf: (call) => countryName(lookup(call)), // 依語系的國名（右鍵選單用：where: (call) => cards.countryOf(call)）
    // 點到的呼叫清單列或電台卡 → 訊息資料（右鍵選單用）
    rowFor(target) {
      const tr = target?.closest?.('tr');
      if (tr && callBody.contains(tr)) return callData.get(tr) ?? null;
      return station.rowFor(target);
    },
    // 每個 FT8／FT4／FT2 接收 slot 解碼完
    // dialHz：收到當時的撥號頻率（換模式／頻率後，舊列仍顯示原本的頻率）
    onDecoded({ startUtc, mode, results, dialHz }) {
      if (!QSO_MODES.has(mode)) return;
      const rows = results.map((r) => ({ text: r.text, snr: r.snr, freqHz: r.freqHz, timeSec: r.timeSec, startUtc, mode, ...(Number.isFinite(dialHz) ? { dialHz } : {}) }));
      rows.forEach(learn);
      push(rows);
      redraw();
    },
    // 我方開始發射一則（呼叫清單要列出往來，同 FT8TW 把我方訊息加進 transmitMessages）
    onSent({ text, mode, audioHz, slotStart }) {
      if (!text || !QSO_MODES.has(mode)) return;
      const dialHz = ctx().dialHz;
      push([{ text, snr: 0, freqHz: audioHz, timeSec: 0, startUtc: slotStart, mode, own: true, ...(Number.isFinite(dialHz) ? { dialHz } : {}) }]);
      redraw();
    },
    recent: () => recent,
    // 解碼清單的篩選：回傳 (row) => 是否符合（JS8、JTTY 一律符合）；一次取一個，整批列共用同一份 ctx
    decodeFilter() {
      if (!filtersOn()) return () => true;
      const c = ctx();
      const opts = { ...decodeState, nowUtc: utcNow() };
      return (row) => matchesListFilter(row, opts, c);
    },
    // 解碼清單看得到幾列、目前模式共幾列：空清單雷達（main.mjs 每次更新計數時呼叫）
    decodeEmpty(shown, total) {
      decodeCounts.shown = shown;
      decodeCounts.total = total;
      if (filtersOn()) syncDecodeBar(); // 新列進來：按鈕筆數跟著更新
      updateRadars();
    },
    // 解碼清單計數：有篩選時「顯示中／總數」（總數＝目前模式的列）
    decodeCountText(shown, total) {
      return filtersOn() && filterActive(decodeState) ? t('cards.decodeCountOf', { shown, total }) : t('page.decode.count', { n: shown });
    },
    // 換模式：呼叫清單與電台卡立即改列新模式的
    setMode() {
      redrawNow();
    },
    clearCallList() {
      for (const r of recent) clearedRows.add(r);
      redrawNow();
    },
  };
}
