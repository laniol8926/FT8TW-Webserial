// JS8 對話區的畫面（add-web-js8-chat js8-chat spec「對話泡泡」）：泡泡、日期分隔、接收中跑點、長按／右鍵選單。
// 顯示文字由 model.mjs 的純函式決定；這裡只負責 DOM 與捲動。選單沿用解碼清單的 initContextMenu（長按不直接發射）。
import { bubbleMeta, bubbleText, withDaySeparators } from './model.mjs';
import { initContextMenu } from '../qso/contextmenu.mjs';
import { emptyState } from '../radar.mjs';
import { createRadar } from '../radar-ui.mjs';

const NEAR_BOTTOM_PX = 48;

// list：<ol>；timeOpts()：{ local }；menuItems(msg) → [{ label, ... }]；onMenu(item, msg)
// emptyInfo()：{ running, station }，沒有泡泡時對話區正中顯示雷達＋說明（使用者 2026-10-09，JS8、JTTY 共用）
export function createChatView({ list, timeOpts = () => ({ local: false }), menuItems = () => [], onMenu = () => {}, emptyInfo = () => ({}) }) {
  const byEl = new WeakMap();
  let messages = [];
  const radar = createRadar({ tag: 'li' });
  const updateEmpty = () => radar.set(emptyState({ ...emptyInfo(), shown: messages.length }));

  initContextMenu({
    roots: [list],
    resolve: (target) => {
      const li = target.closest?.('.js8c-msg');
      return li ? byEl.get(li) ?? null : null;
    },
    items: (m) => menuItems(m),
    onAction: (item, m) => onMenu(item, m),
  });

  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX;
  }

  function bubble(m, opts, now) {
    const li = document.createElement('li');
    const body = bubbleText(m, now);
    li.className = `js8c-msg ${m.dir === 'tx' ? 'tx' : 'rx'}${body.dim ? ' dim' : ''}${body.live ? ' live' : ''}`;
    li.dataset.id = m.id;
    const meta = Object.assign(document.createElement('div'), { className: 'js8c-meta', textContent: bubbleMeta(m, opts) });
    const text = Object.assign(document.createElement('div'), { className: 'js8c-bubble', textContent: body.text });
    text.setAttribute('translate', 'no');
    li.append(meta, text);
    byEl.set(li, m);
    return li;
  }

  // 重畫整份清單（最多 500 則，夠快）；使用者往上捲在看舊訊息時不跳到底
  function render(next, now = Date.now()) {
    messages = next;
    const follow = nearBottom();
    const opts = timeOpts();
    const items = withDaySeparators(messages, opts).map((it) => {
      if (it.type === 'msg') return bubble(it.m, opts, now);
      const li = Object.assign(document.createElement('li'), { className: 'js8c-day', textContent: it.text });
      li.setAttribute('aria-hidden', 'true');
      return li;
    });
    list.replaceChildren(...items, ...(items.length ? [] : [radar.el])); // 沒有泡泡：雷達（<ol> 不再是 :empty，舊提示跟著藏）
    updateEmpty();
    if (follow) list.scrollTop = list.scrollHeight;
  }

  // 接收中泡泡的「.」「..」「...」動畫（每 400 ms 呼叫即可）
  function tick(now = Date.now()) {
    if (!messages.length) updateEmpty(); // 開始／停止接收時說明跟著換
    for (const li of list.querySelectorAll('.js8c-msg.live')) {
      const m = byEl.get(li);
      if (m) li.querySelector('.js8c-bubble').textContent = bubbleText(m, now).text;
    }
  }

  return { render, tick, scrollToEnd: () => { list.scrollTop = list.scrollHeight; }, messages: () => messages };
}
