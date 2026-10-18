// 收訊電平（add-rig-autosetup A12）：RMS 與峰值（dBFS）＋判斷。門檻集中在這裡，實機校正後再調。
export const LEVEL_HOT_PEAK_DBFS = -1; // 峰值到這裡就是破音
export const LEVEL_LOW_RMS_DBFS = -60; // 噪音底低於這裡太小（WSJT-X 建議約 30 dB／16-bit ≈ −60 dBFS）
export const LEVEL_SILENT_DBFS = -90; // 幾乎沒有訊號（線沒接、裝置選錯）

const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

export function levelOf(samples) {
  if (!samples?.length) return { rmsDb: -Infinity, peakDb: -Infinity };
  let s = 0;
  let peak = 0;
  for (const v of samples) {
    s += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { rmsDb: db(Math.sqrt(s / samples.length)), peakDb: db(peak) };
}

// 'hot'（破音）｜'silent'｜'low'｜'ok'
export function judgeLevel({ rmsDb, peakDb }) {
  if (peakDb >= LEVEL_HOT_PEAK_DBFS) return 'hot';
  if (!(rmsDb >= LEVEL_SILENT_DBFS)) return 'silent';
  if (rmsDb < LEVEL_LOW_RMS_DBFS) return 'low';
  return 'ok';
}
