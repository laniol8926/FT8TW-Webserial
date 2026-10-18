// SWL Log 保留期限（design D16）：預設 30 天，可改 7／30／90 天或不刪除（null）。存在 localStorage。

const KEY = 'ft8tw.swlRetentionDays';
const DAY_MS = 86_400_000;
export const RETENTION_OPTIONS = [7, 30, 90, null];
export const DEFAULT_RETENTION_DAYS = 30;

export function loadRetention(storage) {
  try {
    const v = storage.getItem(KEY);
    if (v === null) return DEFAULT_RETENTION_DAYS;
    if (v === 'never') return null;
    const n = Number(v);
    return RETENTION_OPTIONS.includes(n) ? n : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

export function saveRetention(storage, days) {
  try {
    storage.setItem(KEY, days === null ? 'never' : String(days));
  } catch {
    // 存不了就維持預設，不影響使用
  }
}

// 早於這個時間的記錄要刪；不刪除時回 null
export function cutoffFor(now, days) {
  return days === null ? null : now - days * DAY_MS;
}
