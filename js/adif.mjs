// SWL Log 匯出 ADIF（swl-log spec「匯出 ADIF」）。每筆標示 SWL=Y；FT4／JS8 依 ADIF 規範用 MFSK＋SUBMODE。
// 解不出發送者呼號的紀錄不能成為 ADIF 紀錄（CALL 是必要欄位），略過並計數。
import { parseMessage } from './ft8parse.mjs';

const MODE = {
  FT8: { mode: 'FT8' },
  FT4: { mode: 'MFSK', submode: 'FT4' },
  JS8: { mode: 'MFSK', submode: 'JS8' },
  // FT2 是 FT8TW 自訂模式，ADIF 沒有登記，寫 SUBMODE 會被判無效：只寫 MFSK，模式名補在備註（同 FT8TW AdifMode）
  FT2: { mode: 'MFSK', commentTag: ' [FT2]' },
};

export function adifField(name, value) {
  if (value === null || value === undefined || value === '') return '';
  const v = String(value);
  // 長度以 UTF-8 位元組計：檔案以 UTF-8 寫出，JS8 UTX 中文訊息若用字元數，讀取程式會切錯欄位
  return `<${name}:${new TextEncoder().encode(v).length}>${v} `;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function dateParts(utcMs) {
  const d = new Date(utcMs);
  return {
    date: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`,
  };
}

// records：{ utc, dialHz, band, mode, snr, audioHz, text, sender?, grid? }
export function toAdif(records, { myGrid = '', programVersion = '' } = {}) {
  const created = dateParts(Date.now()); // 只取一次時間：分兩次取可能跨過午夜，日期與時間差一天
  const header =
    'FT8TW_WEB SWL Log\n' +
    adifField('ADIF_VER', '3.1.4') +
    adifField('PROGRAMID', 'FT8TW_WEB') +
    adifField('PROGRAMVERSION', programVersion) +
    adifField('CREATED_TIMESTAMP', `${created.date} ${created.time}`) +
    '<EOH>\n';

  const lines = [];
  let skipped = 0;
  for (const r of records) {
    const parsed = r.sender ? { sender: r.sender, grid: r.grid ?? null } : parseMessage(r.text);
    if (!parsed) {
      skipped++;
      continue;
    }
    const { date, time } = dateParts(r.utc);
    const m = MODE[r.mode] ?? { mode: r.mode };
    const freq = r.dialHz ? ((r.dialHz + Math.round(r.audioHz)) / 1e6).toFixed(6) : null;
    lines.push(
      adifField('CALL', parsed.sender) +
        adifField('QSO_DATE', date) +
        adifField('TIME_ON', time) +
        adifField('BAND', r.band) +
        adifField('FREQ', freq) +
        adifField('MODE', m.mode) +
        adifField('SUBMODE', m.submode) +
        adifField('RST_RCVD', r.snr >= 0 ? `+${r.snr}` : String(r.snr)) +
        adifField('GRIDSQUARE', parsed.grid) +
        adifField('MY_GRIDSQUARE', myGrid) +
        adifField('SWL', 'Y') +
        adifField('COMMENT', r.text + (m.commentTag ?? '')) +
        '<EOR>',
    );
  }
  return { text: header + lines.map((l) => `${l}\n`).join(''), exported: lines.length, skipped };
}
