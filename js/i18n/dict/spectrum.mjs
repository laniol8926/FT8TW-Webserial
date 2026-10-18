// 字典：spectrum 區（key 一律以 "spectrum." 開頭；兩語系 key 必須一致，webtest/i18n.test.mjs 檢查）
// 瀑布圖顯示調整的滑桿標籤（spectrum/panel.mjs 帶上目前的 ±dB）。英文同 FT8TW App waterfall_adjust_*
// spectrum.ticker：JTTY 字幕區的 aria-label（jtty/ticker-ui.mjs）
export default {
  en: {
    'spectrum.zeroLabel': 'Reference (black level)  {value}',
    'spectrum.gainLabel': 'Contrast  {value}',
    'spectrum.ticker': 'JTTY captions: text received from each station',
  },
  'zh-TW': {
    'spectrum.zeroLabel': '基準（黑色位準）  {value}',
    'spectrum.gainLabel': '對比  {value}',
    'spectrum.ticker': 'JTTY 字幕：各台收到的文字',
  },
};
