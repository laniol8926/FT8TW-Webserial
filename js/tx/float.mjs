// 發射訊息浮動視窗（使用者 2026-10-06）：預設在畫面中央，可拖曳；位置以「可移動範圍的比例」記住，
// 換視窗大小（手機轉向、桌機縮放）仍在相對位置，且一定留在畫面內。
const KEY = 'ft8tw.txfloat';
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// frac：{ x, y }，0～1 表示在可移動範圍（視窗減去視窗框大小）中的位置；null 表示置中
export function placeBox(frac, view, box) {
  const rangeX = Math.max(0, view.width - box.width);
  const rangeY = Math.max(0, view.height - box.height);
  const fx = frac ? clamp01(frac.x) : 0.5;
  const fy = frac ? clamp01(frac.y) : 0.5;
  return { left: Math.round(fx * rangeX), top: Math.round(fy * rangeY) };
}

export function toFraction({ left, top }, view, box) {
  const rangeX = Math.max(1, view.width - box.width);
  const rangeY = Math.max(1, view.height - box.height);
  return { x: clamp01(left / rangeX), y: clamp01(top / rangeY) };
}

export function loadFloatPos(storage) {
  try {
    const v = JSON.parse(storage.getItem(KEY) ?? 'null');
    return v && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
  } catch {
    return null;
  }
}

export function saveFloatPos(storage, frac) {
  try {
    storage.setItem(KEY, JSON.stringify(frac));
  } catch {
    // 無痕模式等：只是下次回到中央
  }
}

// 瀏覽器串接：讓 el 可用滑鼠／觸控拖曳，放開時記住位置；視窗大小改變時重新放置
export function initFloat(el, storage) {
  const view = () => ({ width: window.innerWidth, height: window.innerHeight });
  const size = () => ({ width: el.offsetWidth, height: el.offsetHeight });
  const place = () => {
    const { left, top } = placeBox(loadFloatPos(storage), view(), size());
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    drag = { dx: e.clientX - el.offsetLeft, dy: e.clientY - el.offsetTop };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const frac = toFraction({ left: e.clientX - drag.dx, top: e.clientY - drag.dy }, view(), size());
    const { left, top } = placeBox(frac, view(), size());
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    el.classList.remove('dragging');
    saveFloatPos(storage, toFraction({ left: el.offsetLeft, top: el.offsetTop }, view(), size()));
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  window.addEventListener('resize', place);
  return { place };
}
