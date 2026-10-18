// 右鍵（手機長按）選單的畫面（使用者 2026-10-06，同 FT8TW 長按選單）：項目由 menu.mjs 的 menuItems 決定。
// roots：要掛選單的容器（解碼清單、呼叫清單、電台卡）；resolve(target)：點到的那一列 → 訊息資料（{ text, snr, freqHz, startUtc, mode }）或 null；
// items(row)：選單項目；onAction(item, row)：執行。選單出現在游標位置（不超出畫面），點外面、捲動或按 Esc 關閉，可用方向鍵選。
export const LONG_PRESS_MS = 600;
const MOVE_TOLERANCE_PX = 10;

export function initContextMenu({ roots, resolve, items, onAction }) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(menu);
  let lastFocus = null;

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    lastFocus?.focus?.();
  }

  function open(row, x, y) {
    const list = items(row);
    if (!list.length) return false;
    lastFocus = document.activeElement;
    const title = Object.assign(document.createElement('div'), { className: 'ctx-title', textContent: row.text });
    menu.replaceChildren(title, ...list.map((it) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ctx-item', textContent: it.label });
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        close();
        onAction(it, row);
      });
      return b;
    }));
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - h - 4))}px`;
    menu.querySelector('.ctx-item')?.focus();
    return true;
  }

  for (const root of roots) {
    if (!root) continue;
    root.addEventListener('contextmenu', (e) => {
      const row = resolve(e.target);
      if (!row) return;
      e.preventDefault();
      open(row, e.clientX, e.clientY);
    });
    // 手機長按：開選單（不是直接呼叫，避免誤觸發射）；移動超過容許值（捲動）就取消
    let press = null;
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      const row = resolve(e.target);
      if (!row) return;
      clearTimeout(press?.timer);
      press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => { press = null; open(row, e.clientX, e.clientY); }, LONG_PRESS_MS) };
    });
    root.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE_PX) {
        clearTimeout(press.timer);
        press = null;
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      root.addEventListener(type, () => {
        clearTimeout(press?.timer);
        press = null;
      });
    }
  }

  document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) close(); }, true);
  document.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.querySelectorAll('.ctx-item')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === 'ArrowUp') buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else return;
    e.preventDefault();
  });
  return { open, close, element: menu };
}
