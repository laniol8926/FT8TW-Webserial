// 業餘波段的 FT8／FT4 標準撥號頻率（Hz，USB 撥號頻率，與 WSJT-X 預設相同）；JS8、FT2 取自 FT8TW assets/bands_js8.txt、bands_ft2.txt。
// 各模式的標準頻率都在 FT8TW App 的內建頻率表裡（bands-data.mjs，webtest 檢查；add-web-frequency-list D9）。
// 波段範圍用來從自訂頻率判斷波段（回報去重以「呼號＋波段＋模式」為鍵，D14），也是頻率表編輯的「業餘波段內」驗證。
// JTTY（add-web-jtty D15）：先只有 20m 14.090 MHz（來源 DXZone，記於 openspec/changes/add-web-jtty/provenance.md）；
// TODO 其他波段依 DXZone 頻率表補，來源同樣記 provenance。
// 8m、4m、70cm 只有 App 頻率表有（沒有 JS8 標準頻率）；8m 取各國開放的 40.66～40.70 MHz 共同段。

export const BANDS = [
  { band: '160m', lo: 1_800_000, hi: 2_000_000, FT8: 1_840_000, FT4: 1_848_000, JS8: 1_842_000, FT2: 1_850_000 },
  { band: '80m', lo: 3_500_000, hi: 4_000_000, FT8: 3_573_000, FT4: 3_575_000, JS8: 3_578_000, FT2: 3_583_000 },
  { band: '60m', lo: 5_250_000, hi: 5_450_000, FT8: 5_357_000, FT4: null, JS8: null, FT2: null },
  { band: '40m', lo: 7_000_000, hi: 7_300_000, FT8: 7_074_000, FT4: 7_047_500, JS8: 7_078_000, FT2: 7_052_000 },
  { band: '30m', lo: 10_100_000, hi: 10_150_000, FT8: 10_136_000, FT4: 10_140_000, JS8: 10_130_000, FT2: 10_146_000 },
  { band: '20m', lo: 14_000_000, hi: 14_350_000, FT8: 14_074_000, FT4: 14_080_000, JS8: 14_078_000, FT2: 14_084_000, JTTY: 14_090_000 },
  { band: '17m', lo: 18_068_000, hi: 18_168_000, FT8: 18_100_000, FT4: 18_104_000, JS8: 18_104_000, FT2: 18_110_000 },
  { band: '15m', lo: 21_000_000, hi: 21_450_000, FT8: 21_074_000, FT4: 21_140_000, JS8: 21_078_000, FT2: 21_084_000 },
  { band: '12m', lo: 24_890_000, hi: 24_990_000, FT8: 24_915_000, FT4: 24_919_000, JS8: 24_922_000, FT2: 24_925_000 },
  { band: '10m', lo: 28_000_000, hi: 29_700_000, FT8: 28_074_000, FT4: 28_180_000, JS8: 28_078_000, FT2: 28_084_000 },
  { band: '8m', lo: 40_660_000, hi: 40_700_000, FT8: 40_680_000, FT4: null, JS8: null, FT2: null },
  { band: '6m', lo: 50_000_000, hi: 54_000_000, FT8: 50_313_000, FT4: 50_318_000, JS8: 50_318_000, FT2: 50_323_000 },
  { band: '4m', lo: 70_000_000, hi: 70_500_000, FT8: 70_154_000, FT4: null, JS8: null, FT2: null },
  { band: '2m', lo: 144_000_000, hi: 148_000_000, FT8: 144_174_000, FT4: 144_170_000, JS8: null, FT2: 144_184_000 },
  { band: '70cm', lo: 420_000_000, hi: 450_000_000, FT8: 432_174_000, FT4: 432_174_000, JS8: null, FT2: 432_184_000 },
];

export function dialFor(band, mode) {
  return BANDS.find((b) => b.band === band)?.[mode] ?? null;
}

export function bandOf(freqHz) {
  return BANDS.find((b) => freqHz >= b.lo && freqHz <= b.hi)?.band ?? null;
}

// 目前設定下某模式的撥號頻率（add-web-frequency-list D2）：目前模式＝選的頻率（settings.dialHz）；
// 別的模式只在它選的頻率與目前同波段時才用，否則同波段該模式的標準頻率（不會拿別的波段的頻率去回報）
export function selectedDial(s, mode = s.mode) {
  if (mode === s.mode && s.dialHz) return s.dialHz;
  const hz = s.freqByMode?.[mode];
  if (hz && bandOf(hz) === s.band) return hz;
  return dialFor(s.band, mode);
}
