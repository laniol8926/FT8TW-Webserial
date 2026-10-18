// 版面互動：主頁的設定摘要列、左上角選單（抽屜＝設置頁，見 config/ui.mjs）。
import { t } from './i18n/index.mjs';

// 摘要列的各欄（add-rig-meters M1：結構化，各欄一個 span）：[呼號, 網格]。
// 波段與模式不在這裡（add-web-frequency-list）：後面接模式下拉 #mode-select 與頻率下拉 #freq-select（使用者 2026-10-09：模式移到頻率左邊）
export function summaryParts({ callsign, grid }) {
  return [callsign || t('page.summary.no_callsign'), grid || t('page.summary.no_grid')];
}

export function settingsSummary(settings) {
  return summaryParts(settings).join(' · ');
}

// 把摘要寫進元素：各欄 span，中間 ' · '（textContent 與 settingsSummary 相同）；內容沒變不動 DOM
export function renderSummary(el, settings) {
  const parts = summaryParts(settings);
  const spans = el.querySelectorAll(':scope > span');
  if (spans.length === parts.length && parts.every((p, i) => spans[i].textContent === p)) return;
  el.replaceChildren(...parts.flatMap((p, i) => {
    const s = document.createElement('span');
    s.textContent = p;
    return i ? [' · ', s] : [s];
  }));
}

// 左側抽屜選單：Esc 或點背景關閉；開啟時焦點移到關閉鈕，關閉後回到漢堡鈕。
// 開啟時把 background（頁面其餘部分）設為 inert，鍵盤 Tab 不會跑到被背景遮住的按鈕上。
// asPage()：手機寬度時設置是底部分頁的一頁（web-phone-app-layout）——開啟改呼叫 openPage()，Esc 不關
export function initMenu({ toggle, drawer, backdrop, closeButton, background = [], asPage = () => false, openPage = () => {} }) {
  function setOpen(open) {
    if (asPage()) {
      if (open) openPage();
      return;
    }
    drawer.hidden = !open;
    backdrop.hidden = !open;
    for (const el of background) el.inert = open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) closeButton.focus();
    else toggle.focus();
  }
  toggle.addEventListener('click', () => setOpen(drawer.hidden));
  closeButton.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden) setOpen(false);
  });
  return { open: () => setOpen(true), close: () => setOpen(false) };
}
