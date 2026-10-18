// 免責宣告（使用者 2026-10-08）：連入時以對話框蓋住全頁，按「我同意」才能繼續；Esc／點外面都關不掉。
// 同意記在這個瀏覽器（localStorage，依版本）：宣告內容改了就把 DISCLAIMER_VERSION 加一，所有人重新同意。
export const DISCLAIMER_KEY = 'ft8tw.disclaimer';
export const DISCLAIMER_VERSION = 1;

export function needsDisclaimer(storage) {
  try {
    const v = JSON.parse(storage?.getItem(DISCLAIMER_KEY) ?? 'null');
    return v?.v !== DISCLAIMER_VERSION;
  } catch {
    return true; // 壞資料、儲存空間不能用：照樣顯示
  }
}

export function acceptDisclaimer(storage, now = Date.now) {
  try {
    storage?.setItem(DISCLAIMER_KEY, JSON.stringify({ v: DISCLAIMER_VERSION, at: now() }));
  } catch {
    // 私密模式等存不了：這次照樣放行，下次再問
  }
}

/** 需要時顯示宣告，回傳「已同意」的 Promise（已同意過立即 resolve）。dialog：#disclaimer（<dialog>）、button：#disclaimer-agree */
export function requireDisclaimer({ storage, dialog, button }) {
  // 自動化瀏覽器檢查（tools/cdp.mjs 在每頁載入前設這個旗標）：不擋，免得每支檢查都要先點同意
  if (globalThis.__ft8twSkipDisclaimer === true || !needsDisclaimer(storage)) return Promise.resolve();
  return new Promise((resolve) => {
    let agreed = false;
    dialog.addEventListener('cancel', (e) => e.preventDefault()); // Esc 關不掉
    // Chrome 在使用者還沒互動時，Esc 的 cancel 擋不住（CloseWatcher）：沒同意就關掉的話立刻再打開
    dialog.addEventListener('close', () => { if (!agreed) dialog.showModal(); });
    button.addEventListener('click', () => {
      agreed = true;
      acceptDisclaimer(storage);
      dialog.close();
      resolve();
    }, { once: true });
    dialog.showModal();
    button.focus();
  });
}
