// 從 FT8／FT4 訊息文字找出發送者呼號與網格（D14）。比照 WSJT-X：能確定發送者的標準訊息才算 spot。
//   CQ [修飾詞] 呼號 [網格]              → 發送者＝呼號
//   呼號1 呼號2 [網格|報告|RRR|RR73|73]   → 發送者＝呼號2（第一個是被呼叫的一方）
// 發送者是未解開的雜湊 <...>、自由文字、遙測 → null（不回報，但仍寫入 SWL Log）。
import { isValidCallsign } from './settings.mjs';

const GRID4 = /^[A-R]{2}[0-9]{2}$/;
const CQ_MODIFIER = /^(?:[A-Z]{1,4}|[0-9]{3})$/; // DX、NA、POTA、3 位數字等
const HASHED = Symbol('hashed');

// <BV6LC/P>（雜湊表已解開）→ BV6LC/P；<...>（解不開）→ HASHED
function unwrap(token) {
  const m = token.match(/^<(.+)>$/);
  if (!m) return token;
  return m[1] === '...' ? HASHED : m[1];
}

function gridOf(token) {
  return token !== undefined && token !== 'RR73' && GRID4.test(token) ? token : null;
}

function result(senderToken, rest) {
  const sender = unwrap(senderToken);
  if (sender === HASHED || !isValidCallsign(sender)) return null;
  // 網格可能接在 R 後面（JA1ABC BV6LC R PL02）
  const grid = gridOf(rest[0] === 'R' ? rest[1] : rest[0]);
  return { sender, grid };
}

export function parseMessage(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  if (tokens[0] === 'CQ') {
    const rest = tokens.slice(1);
    if (rest.length === 0) return null;
    const hasModifier = rest.length >= 2 && CQ_MODIFIER.test(rest[0]);
    return hasModifier ? result(rest[1], rest.slice(2)) : result(rest[0], rest.slice(1));
  }

  if (tokens.length < 2 || tokens.length > 4) return null;
  const to = unwrap(tokens[0]);
  if (to !== HASHED && !isValidCallsign(to)) return null;
  return result(tokens[1], tokens.slice(2));
}
