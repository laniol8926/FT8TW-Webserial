// 空清單雷達的 DOM（規則在 radar.mjs，動畫與配色在 cards.css .radar-empty）。
// 雷達只用明暗、不用色相（使用者是紅綠色盲）；掃描是 CSS 動畫，元素 hidden（display: none）時瀏覽器不畫也不跑。
import { emptyText } from './radar.mjs';

// tag：外框元素（清單用 div，對話區的 <ol> 裡用 li）。回傳 { el, set(state) }：state＝emptyState() 的結果，null 隱藏
export function createRadar({ tag = 'div' } = {}) {
  const el = document.createElement(tag);
  el.className = 'radar-empty';
  el.hidden = true;
  el.setAttribute('role', 'status');
  const radar = document.createElement('div');
  radar.className = 'radar';
  radar.setAttribute('aria-hidden', 'true');
  const text = document.createElement('p');
  text.className = 'radar-text';
  el.append(radar, text);
  let last = '';
  return {
    el,
    set(state) {
      el.hidden = !state;
      const s = emptyText(state);
      if (s !== last) text.textContent = last = s; // 沒變不動 DOM（每秒更新、報讀軟體不重複唸）
    },
  };
}
