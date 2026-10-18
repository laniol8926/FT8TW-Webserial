// 開啟網頁自動開始接收（design D17）：預設開啟、可關；使用者按了「停止」，下次開網頁就不自動開始。

const KEY = 'ft8tw.autostart';
const DEFAULTS = { enabled: true, stoppedByUser: false };

export function loadAutoStart(storage) {
  try {
    const saved = JSON.parse(storage.getItem(KEY) ?? 'null');
    return {
      enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : DEFAULTS.enabled,
      stoppedByUser: typeof saved?.stoppedByUser === 'boolean' ? saved.stoppedByUser : DEFAULTS.stoppedByUser,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// 只改傳進來的欄位
export function saveAutoStart(storage, patch) {
  try {
    storage.setItem(KEY, JSON.stringify({ ...loadAutoStart(storage), ...patch }));
  } catch {
    // 存不了：下次照預設自動開始
  }
}

export function shouldAutoStart({ enabled, stoppedByUser }) {
  return enabled && !stoppedByUser;
}
