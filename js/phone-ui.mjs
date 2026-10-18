// 手機版面比照 S20 App（web-phone-app-layout，計畫 15-01）的瀏覽器串接：每頁工具列、右側浮動按鈕、地圖全頁、
// 設置分頁（原本的抽屜整頁顯示）、接收狀態搬到設置首頁。只在手機寬度（< 600px）生效：版面在 phone.css，
// 這裡的狀態都寫在 body（data-ptab、p-*），平板／桌機的 CSS 不看它們；切回寬畫面時把搬過的區塊放回原位、抽屜關回去。
// 文字規則在 phonebar.mjs、分頁規則在 tabs.mjs（純函式，有單元測試）；本模組以真瀏覽器檢查（tools/ui-phone-check.mjs）驗證。
import { icon } from './icons.mjs';
import { phoneFlags } from './tabs.mjs';
import { callBar, countText, decodeBar, modeBadge, utcText } from './phonebar.mjs';

export const PHONE_QUERY = '(max-width: 599px)';

// tabs()：底部分頁（initTabs 的結果，晚一點才建立）；getState()：工具列要的資料（main.mjs 提供）；
// setMode(mode)：切換模式（同狀態列的模式下拉）
export function initPhoneUi({ tabs, getState, setMode, matchMedia = globalThis.matchMedia?.bind(globalThis) }) {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const mq = matchMedia?.(PHONE_QUERY) ?? { matches: false, addEventListener() {} };
  const menu = $('menu');
  let tab = 'decode';
  let lastLine = null; // 狀態列最後一次的週期與 UTC（切分頁、切寬度時立刻重畫工具列）

  const setIcon = (el, name) => {
    if (el.dataset.iconNow === name) return;
    el.dataset.iconNow = name;
    el.innerHTML = icon(name); // 固定的 SVG（icons.mjs）
  };
  for (const el of document.querySelectorAll('[data-icon]')) setIcon(el, el.dataset.icon);

  // ── 手機才搬的區塊：接收狀態到設置首頁頂端、「請點一下」提示到解碼清單上方；寬畫面放回原位 ──
  const moves = [
    { el: $('status-panel'), to: () => menu.querySelector('.drawer-head').nextSibling, parent: menu },
    { el: $('tap-to-start'), to: () => $('decodes-panel').querySelector('.table-wrap'), parent: $('decodes-panel') },
  ].filter((m) => m.el);
  for (const m of moves) m.home = m.el.parentNode.insertBefore(document.createComment(m.el.id), m.el);
  function relocate(phone) {
    for (const m of moves) {
      if (phone) m.parent.insertBefore(m.el, m.to());
      else m.home.parentNode.insertBefore(m.el, m.home);
    }
  }

  // 設置分頁＝抽屜整頁顯示（不設 inert、不開背景遮罩）；只在手機寬度
  function syncMenu() {
    if (mq.matches) menu.hidden = tab !== 'settings';
  }

  function onTab(id, mode = tabs()?.mode?.() ?? 'FT8') {
    tab = id;
    body.dataset.ptab = id;
    const f = phoneFlags(id, mode);
    body.classList.toggle('p-fab', f.fab);
    body.classList.toggle('p-qsobar', f.qsoBar);
    body.classList.toggle('p-immersive', f.immersive);
    if (id !== 'call') setSheet(false);
    closeModeMenu();
    syncMenu();
    update();
  }

  function onMedia() {
    relocate(mq.matches);
    if (mq.matches) {
      // 寬畫面開著的抽屜：改成設置分頁（背景不再 inert、不要遮罩）
      // 不論目前分頁是哪個都要清背景 inert（code review：原本 tab 已是 settings 時會留著 inert，回解碼頁整個點不動）
      if (!menu.hidden) {
        for (const el of [document.querySelector('main'), document.querySelector('header')]) if (el) el.inert = false;
        $('menu-backdrop').hidden = true;
        $('menu-toggle').setAttribute('aria-expanded', 'false');
        if (tab !== 'settings') tabs()?.select('settings');
      }
      syncMenu();
      update();
    } else {
      body.classList.remove('p-map', 'p-sheet');
      if (tab === 'settings') menu.hidden = true; // 手機設置頁切到寬畫面：抽屜關回去
    }
  }
  mq.addEventListener('change', onMedia);
  onMedia();

  // ── 工具列鈕：沿用原本的按鈕（同一條路徑） ──
  $('pbar-decode-clear').addEventListener('click', () => $('decodes-clear').click());
  $('pbar-call-clear').addEventListener('click', () => $('call-list-clear').click());
  $('pbar-rx').addEventListener('click', () => (getState().running ? $('stop') : $('start')).click());
  $('pbar-tx').addEventListener('click', () => $('strip-tx').click());
  function setSheet(open) {
    body.classList.toggle('p-sheet', open);
    $('pbar-edit').setAttribute('aria-expanded', String(open));
  }
  $('pbar-edit').addEventListener('click', () => setSheet(!body.classList.contains('p-sheet')));

  // ── 浮動按鈕 ──
  $('fab-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => $('fab-full').setAttribute('aria-pressed', String(Boolean(document.fullscreenElement))));
  const modeMenu = $('fab-mode-menu');
  function closeModeMenu() {
    modeMenu.hidden = true;
    $('fab-mode').setAttribute('aria-expanded', 'false');
  }
  $('fab-mode').addEventListener('click', () => {
    const open = modeMenu.hidden;
    const mode = getState().mode;
    for (const b of modeMenu.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    modeMenu.hidden = !open;
    $('fab-mode').setAttribute('aria-expanded', String(open));
    if (open) modeMenu.querySelector('[aria-checked="true"]')?.focus();
  });
  modeMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    closeModeMenu();
    setMode(b.dataset.mode);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!modeMenu.hidden && !e.target.closest('#fab-mode, #fab-mode-menu')) closeModeMenu();
  });
  const setMap = (open) => body.classList.toggle('p-map', open);
  $('fab-map').addEventListener('click', () => setMap(true));
  $('map-back').addEventListener('click', () => setMap(false));
  // JS8 通訊（App 的 JS8 浮動鈕）：切到 JS8 模式就會進通訊頁（tabs.setMode）；已在 JS8 時直接開
  $('fab-js8').addEventListener('click', () => {
    if (getState().mode === 'JS8') tabs().select('call');
    else setMode('JS8');
  });
  $('js8-back').addEventListener('click', () => tabs().select('decode'));
  $('jtty-back')?.addEventListener('click', () => tabs().select('decode')); // JTTY 通訊（add-web-jtty D10）同 JS8
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!modeMenu.hidden) closeModeMenu();
    else if (body.classList.contains('p-map')) setMap(false);
  });

  // ── 工具列文字：每秒（狀態列更新時）與解碼後 ──
  // function 宣告（hoist）：手機寬度直接載入時，onMedia() 在這之前就會呼叫 update()
  function text(el, s) { if (el && el.textContent !== s) el.textContent = s; }
  function update(line = lastLine) {
    lastLine = line;
    if (!mq.matches) return; // 寬畫面看不到，不必更新
    const s = getState();
    const d = decodeBar({ recentDt: s.recentDt, decodeMs: s.decodeMs, grid: s.grid });
    const c = callBar({ target: s.target, cycle: line?.cycle, audioHz: s.audioHz });
    text($('pbar-offset'), d.offset);
    text($('pbar-decode-ms'), d.decode);
    text($('pbar-grid'), d.grid);
    text($('pbar-target'), c.target);
    text($('pbar-cycle'), c.cycle);
    text($('pbar-freq'), c.freq);
    for (const el of document.querySelectorAll('.pbar-utc')) text(el, utcText(line?.utc ?? '--:--:--'));
    for (const el of document.querySelectorAll('.pbar-badge')) text(el, modeBadge(s.mode));
    $('pbar-rx').setAttribute('aria-pressed', String(s.running));
    setIcon($('pbar-rx'), s.running ? 'mic' : 'micOff');
    $('pbar-tx').setAttribute('aria-pressed', String(s.txActive));
    setIcon($('pbar-tx'), s.txActive ? 'tx' : 'txOff');
    const heads = document.querySelectorAll('.colhead-n');
    text(heads[0], countText(s.lastSlotRows, [...$('decodes').rows].filter((tr) => !tr.hidden).length)); // 只算目前模式的列
    text(heads[1], `(${$('call-list').rows.length})`);
  }

  // 設置頁要不要接手 menu.open()（例如摘要列、其他區塊叫出設置）：手機改成切到設置分頁
  const asPage = () => mq.matches;
  return { onTab, update, asPage, isPhone: () => mq.matches };
}
