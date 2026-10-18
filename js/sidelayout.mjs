// 左欄頻譜／地圖的高度與收折（使用者 2026-10-07：可以調整高度，或直接收折起來）。
// 純函式（設定存取、比例換算）有單元測試；initSideLayout 是 DOM 接線（拖曳分隔線、鍵盤、收折鈕）。
// fraction＝頻譜占兩塊合計高度的比例（預設 0.6，同原本 3:2）；畫布大小由各自的 ResizeObserver 跟著變。
// width＝左欄占 main.layout 內容寬度的比例（使用者 2026-10-10：左右畫面的寬度也可以拉動調整，並且記憶位置）；
// null＝沒拖過，用 app.css 的預設（600–1023 px 40%、≥1024 px minmax(380px, 42%)）。手機（<600 px）沒有左右欄，不生效。

const KEY = 'ft8tw.sidelayout';
export const MIN_FRACTION = 0.15;
export const MAX_FRACTION = 0.85;
export const DEFAULT_LAYOUT = Object.freeze({ fraction: 0.6, spectrumCollapsed: false, mapCollapsed: false, width: null });
const STEP = 0.05;
export const MIN_LEFT_PX = 300; // 左欄（頻譜＋地圖）最窄
export const MIN_RIGHT_PX = 420; // 右欄（清單）最窄；兩者放不下時右欄優先

const round = (x) => Math.round(x * 1e6) / 1e6; // 0.6-0.05 這類浮點誤差

export function clampFraction(f) {
  if (!Number.isFinite(f)) return DEFAULT_LAYOUT.fraction;
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, f));
}

export function loadSideLayout(storage) {
  try {
    const v = JSON.parse(storage.getItem(KEY) ?? 'null');
    if (!v || typeof v !== 'object') return { ...DEFAULT_LAYOUT };
    const width = typeof v.width === 'number' && v.width > 0 && v.width < 1 ? v.width : null; // 舊設定沒有 width：用預設
    return { fraction: clampFraction(Number(v.fraction)), spectrumCollapsed: v.spectrumCollapsed === true, mapCollapsed: v.mapCollapsed === true, width };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveSideLayout(storage, layout) {
  try {
    storage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // 無痕模式等：只是下次不記得
  }
}

// 拖曳：指標 y（視窗座標）、兩塊合計區域的 top 與總高（含分隔線）、分隔線高度 → 頻譜比例
export function fractionFromPointer({ y, top, total, splitter }) {
  const usable = total - splitter;
  if (!(usable > 0)) return DEFAULT_LAYOUT.fraction;
  return clampFraction((y - top - splitter / 2) / usable);
}

// 鍵盤（分隔線有焦點時）：上下 5%、Home／End 到底；其他鍵回 null
export function stepFraction(f, key) {
  if (key === 'ArrowUp') return round(clampFraction(f - STEP));
  if (key === 'ArrowDown') return round(clampFraction(f + STEP));
  if (key === 'Home') return MIN_FRACTION;
  if (key === 'End') return MAX_FRACTION;
  return null;
}

// 左欄比例夾在「左欄 ≥ 300 px」與「右欄 ≥ 420 px」之間（total＝main.layout 內容寬、gap＝中間分隔線欄寬）。
// 兩者放不下（視窗窄）時右欄優先，不讓清單被擠掉。w＝null（沒拖過）或量不到寬度時回 null＝用 CSS 預設。
// 放得下「左欄最窄＋右欄最窄」才可調；放不下（窄平板）時分隔線隱藏、用 CSS 預設寬度、不改存檔，視窗放寬回來恢復拖過的比例
export function widthAdjustable({ total, gap = 0 }) {
  return total > 0 && total - gap >= MIN_LEFT_PX + MIN_RIGHT_PX;
}

export function clampWidth(w, { total, gap }) {
  if (w === null || !Number.isFinite(w) || !(total > 0)) return null;
  const lo = MIN_LEFT_PX / total;
  const hi = Math.max(0, (total - gap - MIN_RIGHT_PX) / total);
  return Math.min(hi, Math.max(lo, w));
}

// 拖曳：指標 x（視窗座標）、內容區左緣 left → 左欄比例（指標在分隔線中間）
export function widthFromPointer({ x, left, total, gap }) {
  if (!(total > 0)) return null;
  return clampWidth((x - left - gap / 2) / total, { total, gap });
}

// 鍵盤：左右方向鍵 5%、Home 還原預設（null）；其他鍵回 undefined（不處理）
export function stepWidth(w, key, geom) {
  if (key === 'ArrowLeft') return clampWidth(round(w - STEP), geom);
  if (key === 'ArrowRight') return clampWidth(round(w + STEP), geom);
  if (key === 'Home') return null;
  return undefined;
}

// ── DOM 接線 ──
// main／colSplitter：左右欄之間的直分隔線（沒給就不接，例如舊的測試頁）
export function initSideLayout({ storage, side, spectrum, map, splitter, spectrumToggle, mapToggle, main = null, colSplitter = null }) {
  let layout = loadSideLayout(storage);
  const cols = main && colSplitter ? initColumns() : null;
  function apply() {
    cols?.apply();
    // 另一塊收起來時占滿（flex-grow 合計小於 1 時只會分到那個比例的剩餘空間）
    side.style.setProperty('--spec-grow', String(layout.mapCollapsed ? 1 : layout.fraction));
    side.style.setProperty('--map-grow', String(layout.spectrumCollapsed ? 1 : 1 - layout.fraction));
    spectrum.classList.toggle('collapsed', layout.spectrumCollapsed);
    map.classList.toggle('collapsed', layout.mapCollapsed);
    spectrumToggle.setAttribute('aria-expanded', String(!layout.spectrumCollapsed));
    mapToggle.setAttribute('aria-expanded', String(!layout.mapCollapsed));
    splitter.hidden = layout.spectrumCollapsed || layout.mapCollapsed; // 有一塊收起來時另一塊占滿，不需要分隔線
    splitter.setAttribute('aria-valuenow', String(Math.round(layout.fraction * 100)));
    window.dispatchEvent(new Event('resize')); // 讓畫布跟著重算（ResizeObserver 之外的保險）
  }
  function set(next) {
    layout = { ...layout, ...next };
    saveSideLayout(storage, layout);
    apply();
  }
  spectrumToggle.addEventListener('click', () => set({ spectrumCollapsed: !layout.spectrumCollapsed }));
  mapToggle.addEventListener('click', () => set({ mapCollapsed: !layout.mapCollapsed }));

  // 拖曳：pointer capture，滑鼠與觸控同一套
  let dragging = false;
  function area() {
    const a = spectrum.getBoundingClientRect();
    const b = map.getBoundingClientRect();
    return { top: a.top, total: b.bottom - a.top, splitter: splitter.getBoundingClientRect().height };
  }
  splitter.addEventListener('pointerdown', (e) => {
    dragging = true;
    splitter.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    layout = { ...layout, fraction: fractionFromPointer({ y: e.clientY, ...area() }) };
    apply();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    saveSideLayout(storage, layout);
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('dblclick', () => set({ fraction: DEFAULT_LAYOUT.fraction }));
  splitter.addEventListener('keydown', (e) => {
    const f = stepFraction(layout.fraction, e.key);
    if (f === null) return;
    e.preventDefault();
    set({ fraction: f });
  });
  apply();
  return { get: () => ({ ...layout }) };

  // ── 左右欄寬度：直分隔線（拖曳、方向鍵、雙擊／Home 還原）；main.layout 的 --side-w 改 grid 左欄寬（app.css） ──
  function initColumns() {
    function geom() {
      const cs = getComputedStyle(main);
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      return { left: main.getBoundingClientRect().left + main.clientLeft + pl, total: main.clientWidth - pl - pr, gap: colSplitter.getBoundingClientRect().width };
    }
    // 存的是使用者拖的比例；視窗變窄時只是畫面夾住，不改存檔（視窗放寬回來就恢復）
    function applyCols() {
      const g = geom();
      const ok = widthAdjustable(g);
      // 隱藏但保留欄位（分隔線占一欄，display:none 會讓右欄錯位）；不能拖、不能 Tab 到
      colSplitter.classList.toggle('col-split-off', !ok);
      colSplitter.tabIndex = ok ? 0 : -1;
      colSplitter.setAttribute('aria-hidden', String(!ok));
      const w = ok ? clampWidth(layout.width, g) : null;
      if (w === null) main.style.removeProperty('--side-w');
      else main.style.setProperty('--side-w', `${w * 100}%`);
      const now = w ?? (g.total > 0 ? side.getBoundingClientRect().width / g.total : 0);
      colSplitter.setAttribute('aria-valuenow', String(Math.round(now * 100)));
      colSplitter.setAttribute('aria-valuemin', String(Math.round((clampWidth(0, g) ?? 0) * 100)));
      colSplitter.setAttribute('aria-valuemax', String(Math.round((clampWidth(1, g) ?? 1) * 100)));
      return now;
    }
    function setWidth(width) {
      layout = { ...layout, width };
      saveSideLayout(storage, layout);
      applyCols();
    }
    let drag = false;
    colSplitter.addEventListener('pointerdown', (e) => {
      if (!widthAdjustable(geom())) return;
      drag = true;
      colSplitter.setPointerCapture(e.pointerId);
      document.body.classList.add('col-dragging');
      e.preventDefault();
    });
    colSplitter.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const w = widthFromPointer({ x: e.clientX, ...geom() });
      if (w === null) return;
      layout = { ...layout, width: w };
      applyCols(); // 頻譜、瀑布圖、地圖的 ResizeObserver 會跟著重畫
    });
    const end = () => {
      if (!drag) return;
      drag = false;
      document.body.classList.remove('col-dragging');
      saveSideLayout(storage, layout);
    };
    colSplitter.addEventListener('pointerup', end);
    colSplitter.addEventListener('pointercancel', end);
    colSplitter.addEventListener('dblclick', () => { if (widthAdjustable(geom())) setWidth(null); });
    colSplitter.addEventListener('keydown', (e) => {
      const g = geom();
      if (!widthAdjustable(g)) return;
      const w = stepWidth(clampWidth(layout.width, g) ?? applyCols(), e.key, g);
      if (w === undefined) return;
      e.preventDefault();
      setWidth(w);
    });
    // 視窗縮放：重新夾住（不存檔）。main.layout 自己的大小不受 --side-w 影響，不會循環
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => applyCols()).observe(main);
    return { apply: applyCols };
  }
}
