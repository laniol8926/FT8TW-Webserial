// 地圖區塊（<section id="map-panel">）的接線。使用者 2026-10-07：地圖只畫右邊目前所選清單（解碼／呼叫／電台卡）裡的電台，
// 沒有自己的篩選條件與標題；主程式每秒把那份清單的列交給 setRows(rows)。沒網格的用國家中心點（approxLocate）。
// 所有解碼仍由 onSlot(data) 餵進來：記住聽過的網格、目前對象最新一則在做什麼（呼叫場景）。
// setMe(grid)、setTarget(call)、noteTx(slotStart) 同前；呼叫場景（航線、光點、漣漪）每秒依時效重算（scene.mjs）。
//
// 地圖設定（add-map-settings-globe D2～D4、D18）：右鍵／長按／齒輪鈕開 <dialog id="map-settings">；改了立即套用並存 localStorage。
// 回傳的 map 是固定的外觀物件（facade）：記住最後的資料，轉給目前的繪製層（2D map.mjs 或 3D globe.mjs）；
// 切換時 destroy 舊的、建新的（3D 另用 #map-globe canvas）、重放資料。3D 建不起來（沒有 WebGL）就留在 2D 並提示。
import { createMap } from './map.mjs';
import { OVERLAY_KEYS, loadMapSettings, saveMapSettings } from './settings.mjs';
import { icon } from '../icons.mjs';
import { GridMemory, StationTracker, locate, stationsFromRows } from './stations.mjs';
import { buildScene, classify, rippleCalls, withinRecentSlots } from './scene.mjs';
import { js8MapData, linksFromRows } from './links.mjs';
import { gridToLatLon } from '../maidenhead.mjs';
import { keepSelection, selectionCall } from './selection.mjs';
import { configureTileSource, eoxSource, peekEoxSource } from './eoxsource.mjs';
import { resolveTileSource } from './tilesource.mjs';

const PRUNE_MS = 30_000;
const SCENE_MS = 1000; // 場景時效（最近 2 個 slot）每秒檢查
const LINKS_KEY = 'ft8tw.map.links'; // 「連線」開關（預設開）

export function loadLinksOn(storage) {
  try {
    return storage.getItem(LINKS_KEY) !== '0';
  } catch {
    return true;
  }
}

// now()：校正後的 UTC 毫秒；getMyCall()：我的呼號（判斷「叫我」）；onPick(call)：點選標點；
// approxLocate(call)：國家中心點 { lat, lon }（沒網格的電台）；slotMs()：目前模式的 slot 長度
// locale：介面語系（國名用）；t(key)：翻譯（提示文字）；tileSource：線上地圖來源（tilesource.mjs resolveTileSource，add-map-tile-source）
export function initMapPanel({ now, getMyCall, onPick, approxLocate = null, slotMs = () => 15000, storage = null, locale = 'en', t = (k) => k,
  tileSource = resolveTileSource({}) }) {
  const $ = (id) => document.getElementById(id);
  const tracker = new StationTracker(); // 所有解碼（最近 15 分鐘）：目前對象的狀態
  const grids = new GridMemory();
  const map = createRendererSwitch({ $, onPick, approxLocate, storage, locale, t, tileSource });

  let meGrid = null;
  let targetCall = null;
  let lastTxUtc = null;
  let sceneKey = '';
  let rowsKey = '';
  let lastRows = [];
  let js8Links = null; // JS8 模式：連線來自對話紀錄（null＝非 JS8 模式，用清單列）
  let linksOn = storage ? loadLinksOn(storage) : true;
  let selected = null; // 清單左鍵選取的電台（add-map-overlays E）：地圖上特別顯眼
  // 點選當下直接標示（清單每秒才交給地圖一次，剛載入或剛切分頁時還沒進來）；之後每次清單更新才檢查還在不在
  function setSelected(call) {
    const next = call || null;
    if (next === selected) return;
    selected = next;
    map.setSelected(selected);
  }
  const gridOf = (call) => tracker.get(call)?.grid ?? grids.get(call) ?? null;
  // 呼叫場景：我方（網格，沒有就用國家中心點）、目前對象與它最新一則在做什麼、我方最近有沒有發射
  function updateScene() {
    const t = now();
    const period = slotMs();
    const meExact = meGrid ? gridToLatLon(meGrid) : null;
    const me = meExact ? { ...meExact, approx: false } : locate({ call: getMyCall(), grid: null }, approxLocate);
    const st = targetCall ? tracker.get(targetCall) : null;
    const them = targetCall ? locate({ call: targetCall, grid: gridOf(targetCall) }, approxLocate) : null;
    const state = st ? classify(withinRecentSlots(st.lastUtc, t, period), st.isCq, st.callsMe, st.to) : 'none';
    const toCall = st?.to?.replace(/[<>]/g, '') ?? '';
    const third = state === 'toOther' ? locate({ call: toCall, grid: gridOf(toCall) }, approxLocate) : null;
    const myTx = lastTxUtc !== null && withinRecentSlots(lastTxUtc, t, period);
    const scene = buildScene({ me, them, third, state, myTx });
    const key = JSON.stringify(scene);
    if (key === sceneKey) return;
    sceneKey = key;
    map.setScene(scene);
  }

  $('map-fit').addEventListener('click', () => map.fit());
  // 誰呼叫誰（使用者 2026-10-07）：電台多時線會很亂，可以關掉
  const linksBtn = $('map-links');
  const syncLinksBtn = () => linksBtn?.setAttribute('aria-pressed', String(linksOn));
  syncLinksBtn();
  function updateLinks() {
    if (!linksOn) return map.setLinks([]);
    return map.setLinks(js8Links ?? linksFromRows(lastRows, { myCall: getMyCall(), gridOf, approxLocate }));
  }
  linksBtn?.addEventListener('click', () => {
    linksOn = !linksOn;
    try {
      storage?.setItem(LINKS_KEY, linksOn ? '1' : '0');
    } catch {
      // 無痕模式等：只是下次不記得
    }
    syncLinksBtn();
    updateLinks();
  });
  const timer = setInterval(() => tracker.prune(now()), PRUNE_MS);
  const sceneTimer = setInterval(updateScene, SCENE_MS);

  return {
    map,
    tracker,
    onSlot(data) {
      tracker.addSlot(data, getMyCall());
      grids.learn(data.results);
    },
    // 右邊目前清單的列（{ text, snr, startUtc, own? }）；沒變就不重畫
    setRows(rows) {
      js8Links = null;
      const list = stationsFromRows(rows, getMyCall(), grids);
      const key = JSON.stringify(list);
      if (key === rowsKey) return;
      rowsKey = key;
      lastRows = rows;
      map.update(list);
      setSelected(keepSelection(selected, list)); // 清單清空或該台已不在清單：取消標示
      map.setRipples(rippleCalls(list, { slotMs: slotMs() }));
      updateLinks();
    },
    // JS8 模式（使用者 2026-10-07）：只畫通訊畫面目前顯示的對話裡的電台與指名連線
    setJs8(messages) {
      const { stations, links } = js8MapData(messages, { myCall: getMyCall(), myGrid: meGrid ?? '', gridOf, approxLocate });
      const key = `js8:${JSON.stringify(stations)}|${JSON.stringify(links.map((l) => `${l.from}>${l.to}@${l.utc}`))}`;
      if (key === rowsKey) return;
      rowsKey = key;
      js8Links = links;
      map.update(stations);
      setSelected(keepSelection(selected, stations));
      map.setRipples(rippleCalls(stations, { slotMs: 15000 }));
      updateLinks();
    },
    // 清單（解碼、呼叫、電台卡）左鍵選取的列（{ text, own? }）：標示發話方；我方發射的列、解析不出的不改變
    selectRow(row) {
      const call = selectionCall(row, getMyCall());
      if (call) setSelected(call);
    },
    setSelected,
    selected: () => selected,
    setMe(grid) {
      meGrid = grid || null;
      map.setMe(grid);
      updateScene();
    },
    setTarget(call) {
      targetCall = call || null;
      map.setTarget(call);
      updateScene();
    },
    noteTx(slotStart) {
      lastTxUtc = slotStart;
      updateScene();
    },
    setTileSource: (src) => map.setTileSource(src), // 設定頁改了線上地圖來源（add-map-tile-source）
    destroy() {
      clearInterval(timer);
      clearInterval(sceneTimer);
      map.destroy();
    },
  };
}

const NOTICE_MS = 6000;

// 2D／3D 繪製層切換＋地圖設定框（D3、D4）。可注入 createMap2d、loadGlobe（動態載入 globe.mjs）、doc、getEox，單元測試用假的
// tileSource：線上地圖來源（add-map-tile-source）；configureSource：交給 eoxsource 單例（換來源時清快取），單元測試注入假的
export function createRendererSwitch({ $, onPick, approxLocate, storage, locale, t, createMap2d = createMap, loadGlobe = () => import('./globe.mjs'), doc = document,
  getEox = eoxSource, peekEox = peekEoxSource, tileSource: initialSource = resolveTileSource({}), configureSource = configureTileSource }) {
  const canvas2d = $('map-canvas');
  const wrap = canvas2d.parentElement;
  const dialog = $('map-settings');
  const notice = $('map-notice');
  const attribution = $('map-attribution'); // EOX 規定的標示（add-map-eox-imagery D10）：選 eox 才顯示
  const typeLabel = $('map-type-eox-label'); // 設定框「衛星影像（Sentinel-2，線上）」選項的文字：自訂來源時改成「線上地圖（自訂來源）」
  let tileSource = initialSource;
  configureSource(tileSource);
  let eoxUnsub = null;
  let settings = loadMapSettings(storage);
  // 最後一次的資料：切換繪製層時重放
  const state = { me: undefined, stations: undefined, target: undefined, scene: undefined, links: undefined, ripples: undefined, selected: undefined };
  let resumeMs; // 測試縮短的「停手後恢復自動框住」時間：換繪製層也帶過去
  let active = null;
  let activeView = '2d';
  let globeCanvas = null;
  let overlay = null;
  let switching = 0; // 切換序號：連點 2D／3D 時只採用最後一次
  let noticeTimer = 0;
  let destroyed = false;
  let unavailable3d = false; // 沒有 WebGL（D18）：本次不再試，設定框的 3D 選項停用。網路錯誤（three.js 下載失敗）不算，下次切換再試

  const optionsOf = () => ({
    type: settings.type, borders: settings.borders, names: settings.names, daynight: settings.daynight,
    ...Object.fromEntries(OVERLAY_KEYS.map((k) => [k, settings[k]])), locale,
  });
  // 圖層開關的 checkbox id（index.html #map-settings）
  const OVERLAY_IDS = { grid: 'map-grid', cqZones: 'map-cqzones', ituZones: 'map-ituzones', states: 'map-states' };
  function replay(r) {
    r.setOptions(optionsOf());
    if (resumeMs !== undefined) r.setResumeMs?.(resumeMs);
    if (state.me !== undefined) r.setMe(state.me);
    if (state.target !== undefined) r.setTarget(state.target);
    if (state.stations !== undefined) r.update(state.stations);
    if (state.links !== undefined) r.setLinks(state.links);
    if (state.ripples !== undefined) r.setRipples(state.ripples);
    if (state.scene !== undefined) r.setScene(state.scene);
    if (state.selected !== undefined) r.setSelected?.(state.selected);
  }
  function showNotice(text) {
    if (!notice) return;
    notice.textContent = text;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, NOTICE_MS);
  }
  // 標示依來源（add-map-tile-source S8）：EOX 用原文＋連結（DOM 節點）；自訂來源只放純文字（字串＝文字節點，不解讀 HTML）
  function renderSource() {
    const a = tileSource.attribution;
    if (attribution?.replaceChildren) {
      if (a.href) {
        const link = doc.createElement('a');
        Object.assign(link, { href: a.href, target: '_blank', rel: 'noopener', textContent: a.href });
        attribution.replaceChildren(a.before, link, a.after);
      } else attribution.replaceChildren(a.text);
    }
    if (typeLabel) typeLabel.textContent = t(tileSource.custom ? 'mapui.typeCustom' : 'mapui.typeEox');
  }
  // 線上衛星圖磚（add-map-eox-imagery D10、D11）：選 eox 才建立來源並訂閱；連不上（down）時提示一次（繪製層自己退回向量圖）
  function syncEox() {
    const on = settings.type === 'eox';
    if (attribution) attribution.hidden = !on || !tileSource.attribution.text; // 自訂來源沒填出處：不顯示
    wrap.setAttribute?.('data-attribution', on ? 'eox' : ''); // 提示訊息往上移，不蓋標示
    if (on && !eoxUnsub) {
      const src = getEox();
      eoxUnsub = src.subscribe((kind) => {
        if (kind === 'status' && src.status === 'down') showNotice(t('mapui.eoxDown'));
      });
      if (src.status === 'down') showNotice(t('mapui.eoxDown'));
    } else if (!on) {
      eoxUnsub?.();
      eoxUnsub = null;
      peekEox()?.cancel(); // 切到其他底圖：排隊丟掉、進行中中止（沒建立過不建立）
    }
  }
  function removeGlobeCanvases() {
    globeCanvas?.remove();
    overlay?.remove();
    globeCanvas = overlay = null;
  }
  function use2d() {
    active?.destroy();
    removeGlobeCanvases();
    canvas2d.hidden = false;
    active = createMap2d({ canvas: canvas2d, onPick, onSettings: openSettings, approxLocate });
    activeView = '2d';
    replay(active);
  }
  async function use3d() {
    const seq = ++switching;
    // 載入期間先藏著（不擋 2D 的滑鼠、手勢）；建好才顯示
    const gc = doc.createElement('canvas');
    gc.id = 'map-globe';
    gc.className = 'map-globe';
    gc.hidden = true;
    gc.setAttribute('role', 'img');
    gc.setAttribute('aria-label', t('mapui.canvas3d'));
    const ov = doc.createElement('canvas');
    ov.id = 'map-globe-overlay';
    ov.className = 'map-globe-overlay';
    ov.hidden = true;
    ov.setAttribute('aria-hidden', 'true');
    wrap.insertBefore(ov, canvas2d.nextSibling);
    wrap.insertBefore(gc, ov);
    let globe = null;
    try {
      const { createGlobe } = await loadGlobe();
      if (seq !== switching || destroyed || settings.view !== '3d') throw new Error('stale');
      globe = await createGlobe({ canvas: gc, overlay: ov, onPick, onSettings: openSettings, approxLocate });
      if (seq !== switching || destroyed || settings.view !== '3d') throw new Error('stale');
    } catch (err) {
      globe?.destroy();
      gc.remove();
      ov.remove();
      if (seq !== switching || destroyed || err?.message === 'stale') return;
      const noWebgl = String(err?.message ?? '').startsWith('webgl-unavailable');
      console.warn(noWebgl ? '3D 地球無法使用（沒有 WebGL），改用 2D' : '3D 地球載入失敗，改用 2D', err);
      if (noWebgl) unavailable3d = true;
      syncDialog();
      showNotice(t(noWebgl ? 'mapui.no3d' : 'mapui.load3dFailed'));
      if (activeView !== '2d' || !active) use2d();
      return;
    }
    active?.destroy();
    removeGlobeCanvases();
    globeCanvas = gc;
    overlay = ov;
    canvas2d.hidden = true;
    gc.hidden = false;
    ov.hidden = false;
    active = globe;
    activeView = '3d';
    replay(active);
    globe.resize(); // 顯示後才量得到大小
  }
  function applyView() {
    if (settings.view === '3d' && !unavailable3d) {
      if (activeView !== '3d') {
        if (!active) use2d(); // 3D 載入期間先畫 2D
        else active.setOptions(optionsOf());
        use3d();
      } else active.setOptions(optionsOf());
    } else {
      ++switching;
      if (activeView !== '2d' || !active) use2d();
      else active.setOptions(optionsOf());
    }
  }

  // ── 設定框 ──
  function syncDialog() {
    if (!dialog) return;
    for (const el of dialog.querySelectorAll('input[name="map-type"]')) el.checked = el.value === settings.type;
    for (const el of dialog.querySelectorAll('input[name="map-view"]')) {
      el.checked = el.value === settings.view;
      if (el.value === '3d') el.disabled = unavailable3d;
    }
    const b = $('map-borders');
    const n = $('map-names');
    const dn = $('map-daynight');
    if (b) b.checked = settings.borders;
    if (n) n.checked = settings.names;
    if (dn) dn.checked = settings.daynight;
    for (const k of OVERLAY_KEYS) {
      const el = $(OVERLAY_IDS[k]);
      if (el) el.checked = settings[k];
    }
    const note = $('map-settings-note');
    if (note) note.textContent = unavailable3d ? t('mapui.no3d') : '';
  }
  function openSettings() {
    if (!dialog || dialog.open) return;
    syncDialog();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  function onChange() {
    const pick = (name) => dialog.querySelector(`input[name="${name}"]:checked`)?.value;
    settings = {
      type: pick('map-type') ?? settings.type, borders: Boolean($('map-borders')?.checked), names: Boolean($('map-names')?.checked),
      daynight: Boolean($('map-daynight')?.checked), view: pick('map-view') ?? settings.view,
      ...Object.fromEntries(OVERLAY_KEYS.map((k) => [k, Boolean($(OVERLAY_IDS[k])?.checked)])),
    };
    saveMapSettings(storage, settings);
    syncEox();
    applyView();
  }
  dialog?.addEventListener('change', onChange);
  $('map-settings-close')?.addEventListener('click', () => dialog.close());
  // 點對話框外面（backdrop）關閉（同瀑布圖調整）
  dialog?.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  const gear = $('map-settings-btn');
  if (gear) {
    gear.insertAdjacentHTML('afterbegin', icon('settings', 16));
    gear.addEventListener('click', openSettings);
  }

  renderSource();
  syncEox();
  use2d();
  if (settings.view === '3d') applyView();

  const remember = (key, fn) => (v) => {
    state[key] = v;
    fn(v);
  };
  return {
    setMe: remember('me', (v) => active.setMe(v)),
    update: remember('stations', (v) => active.update(v)),
    setTarget: remember('target', (v) => active.setTarget(v)),
    setScene: remember('scene', (v) => active.setScene(v)),
    setLinks: remember('links', (v) => active.setLinks(v)),
    setRipples: remember('ripples', (v) => active.setRipples(v)),
    setSelected: remember('selected', (v) => active.setSelected?.(v)),
    resize: () => active.resize(),
    fit: () => active.fit(),
    setResumeMs: (ms) => { // 測試用（ui-mapfly-check、ui-mapsettings-check）
      resumeMs = ms;
      active.setResumeMs?.(ms);
    },
    lookAt: (v) => active.lookAt?.(v), // 測試用（ui-mapoverlays-check：放大到台灣看向量圖）；同使用者手動移動
    openSettings,
    settings: () => ({ ...settings }),
    /** 換線上地圖來源（設定頁改了，add-map-tile-source S5、S8）：交給 eoxsource（清快取、2D／3D 重畫）、更新標示與選項名稱 */
    setTileSource(next) {
      if (!next?.key || next.key === tileSource.key && next.attribution?.text === tileSource.attribution.text) return;
      tileSource = next;
      configureSource(next);
      renderSource();
      syncEox();
    },
    tileSource: () => tileSource.key, // 測試用
    destroy() {
      destroyed = true;
      clearTimeout(noticeTimer);
      eoxUnsub?.();
      eoxUnsub = null;
      peekEox()?.cancel();
      active?.destroy();
      removeGlobeCanvases();
    },
    debug: () => ({ ...active.debug(), unavailable3d, globeCanvases: wrap.querySelectorAll?.('#map-globe').length ?? 0 }),
  };
}
