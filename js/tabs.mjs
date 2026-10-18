// 手機底部分頁（add-web-transmit 3.3、D18；web-phone-app-layout）：同 FT8TW 的解碼／呼叫／頻譜／通聯記錄／設置 5 個。
// 平板與桌機不用分頁，所有區塊依版面並排（CSS 決定）；分頁只在手機寬度生效。
// 手機上：接收狀態（status-panel）搬到設置首頁頂端、地圖改由浮動按鈕開全頁（phone-ui.mjs），所以不屬於任何分頁
import { t } from './i18n/index.mjs';
import { icon } from './icons.mjs';
const KEY = 'ft8tw.tab';

export const TABS = Object.freeze([
  { id: 'decode', label: t('page.tab.decode'), icon: 'list', sections: ['decodes-panel'] },
  // 呼叫：手機依設置「呼叫畫面使用電台卡（摩登）」顯示呼叫清單或電台卡（CSS 以 body.modern-calling 二選一）；
  // 通聯、發射區塊平常收起，工具列 ✎ 打開（phone.css）
  { id: 'call', label: t('page.tab.call'), icon: 'calling', sections: ['call-list-panel', 'station-panel', 'qso-panel', 'tx-panel'] },
  { id: 'spectrum', label: t('page.tab.spectrum'), icon: 'spectrum', sections: ['spectrum-panel'] },
  { id: 'log', label: t('page.tab.log'), icon: 'history', sections: ['log-panel'] },
  // 設置：原本的漢堡選單（#menu）整頁顯示，不在 main 裡
  { id: 'settings', label: t('page.tab.settings'), icon: 'settings', sections: [] },
]);

// JS8 模式（add-web-js8-chat D1）：分頁同上（同 App：JS8 通訊在「呼叫」的位置），呼叫頁換成 JS8 通訊畫面＋下方瀑布圖
export const JS8_TABS = Object.freeze(TABS.map((tab) => (tab.id === 'call' ? Object.freeze({ ...tab, sections: ['js8-chat-panel', 'spectrum-panel'] }) : tab)));

// JTTY 模式（add-web-jtty D10）：版面同 JS8，「呼叫」換成 JTTY 通訊畫面＋瀑布圖
export const JTTY_TABS = Object.freeze(TABS.map((tab) => (tab.id === 'call' ? Object.freeze({ ...tab, sections: ['jtty-chat-panel', 'spectrum-panel'] }) : tab)));

// 聊天模式的種類：JS8、JTTY 各自一套通訊畫面；其他（時槽模式）回 null
export function chatKind(mode) {
  return mode === 'JS8' || mode === 'JTTY' ? mode : null;
}

export function tabsFor(mode) {
  return { JS8: JS8_TABS, JTTY: JTTY_TABS }[chatKind(mode)] ?? TABS;
}

export function sectionsFor(tabId, mode) {
  const tabs = tabsFor(mode);
  return (tabs.find((t) => t.id === tabId) ?? tabs[0]).sections;
}

// 各分頁要顯示的手機元件（同 App）：浮動按鈕只在解碼／呼叫／頻譜頁；通聯控制列（→ 順序＋CQ）只在呼叫頁；
// JS8 通訊是沉浸式（浮動按鈕與底部分頁收起，返回鈕回解碼）
export function phoneFlags(tabId, mode) {
  const chat = chatKind(mode) !== null;
  const immersive = chat && tabId === 'call';
  return {
    fab: !immersive && ['decode', 'call', 'spectrum'].includes(tabId),
    qsoBar: !chat && tabId === 'call',
    immersive,
  };
}

// JS8、JTTY 與其他模式各記各的分頁：離開聊天模式回到原本的分頁
const keyFor = (base, mode) => (chatKind(mode) ? `${base}.${chatKind(mode).toLowerCase()}` : base);

// 預設：一般模式解碼頁、聊天模式通訊頁
export function loadTab(storage, mode) {
  const tabs = tabsFor(mode);
  const fallback = chatKind(mode) ? 'call' : tabs[0].id;
  try {
    const v = storage.getItem(keyFor(KEY, mode));
    return tabs.some((t) => t.id === v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveTab(storage, tabId, mode) {
  try {
    storage.setItem(keyFor(KEY, mode), tabId);
  } catch {
    // 無痕模式等：只是下次不記得
  }
}

// 瀏覽器串接：在 nav 產生分頁鈕，切換時對不屬於目前分頁的區塊加 data-tab-off（CSS 只在手機寬度隱藏它們）
export function initTabs({ nav, storage, onChange = () => {}, mode = 'FT8' }) {
  const all = [...new Set([...TABS, ...JS8_TABS, ...JTTY_TABS].flatMap((t) => t.sections))];
  let current;
  let buttons = [];
  nav.setAttribute('role', 'tablist');
  function build() {
    buttons = tabsFor(mode).map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.dataset.tab = t.id;
      b.setAttribute('role', 'tab');
      const ic = Object.assign(document.createElement('span'), { className: 'tab-icon', innerHTML: icon(t.icon) }); // 固定的 SVG（icons.mjs）
      ic.setAttribute('aria-hidden', 'true');
      b.append(ic, Object.assign(document.createElement('span'), { className: 'tab-label', textContent: t.label }));
      b.addEventListener('click', () => select(t.id));
      return b;
    });
    nav.replaceChildren(...buttons);
  }
  function select(id) {
    current = tabsFor(mode).some((t) => t.id === id) ? id : tabsFor(mode)[0].id;
    saveTab(storage, current, mode);
    const on = new Set(sectionsFor(current, mode));
    for (const sid of all) document.getElementById(sid)?.toggleAttribute('data-tab-off', !on.has(sid));
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.tab === current));
    onChange(current);
  }
  // 換模式：進聊天模式（JS8、JTTY）一律先看通訊畫面；離開還原原本的分頁。JS8 ↔ JTTY 直切也要重建
  function setMode(next) {
    const was = chatKind(mode);
    mode = next;
    if (was === chatKind(mode)) return;
    build();
    select(chatKind(mode) ? 'call' : loadTab(storage, mode));
  }
  build();
  select(loadTab(storage, mode));
  return { select, setMode, current: () => current, mode: () => mode };
}

// 平板與桌機右欄的列表切換（解碼／呼叫／通聯記錄）；手機用底部分頁，這組切換鈕不顯示
const LIST_KEY = 'ft8tw.listtab';
export const LIST_TABS = Object.freeze([
  { id: 'decode', label: t('page.tab.decode'), section: 'decodes-panel' },
  { id: 'call', label: t('page.tab.call'), section: 'call-list-panel' },
  { id: 'log', label: t('page.tab.log'), section: 'log-panel' },
  { id: 'station', label: t('page.tab.station'), section: 'station-panel' },
  { id: 'control', label: t('page.tab.control'), section: 'control-panel' },
]);

// JS8 模式：右欄換成 JS8 通訊畫面；解碼（原始 frame）與控制（開始／停止）仍可切換
export const JS8_LIST_TABS = Object.freeze([
  { id: 'js8', label: t('js8chat.tab'), section: 'js8-chat-panel' },
  { id: 'decode', label: t('page.tab.decode'), section: 'decodes-panel' },
  { id: 'control', label: t('page.tab.control'), section: 'control-panel' },
]);

// JTTY 模式：右欄換成 JTTY 通訊畫面；解碼（每個 frame 一列）與控制仍可切換
export const JTTY_LIST_TABS = Object.freeze([
  { id: 'jtty', label: t('jtty.tab'), section: 'jtty-chat-panel' },
  { id: 'decode', label: t('page.tab.decode'), section: 'decodes-panel' },
  { id: 'control', label: t('page.tab.control'), section: 'control-panel' },
]);

export function listTabsFor(mode) {
  return { JS8: JS8_LIST_TABS, JTTY: JTTY_LIST_TABS }[chatKind(mode)] ?? LIST_TABS;
}

export function loadListTabFor(storage, mode) {
  const tabs = listTabsFor(mode);
  try {
    const v = storage.getItem(keyFor(LIST_KEY, mode));
    return tabs.some((t) => t.id === v) ? v : tabs[0].id;
  } catch {
    return tabs[0].id;
  }
}

export function loadListTab(storage) {
  return loadListTabFor(storage, 'FT8');
}

export function initListTabs({ container, storage, onChange = () => {}, mode = 'FT8' }) {
  const allSections = [...new Set([...LIST_TABS, ...JS8_LIST_TABS, ...JTTY_LIST_TABS].map((t) => t.section))];
  let tabs = [];
  let buttons = [];
  let current;
  function build() {
    // 區塊還不存在的分頁（例如呼叫清單尚未加入）不顯示
    tabs = listTabsFor(mode).filter((t) => document.getElementById(t.section));
    buttons = tabs.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.dataset.tab = t.id;
      b.setAttribute('role', 'tab');
      b.textContent = t.label;
      b.addEventListener('click', () => select(t.id));
      return b;
    });
    container.replaceChildren(...buttons);
  }
  function select(id) {
    current = tabs.some((t) => t.id === id) ? id : tabs[0].id;
    try {
      storage.setItem(keyFor(LIST_KEY, mode), current);
    } catch {
      // 無痕模式等：只是下次不記得
    }
    const on = tabs.find((t) => t.id === current).section;
    for (const sec of allSections) document.getElementById(sec)?.toggleAttribute('data-list-off', sec !== on);
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.tab === current));
    onChange(current);
  }
  function setMode(next) {
    const was = chatKind(mode);
    mode = next;
    if (was === chatKind(mode)) return;
    build();
    select(chatKind(mode) ? listTabsFor(mode)[0].id : loadListTabFor(storage, mode));
  }
  build();
  select(loadListTabFor(storage, mode));
  return { select, setMode, current: () => current };
}
