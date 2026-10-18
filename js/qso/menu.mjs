// 解碼／呼叫清單的右鍵（手機長按）選單（使用者 2026-10-06）：照 FT8TW CallingListAdapter.buildPopupMenu，
// 依訊息列出可做的動作。先發送方（第二個呼號；不是我、不是雜湊）：呼叫（叫我的訊息會接著回下一步）、關注、查日誌、QRZ；
// 再接收方（第一個呼號；不是我、不是雜湊、不是 CQ）：呼叫（同頻發射時不列）、關注、查日誌、QRZ。自由文字不列。
// 順序依使用者 2026-10-10（原本照 FT8TW 先接收方、關注在前）
import { parseFt8Text, isMyCallsign } from './messages.mjs';
import { t } from '../i18n/index.mjs';

const hashed = (call) => !call || call.includes('<') || call.includes('...');

// where(call)：國名（沒有就空字串）；callingList：解碼與呼叫清單模式（FT8TW 的 CALLING_LIST，追蹤頁沒有「關注」）
export function menuItems(text, { myCall, where = () => '', syncFrequency = false, callingList = true }) {
  const m = parseFt8Text(text);
  if (m.free) return [];
  // 呼號後面帶國名：JA1ABC(Japan)（同 FT8TW %1$s(%2$s)）
  const who = (call) => (where(call) ? `${call}(${where(call)})` : call);
  const items = [];
  const to = m.callsignTo;
  const isCq = to === 'CQ' || to.startsWith('CQ ') || to === 'QRZ' || to === 'DE';
  const from = m.callsignFrom;
  // 順序（使用者 2026-10-10）：先發送方、再接收方；每組依序 呼叫、關注、查日誌、查 QRZ
  if (!hashed(from) && !isMyCallsign(myCall, from)) {
    // 叫我的訊息顯示「回覆」（FT8TW 的「回覆」項目放在接收方不是我的條件裡，永遠不會出現；網頁改成在這裡顯示）
    items.push({ id: 'callFrom', call: from, label: isMyCallsign(myCall, to) ? t('qso.menu.reply', { call: who(from) }) : t('qso.menu.call', { call: who(from) }) });
    if (callingList) items.push({ id: 'followFrom', call: from, label: t('qso.menu.follow', { call: who(from) }) });
    items.push({ id: 'logFrom', call: from, label: t('qso.menu.log', { call: from }) });
    items.push({ id: 'qrzFrom', call: from, label: t('qso.menu.qrz', { call: from }) });
  }
  if (!hashed(to) && !isMyCallsign(myCall, to) && !isCq) {
    if (!syncFrequency) items.push({ id: 'callTo', call: to, label: t('qso.menu.callTo', { call: who(to) }) });
    if (callingList) items.push({ id: 'followTo', call: to, label: t('qso.menu.followTo', { call: who(to) }) });
    items.push({ id: 'logTo', call: to, label: t('qso.menu.log', { call: to }) });
    items.push({ id: 'qrzTo', call: to, label: t('qso.menu.qrz', { call: to }) });
  }
  return items;
}
