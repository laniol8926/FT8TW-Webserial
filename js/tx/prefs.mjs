// 發射設定的保存（localStorage）：聲音頻率、時序、輸出裝置、音量。完整設定頁在 T4。
const KEY = 'ft8tw.tx';
export const TX_PREFS_DEFAULTS = { audioHz: 1000, parity: 'auto', sinkId: '', gain: 0.8 };

export function loadTxPrefs(storage) {
  let saved = {};
  try {
    saved = JSON.parse(storage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    saved = {};
  }
  const d = TX_PREFS_DEFAULTS;
  const hz = Number(saved.audioHz);
  const gain = Number(saved.gain);
  return {
    audioHz: Number.isFinite(hz) && hz >= 200 && hz <= 3000 ? hz : d.audioHz,
    parity: ['auto', '0', '1'].includes(saved.parity) ? saved.parity : d.parity,
    sinkId: typeof saved.sinkId === 'string' ? saved.sinkId : d.sinkId,
    gain: Number.isFinite(gain) && gain >= 0 && gain <= 1 ? gain : d.gain,
  };
}

export function saveTxPrefs(storage, prefs) {
  try {
    storage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 無痕模式等：只是下次不會記得
  }
}

// 預設發射訊息（同 FT8TW 第 6 則）：CQ 呼號 4 碼網格
export function defaultTxText({ callsign, grid }) {
  if (!callsign) return '';
  return ['CQ', callsign, (grid ?? '').slice(0, 4)].filter(Boolean).join(' ').toUpperCase();
}
