// 訊號強度格（FT8TW StationAggregator.signalBars／SignalBarsView）：亮起的格數 1～5，只依 SNR。
// 電台卡與解碼清單的 dB 欄共用（使用者 2026-10-06）。
export const SIGNAL_BARS_MAX = 5;

export function signalBars(snr) {
  if (snr >= -3) return 5;
  if (snr >= -9) return 4;
  if (snr >= -15) return 3;
  if (snr >= -20) return 2;
  return 1;
}
