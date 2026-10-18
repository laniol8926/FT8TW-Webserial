// 空清單的雷達掃描畫面（使用者 2026-10-09，參考 FT8TW App 電台卡的 stationEmptyBox／RadarSweepView）：
// 解碼清單、呼叫清單、電台卡（FT8／FT4／FT2）與 JS8、JTTY 對話區沒有東西可看時，正中間顯示雷達＋一行說明。
// 這裡是純函式（要顯示哪一句）；畫面在 radar-ui.mjs，動畫是純 CSS（cards.css .radar）。
import { t } from './i18n/index.mjs';

// shown：看得到的列數；total：篩選前的列數（目前模式）；running：接收中；minutes：時間篩選（0＝全部）；
// station：對話區選了某一台（JS8 呼號、JTTY 呼號或 @頻率）。有列看得到回 null（雷達隱藏）
export function emptyState({ shown = 0, total = 0, running = false, minutes = 0, station = null } = {}) {
  if (shown > 0) return null;
  if (station) return { key: 'cards.radar.noStation' };
  if (total > 0) return minutes ? { key: 'cards.radar.filtered', params: { n: minutes } } : { key: 'cards.radar.filteredAll' };
  return { key: running ? 'cards.radar.waiting' : 'cards.radar.idle' };
}

export function emptyText(state) {
  return state ? t(state.key, state.params) : '';
}
