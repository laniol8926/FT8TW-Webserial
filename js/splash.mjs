// 開場動畫（使用者 2026-10-09）：index.html 一開頭就顯示 FT8TW Logo 與「正在添加能源，準備出發…」能量條，
// 主程式初始化完成後補滿能量條、淡出並移除。樣式與 15 秒保險在 index.html 的 inline <style>／<script>（主程式沒載入也不會一直蓋著）。

export const SPLASH_MIN_MS = 900; // 從開頁算起至少顯示這麼久（快取載入很快時不要一閃而過）
export const SPLASH_FILL_MS = 250; // 能量條補滿
export const SPLASH_FADE_MS = 400; // 淡出（同 index.html 的 transition）

/** 還要等多久才開始補滿：開頁已過 elapsedMs */
export function splashDelay(elapsedMs, minMs = SPLASH_MIN_MS) {
  return Math.max(0, minMs - elapsedMs);
}

/** 結束開場動畫；沒有開場畫面或已在結束中回傳 false */
export function hideSplash({ doc = document, elapsedMs = performance.now(), setTimer = setTimeout } = {}) {
  const el = doc.getElementById('splash');
  if (!el || el.dataset.state) return false;
  setTimer(() => {
    el.dataset.state = 'full'; // 能量條補滿
    setTimer(() => {
      el.dataset.state = 'fade';
      setTimer(() => el.remove(), SPLASH_FADE_MS);
    }, SPLASH_FILL_MS);
  }, splashDelay(elapsedMs));
  el.dataset.state = 'done';
  return true;
}
