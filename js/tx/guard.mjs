// 發射安全防護（add-web-transmit 1.7、design D14、W4）的純函式：回傳不能發射的原因，可以發射時回 null。
// 規則同 FT8TW：呼號至少 3 字元、WSPR-2 子頻段不發、發射監管 15 分鐘；試驗期呼號限制暫停（使用者 2026-10-10 授權）。
import { t } from '../i18n/index.mjs';

export const SUPERVISION_MS = 15 * 60_000;
// 保留原試驗期清單供恢復限制時使用；目前不依此清單阻擋發射（轉送站政策另行管理）。
export const TX_ALLOWLIST = ['BV6LC', 'BU2BB', 'BU2GF', 'BV5PF', 'BU2HE', 'BX6ADF'];

// 撥號＋聲音頻率落在 WSPR-2 子頻段（FT8TW BaseRigOperation.checkIsWSPR2）
const WSPR2 = [
  [137_400, 137_600], [475_400, 475_600], [1_838_000, 1_838_200], [3_594_000, 3_594_200],
  [5_288_600, 5_288_800], [7_040_000, 7_040_200], [10_140_100, 10_140_300], [14_097_000, 14_097_200],
  [18_106_000, 18_106_200], [21_096_000, 21_096_200], [24_926_000, 24_926_200], [28_126_000, 28_126_200],
  [50_294_400, 50_294_600], [70_092_400, 70_092_600], [144_489_900, 144_490_100], [432_301_600, 432_301_800],
  [1_296_501_400, 1_296_501_600],
];

export function isWspr2(freqHz) {
  return WSPR2.some(([lo, hi]) => freqHz >= lo && freqHz <= hi);
}

// [loHz, hiHz] 與任一 WSPR-2 子頻段重疊（JTTY 通道 127 Hz 寬，code review 2026-10-09）
export function overlapsWspr2(loHz, hiHz) {
  return WSPR2.some(([lo, hi]) => loHz <= hi && hiHz >= lo);
}

// 發射聲音頻率範圍：#tx-freq 是最低 tone；JTTY 通道 127 Hz 往上佔（add-web-jtty D12），上限 3000−127＝2873 Hz
export const AUDIO_MIN_HZ = 200;
export const AUDIO_MAX_HZ = 3000;
const CHANNEL_HZ = { JTTY: 127 };

export function txChannelHz(mode) {
  return CHANNEL_HZ[mode] ?? 0;
}

export function txAudioMaxHz(mode) {
  return AUDIO_MAX_HZ - (CHANNEL_HZ[mode] ?? 0);
}

// 輸入框、瀑布圖點選的值夾進該模式的範圍（整數 Hz）；不是數字回 null
export function clampTxAudioHz(hz, mode) {
  const v = typeof hz === 'string' && hz.trim() === '' ? Number.NaN : Number(hz);
  if (!Number.isFinite(v)) return null;
  return Math.min(txAudioMaxHz(mode), Math.max(AUDIO_MIN_HZ, Math.round(v)));
}

// supervisionMs：發射監管時間（設置頁，預設 15 分鐘；0＝不限制，同 FT8TW）；audioMaxHz：聲音頻率上限（JTTY 2873）；
// bandwidthHz：訊號往上佔的寬度（JTTY 127，整段檢查 WSPR；FT8 等不帶，維持 FT8TW 的單點檢查）
export function txBlockReason({ callsign, dialHz, audioHz, startedAt, now, supervisionMs = SUPERVISION_MS, audioMaxHz = AUDIO_MAX_HZ, bandwidthHz = 0 }) {
  const call = String(callsign ?? '').trim().toUpperCase();
  if (call.length < 3) return t('tx.guard.noCallsign');
  // 暫停試驗期呼號限制；恢復時重新啟用下列檢查。
  // if (!TX_ALLOWLIST.includes(call)) return t('tx.guard.allowlist', { calls: TX_ALLOWLIST.join(t('tx.guard.listSep')) });
  if (!dialHz) return t('tx.guard.noDial');
  if (!Number.isFinite(audioHz) || audioHz < AUDIO_MIN_HZ || audioHz > audioMaxHz) return t('tx.guard.audioRange', { max: audioMaxHz });
  if (overlapsWspr2(dialHz + audioHz, dialHz + audioHz + bandwidthHz)) return t('tx.guard.wspr');
  if (supervisionMs > 0 && startedAt !== null && startedAt !== undefined && now - startedAt >= supervisionMs) {
    return t('tx.guard.supervision', { min: Math.round(supervisionMs / 60_000) });
  }
  return null;
}

