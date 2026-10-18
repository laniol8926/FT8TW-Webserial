// 畫面顯示用的格式與文字（純函式，方便測試）。
import { t } from './i18n/index.mjs';

export function formatUtc(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// UTC 到 0.1 秒（JTTY 解碼列表，add-web-jtty jtty-chat「收訊顯示與紀錄」：比對 WSJT-X ALL.TXT）；四捨五入到 100 ms
export function formatUtcTenths(ms) {
  const tenths = Math.round(ms / 100);
  return `${formatUtc(tenths * 100)}.${((tenths % 10) + 10) % 10}`;
}

// 本地時間；timeZone 省略時用瀏覽器的時區。hourCycle h23：午夜顯示 00 而不是 24
export function formatLocal(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(ms);
}

const PROCESSING_NAMES = {
  echoCancellation: t('page.proc.echoCancellation'),
  noiseSuppression: t('page.proc.noiseSuppression'),
  autoGainControl: t('page.proc.autoGainControl'),
};

export function processingWarning(stillOn) {
  if (stillOn.length === 0) return null;
  const names = stillOn.map((k) => PROCESSING_NAMES[k] ?? k).join(t('common.list_sep'));
  return t('page.proc.warning', { names });
}

export function clockWarningText(code, state) {
  switch (code) {
    case 'never-synced':
      return t('page.warn.never_synced');
    case 'clock-skew':
      return t('page.warn.clock_skew', { s: (state.offsetMs / 1000).toFixed(1) });
    case 'uncertain':
      return t('page.warn.uncertain', { ms: Math.round(state.uncertaintyMs) });
    case 'server-unsynced':
      return t('page.warn.server_unsynced');
    case 'audio-latency':
      return t('page.warn.audio_latency');
    default:
      return code;
  }
}

// 有正負號的秒數（3 位小數）：+1.234、−0.050
const signedSec = (ms) => `${ms >= 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(3)}`;

export function clockSummary(state) {
  if (!state.everSynced) return state.lastError ? t('page.clock.failed', { error: state.lastError }) : t('page.clock.not_measured');
  return t('page.clock.offset', { offset: signedSec(state.offsetMs), ms: Math.round(state.uncertaintyMs) });
}

// 時間偏移選項文字：0.0 秒、+0.3 秒、−1.2 秒
export function formatOffset(ms) {
  if (ms === 0) return t('page.clock.seconds', { v: '0.0' });
  return t('page.clock.seconds', { v: `${ms > 0 ? '+' : '−'}${(Math.abs(ms) / 1000).toFixed(1)}` });
}

// 設置頁「時間偏移」卡片：自動校時結果與多久前量的、手動偏移與合計
export function clockDetail(state, manualMs, now) {
  let text = t('page.clock.auto', { summary: clockSummary(state) });
  if (state.everSynced) {
    const min = Math.floor((now - state.measuredAt) / 60_000);
    text += min < 1 ? t('page.clock.just_now') : t('page.clock.min_ago', { n: min });
    if (state.lastError) text += t('page.clock.last_failed', { error: state.lastError });
  }
  if (manualMs) {
    text += t('page.clock.manual', { offset: formatOffset(manualMs), total: signedSec(state.offsetMs + manualMs) });
  }
  return text;
}

// 狀態區「回報」一列（tasks 4.2）
export function reportStatusText(status, { canReport, callsign, grid }) {
  if (!callsign || !grid) return t('page.report.need_identity');
  // 轉送站的轉發控制（add-relay-forward-control F7）：比「沒有時間校正」優先，否則暫停原因會被蓋掉
  if (status.paused === 'forward-paused') return t('page.report.forward_paused');
  if (status.paused === 'forward-blocked') return t('page.report.forward_blocked');
  if (!canReport) return t('page.report.no_time');
  if (status.paused === 'trial') return t('page.report.trial');
  if (status.paused === 'no-dial') return t('page.report.no_dial');
  const n = { sent: status.sent, queued: status.queued };
  return status.lastError ? t('page.report.status_error', { ...n, error: status.lastError }) : t('page.report.status', n);
}

// 標題顯示用的版本：去掉開頭的「0.」。0. 只是為了讓送給轉送站的版本符合三段數字格式（design D3）
export function displayVersion(version) {
  return version.replace(/^0\./, '');
}

// 一則解碼的表格欄位：[文字, class]。class 讓手機版用 CSS grid 排成兩行卡片（同 FT8TW），平板／桌機照表格顯示
export function decodeCells(startUtc, r, timeZone) {
  return [
    [formatUtc(startUtc), 'utc'],
    [formatLocal(startUtc, timeZone), 'local'],
    [String(r.snr), 'num snr'],
    [r.timeSec.toFixed(1), 'num dt'],
    [String(Math.round(r.freqHz)), 'num hz'],
    [r.text, 'msg'],
  ];
}

// 解碼清單（新的在上）插入位置：slotStarts＝目前各列的 slot 起點（由上而下）。
// 我方發射的列在發射 slot 一開始就加進來，上一個 slot 的解碼稍後才到，要插在它下面（code review 2026-10-06）
export function feedInsertIndex(slotStarts, startUtc) {
  const i = slotStarts.findIndex((t) => t <= startUtc);
  return i < 0 ? slotStarts.length : i;
}
