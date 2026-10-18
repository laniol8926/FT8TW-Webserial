// 自動偵測音訊來源與模式（design D15）的純邏輯：選候選輸入、切 FT4 slot、量音量、挑最佳、產生說明文字。
// 錄音與解碼的流程在 detect-run.mjs。
import { t } from './i18n/index.mjs';

const RATE = 12000;
const FT4_SLOT = 7.5 * RATE;
const SILENT_DBFS = -70;
// Windows 的 Chrome 會多列兩個別名，實際上指向其他實體裝置，偵測時跳過
const ALIASES = new Set(['default', 'communications']);

export function candidateInputs(inputs) {
  return inputs.filter((d) => d.deviceId && !ALIASES.has(d.deviceId));
}

// 依 UTC 對齊的 FT8 slot（15 秒）正好包含兩個 FT4 slot（0 與 7.5 秒起）
export function splitFt4(samples) {
  return [samples.subarray(0, FT4_SLOT), samples.subarray(FT4_SLOT, 2 * FT4_SLOT)];
}

// JS8 的擷取窗是 slot 前 1 秒起 14.84 秒；偵測只錄了 FT8 slot（slot 起點起 15 秒），前面補 1 秒 0、取 13.84 秒。
// JS8 訊號在 slot 起點後 0.5～13.14 秒，完整落在這段內
export function js8WindowFromFt8Slot(samples) {
  const out = new Float32Array(Math.round(14.84 * RATE));
  out.set(samples.subarray(0, out.length - RATE), RATE);
  return out;
}

export function rmsOf(samples) {
  if (samples.length === 0) return 0;
  let s = 0;
  for (const v of samples) s += v * v;
  return Math.sqrt(s / samples.length);
}

export function levelText(rms) {
  const dbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  if (dbfs < SILENT_DBFS) return t('page.detect.silent');
  return t('page.detect.level', { db: `${dbfs < 0 ? '−' : ''}${Math.abs(Math.round(dbfs))}` });
}

// 同則數時的模式優先序：FT8（流量最大）、FT4、JS8
const MODE_ORDER = ['FT8', 'FT4', 'JS8'];
const KEY = { FT8: 'ft8', FT4: 'ft4', JS8: 'js8' };

// 依序比：則數、模式優先序、音量
function outranks(a, b) {
  if (a.count !== b.count) return a.count > b.count;
  if (a.mode !== b.mode) return MODE_ORDER.indexOf(a.mode) < MODE_ORDER.indexOf(b.mode);
  return a.rms > b.rms;
}

// results：[{ deviceId, label, ft8, ft4, js8, rms }]，或 { deviceId, label, error }。
// 則數最多者勝；同則數 FT8 優先（流量最大），再比音量。全部 0 則回 null
export function pickBest(results) {
  let best = null;
  for (const r of results) {
    if (r.error) continue;
    for (const mode of MODE_ORDER) {
      const count = r[KEY[mode]] ?? 0;
      if (count === 0) continue;
      const cand = { deviceId: r.deviceId, label: r.label, mode, count, rms: r.rms };
      if (!best || outranks(cand, best)) best = cand;
    }
  }
  if (!best) return null;
  const { rms, ...chosen } = best;
  return chosen;
}

export function summarize(results) {
  return results.map((r) =>
    r.error
      ? t('page.detect.cannot_record', { label: r.label, error: r.error })
      : t('page.detect.result', { label: r.label, ft8: r.ft8, ft4: r.ft4, js8: r.js8 ?? 0, level: levelText(r.rms) }),
  );
}

// 「尚未選過裝置」才自動偵測（spec）：存了裝置，或偵測跑完過／使用者手動選過（含預設裝置）都算選過，
// 免得選了預設裝置或都沒解到時，每次開始接收都先卡 30 秒偵測
const CHOSEN_KEY = 'ft8tw.deviceChosen';

export function needsDetection(storage, deviceId) {
  if (deviceId) return false;
  try {
    return storage.getItem(CHOSEN_KEY) !== '1';
  } catch {
    return true;
  }
}

export function markDeviceChosen(storage) {
  try {
    storage.setItem(CHOSEN_KEY, '1');
  } catch {
    // 存不了：下次再偵測一次
  }
}
