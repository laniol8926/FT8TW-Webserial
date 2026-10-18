// JTTY 字幕區（使用者 2026-10-09）：瀑布圖下方，每台電台一條跑馬燈，前面「■1012Hz」色塊＋頻率，
// 顏色同頻率尺的 ▼ 與瀑布圖的通道虛線（spectrum/waterfall.mjs setStations）。排程邏輯在 ticker.mjs，這裡只畫 DOM。
// 只在 JTTY 啟用（setActive）；顯示與否由 CSS（body.mode-jtty）決定。
// 動畫用 requestAnimationFrame，只在有字要顯示時跑；沒字要顯示時用 setTimeout 等淡出／移除；背景分頁不跑，回前景直接跳到最新。
// prefers-reduced-motion：不捲動，直接顯示到最後（靜態靠右）。
import { TickerModel, MAX_LANES_DESKTOP, MAX_LANES_PHONE } from './ticker.mjs';

export function initJttyTicker({ doc = document, waterfall = null, el = doc.getElementById('jtty-ticker') } = {}) {
  if (!el) return null;
  const win = doc.defaultView;
  const now = () => win.performance.now();
  const mq = (q) => (typeof win.matchMedia === 'function' ? win.matchMedia(q) : null);
  const phone = mq('(max-width: 599px)');
  const reduced = mq('(prefers-reduced-motion: reduce)');
  const model = new TickerModel({ maxLanes: phone?.matches ? MAX_LANES_PHONE : MAX_LANES_DESKTOP });
  const rows = new Map(); // lane key → { row, text, inner, dots, sig }
  let active = false;
  let raf = 0;
  let timer = 0;
  let stationsSig = '';

  function schedule() {
    if (raf || doc.hidden || !active) return;
    clearTimeout(timer);
    timer = 0;
    raf = win.requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    const t = now();
    const moving = model.advance(t, { instant: Boolean(reduced?.matches) });
    render(t);
    if (doc.hidden || !active) return;
    if (moving) schedule();
    else {
      const wait = model.nextDeadline(t);
      if (wait !== null) timer = setTimeout(schedule, wait + 20);
    }
  }

  function syncStations() {
    const list = model.stations();
    const sig = list.map((s) => `${s.freqHz}${s.color}`).join();
    if (sig === stationsSig) return;
    stationsSig = sig;
    waterfall?.setStations(list);
  }

  function makeRow(v) {
    const row = doc.createElement('div');
    row.className = 'tk-lane';
    const tag = doc.createElement('span');
    tag.className = 'tk-tag';
    const sw = doc.createElement('span');
    sw.className = 'tk-swatch';
    sw.setAttribute('aria-hidden', 'true');
    const hz = doc.createElement('span');
    hz.className = 'tk-hz';
    tag.append(sw, hz);
    const text = doc.createElement('span');
    text.className = 'tk-text';
    const inner = doc.createElement('span');
    inner.className = 'tk-inner';
    text.append(inner);
    const dots = doc.createElement('span');
    dots.className = 'tk-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.textContent = '…';
    row.append(tag, text, dots);
    const r = { row, sw, hz, inner, dots, sig: '' };
    rows.set(v.key, r);
    return r;
  }

  function render(t) {
    const views = model.view(t);
    const keep = new Set(views.map((v) => v.key));
    for (const [key, r] of rows) {
      if (!keep.has(key)) {
        r.row.remove();
        rows.delete(key);
      }
    }
    views.forEach((v, i) => {
      const r = rows.get(v.key) ?? makeRow(v);
      if (el.children[i] !== r.row) el.insertBefore(r.row, el.children[i] ?? null);
      r.row.style.setProperty('--tk-color', v.color);
      r.row.dataset.freq = String(v.freqHz);
      r.row.classList.toggle('fading', v.fading);
      r.row.classList.toggle('receiving', v.receiving);
      r.hz.textContent = `${v.freqHz}Hz`;
      const sig = v.spans.map((s) => `${s.cls}\u0001${s.text}`).join('\u0002');
      if (sig !== r.sig) {
        r.sig = sig;
        r.inner.replaceChildren(...v.spans.map((s) => {
          const span = doc.createElement('span');
          if (s.cls) span.className = `tk-${s.cls}`;
          span.textContent = s.text;
          return span;
        }));
      }
      // 最新一個字從右邊滑進來（字幕用等寬字，1ch＝一個字寬）
      r.inner.style.transform = v.frac > 0.001 ? `translateX(${v.frac.toFixed(3)}ch)` : '';
    });
    syncStations();
  }

  const onVisibility = () => {
    if (!doc.hidden) schedule(); // advance 看到間隔太久會直接跳到最新
  };
  doc.addEventListener('visibilitychange', onVisibility);
  phone?.addEventListener?.('change', () => {
    model.setMaxLanes(phone.matches ? MAX_LANES_PHONE : MAX_LANES_DESKTOP);
    render(now());
    schedule();
  });
  reduced?.addEventListener?.('change', schedule);

  function clear() {
    model.clear();
    if (raf) win.cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = 0;
    render(now());
  }

  return {
    model,
    // 組合器快照（JttyReceiver onMessage）
    onMessage(snap) {
      if (!active) return;
      if (!model.update(snap, now())) return;
      syncStations();
      schedule();
    },
    // JTTY 模式才啟用；離開就清空（瀑布圖的 ▼、虛線一起拿掉）
    setActive(on) {
      if (Boolean(on) === active) return;
      active = Boolean(on);
      if (!active) clear();
    },
    // 換頻率：接收中的訊息屬於舊頻率
    clear,
  };
}
