// 通聯記錄清單（簡易版，完整記錄頁在 T5）：卡片左側雙方呼號網格、右側起訖時間、報告、頻段模式頻率（同 FT8TW 通聯記錄頁）
import { t } from '../i18n/index.mjs';
const pad = (n) => String(n).padStart(2, '0');
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function qsoCardText(q) {
  return {
    calls: [q.call, q.grid ?? '', q.myCall ?? '', q.myGrid ?? ''],
    // 對方的 QRZ 頁（含照片）。瀏覽器讀不到 QRZ 網頁內容（CORS），不像 FT8TW 自動抓照片（使用者 2026-10-06 決定先不抓）
    qrzUrl: q.call ? `https://www.qrz.com/db/${encodeURIComponent(q.call)}` : null,
    lines: [
      t('qso.card.start', { time: stamp(q.startUtc) }),
      t('qso.card.end', { time: stamp(q.endUtc) }),
      t('qso.card.rst', { rcvd: q.rstRcvd || '—', sent: q.rstSent || '—' }),
      [q.band, q.mode, q.freqHz ? `${(q.freqHz / 1e6).toFixed(6)} MHz` : ''].filter(Boolean).join(' '),
    ],
  };
}

export function renderQsoList(ul, records) {
  ul.replaceChildren(...records.map((q) => {
    const { calls, lines, qrzUrl } = qsoCardText(q);
    const li = document.createElement('li');
    li.className = 'qso-card';
    const left = document.createElement('div');
    left.className = 'calls';
    left.append(calls[0], document.createElement('br'), Object.assign(document.createElement('small'), { textContent: calls[1] }),
      document.createElement('br'), Object.assign(document.createElement('small'), { textContent: `${calls[2]} ${calls[3]}` }));
    const right = document.createElement('div');
    right.className = 'meta';
    for (const l of lines) right.append(Object.assign(document.createElement('div'), { textContent: l }));
    if (qrzUrl) {
      left.append(document.createElement('br'), Object.assign(document.createElement('a'), {
        className: 'qrz-link', href: qrzUrl, target: '_blank', rel: 'noopener noreferrer', textContent: 'QRZ',
        title: t('qso.card.qrzTitle', { call: calls[0] }),
      }));
    }
    li.append(left, right);
    return li;
  }));
}
