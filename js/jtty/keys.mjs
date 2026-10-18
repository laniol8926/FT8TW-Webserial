// JTTY 鍵盤（add-web-jtty design D11）：巨集只用畫面上的按鈕 1～8，不設快速鍵（使用者 2026-10-09：不要 F1～F8，也不用數字鍵）；
// 只攔 Esc（發射中停止）；
// 輸入框內 Enter＝送出（Shift＋Enter 照常換行）。只決定動作，DOM 由 jtty/ui.mjs 處理。

// e：KeyboardEvent 的 { key, ctrlKey, altKey, metaKey, shiftKey, isComposing }
// ctx：{ active（JTTY 模式）, dialogOpen（有對話框開著）, busy（發射中）, inInput（焦點在 JTTY 輸入框） }
// 回 { stop: true } | { send: true } | null
export function jttyKeyAction(e, { active, dialogOpen = false, busy = false, inInput = false } = {}) {
  if (!active || dialogOpen || e.isComposing) return null; // 輸入法組字中的 Enter 是選字
  if (e.ctrlKey || e.altKey || e.metaKey) return null; // Ctrl＋F5 之類保留給瀏覽器
  if (e.key === 'Escape' && busy) return { stop: true };
  if (e.key === 'Enter' && inInput && !e.shiftKey) return { send: true };
  return null;
}
