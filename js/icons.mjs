// 手機版面的線條圖示（web-phone-app-layout）：外形照 Material 圖示的意思自己畫，不引用 Google 圖檔。
// 24×24、線條用 currentColor（跟著按鈕字色走，深淺色都不必另畫）；報讀軟體略過（按鈕自己有 aria-label）。
const PATHS = {
  // 底部分頁（同 App bottom_nav_menu：解碼、呼叫、頻譜、通聯記錄、設置）
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.3" fill="currentColor"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor"/><circle cx="4.5" cy="18" r="1.3" fill="currentColor"/>',
  calling: '<circle cx="12" cy="12" r="9.5"/><circle cx="8" cy="12" r="1.3" fill="currentColor"/><path d="M11 9a4 4 0 0 1 0 6M14 6.8a7.5 7.5 0 0 1 0 10.4"/>',
  spectrum: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5V9h4.5"/><path d="M12 8v4.2l2.8 1.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/><circle cx="12" cy="12" r="6.3"/>',
  // 工具列
  clear: '<path d="M4 6.5h16M9.5 6.5V4h5v2.5M6 6.5 7 20h10l1-13.5"/><path d="M10 10.5l4 5.5M14 10.5l-4 5.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>',
  micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7M3.5 3.5l17 17"/>',
  tx: '<path d="M3.5 9.5v5h3.5l6 4v-13l-6 4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  txOff: '<path d="M3.5 9.5v5h3.5l6 4v-13l-6 4z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  // 右側浮動按鈕（同 App FloatView：全螢幕、模式、地圖、JS8 通訊）
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  mode: '<path d="M4 8h15l-4-4M20 16H5l4 4"/>',
  map: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3.6 3.2 14.4 0 18M12 3c-3.2 3.6-3.2 14.4 0 18"/>',
  chat: '<path d="M4 5h16v11H9.5L4 20z"/><path d="M8 9.5h8M8 12.5h5"/>',
};

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

// 回傳 <svg> 字串（只用上面固定的內容，可以安全地放進 innerHTML）；不認得的名稱回空字串
export function icon(name, size = 24) {
  const body = PATHS[name];
  if (!body) return '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}
