// 手機每頁工具列的文字（web-phone-app-layout，同 App fragment_calling_list／fragment_my_calling 的紫色工具列）。
// 純函式，有單元測試；資料都是現有的（解碼的 Δt、解碼耗時、網格、狀態列的週期與 UTC、通聯目標、發射聲音頻率），不另外計算。
import { t } from './i18n/index.mjs';

// 工具列左邊小方框裡的模式（同 App 的 [8]）
export function modeBadge(mode) {
  return { FT8: '8', FT4: '4', FT2: '2', JS8: 'J', JTTY: 'T' }[mode] ?? '?';
}

// 最近解碼的 Δt 平均（秒）；沒有資料或不是數字時回 null
export function averageDt(list) {
  const nums = (list ?? []).filter((x) => Number.isFinite(x));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// 解碼頁：左上「平均偏移」、左下「解碼耗時」、右上「我的網格」
export function decodeBar({ recentDt, decodeMs, grid }) {
  const avg = averageDt(recentDt);
  return {
    offset: avg === null ? t('page.pbar.avg_dt_none') : t('page.pbar.avg_dt', { s: avg.toFixed(2) }),
    decode: Number.isFinite(decodeMs) ? t('page.pbar.decode_ms', { ms: Math.round(decodeMs) }) : t('page.pbar.decode_none'),
    grid: t('page.pbar.grid', { grid: grid || '—' }),
  };
}

// 呼叫頁：左上「目標呼號」、左下「週期 發射/目前」、右上「聲音頻率」
export function callBar({ target, cycle, audioHz }) {
  const hz = Number(audioHz);
  return {
    target: t('page.pbar.target', { call: target || 'CQ' }),
    cycle: t('page.pbar.cycle', { cycle: cycle || '-/-' }),
    freq: t('page.pbar.freq', { hz: Number.isFinite(hz) && hz > 0 ? Math.round(hz) : '—' }),
  };
}

export function utcText(utc) {
  return t('page.pbar.utc', { utc });
}

// 欄名列「訊息(n/總數)」的括號：n＝最近一個時槽解出幾則、總數＝清單裡幾則（同 App decoder_counter）
export function countText(last, total) {
  const all = Number.isFinite(total) ? total : 0;
  const n = Math.min(Number.isFinite(last) ? last : 0, all); // 清除清單後最近時槽則數不超過總數
  return `(${n}/${all})`;
}
