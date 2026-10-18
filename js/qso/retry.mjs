// 重試上限、冷卻、失敗清單、候選清單（design D11）：移植自 FT8TW GeneralVariables 的
// markQsoCompleted／isInQsoCooldown／canCooldownFinishRetry／markCooldownFinishRetry、
// addFailCallSign／removeFailCallSign／releaseOldestFailCallSign、addOneCandidateInfo／getCandidateInfo_CQME。
// FT8TW 用可變的靜態表；這裡全是純函式，傳入舊表回傳新表。
export { reportRetryLimit } from './messages.mjs';

export const DEFAULT_NO_REPLY_LIMIT = 0; // 0＝不限
export const DEFAULT_FINISH_RETRY_LIMIT = 2;
export const QSO_COOLDOWN_MS = 10 * 60 * 1000; // RECENT_QSO_COOLDOWN_MS：同呼號同波段 10 分鐘內不重複記錄
export const FAIL_DWELL_MS = 5 * 60 * 1000; // FAIL_CALLSIGN_DWELL_MS：失敗清單至少待這麼久才放行
export const CANDIDATE_TTL_MS = 15 * 60 * 1000; // 候選（有人叫我）的有效期
export const MAX_CANDIDATES = 200;

// ===== 冷卻表：{ "呼號|波段": { at, retries } } =====

const keyOf = (call, band) => `${call.toUpperCase()}|${band}`;

export function markQsoCompleted(table, call, band, now) {
  if (!call) return table;
  return { ...table, [keyOf(call, band)]: { at: now, retries: 0 } }; // 新的一場：補發額度重算
}

function live(table, call, band, now) {
  if (!call) return null;
  const e = table[keyOf(call, band)];
  return e && now - e.at <= QSO_COOLDOWN_MS ? e : null;
}

export function isInQsoCooldown(table, call, band, now) {
  return live(table, call, band, now) !== null;
}

// 冷卻中的對象重呼我（沒收到我的收尾）時還能不能補發；額度與 finishRetryLimit 相同，0＝關閉
export function canCooldownFinishRetry(table, call, band, now, finishRetryLimit) {
  if (finishRetryLimit <= 0 || !call) return false;
  const e = live(table, call, band, now);
  return !e || e.retries < finishRetryLimit;
}

// 冷卻中已補發幾次（沒在冷卻＝0）
export function cooldownRetries(table, call, band, now) {
  return live(table, call, band, now)?.retries ?? 0;
}

export function markCooldownFinishRetry(table, call, band, now) {
  const e = live(table, call, band, now) ?? { at: -Infinity, retries: 0 };
  const used = e.retries + 1;
  return { table: { ...table, [keyOf(call, band)]: { ...e, retries: used } }, used };
}

// ===== 失敗清單：[{ call, at }] =====

export function addFail(list, call, now) {
  if (!call || list.some((f) => f.call === call)) return list; // 已在清單就不刷新時間
  return [...list, { call, at: now }];
}

export const removeFail = (list, call) => list.filter((f) => f.call !== call);
export const isFailed = (list, call) => list.some((f) => f.call === call);

// 放行待最久且已滿 FAIL_DWELL_MS 的那一個；沒有就 released=null
export function releaseOldestFail(list, now) {
  if (list.length === 0) return { list, released: null };
  const oldest = list.reduce((a, b) => (b.at < a.at ? b : a));
  if (now - oldest.at < FAIL_DWELL_MS) return { list, released: null };
  return { list: removeFail(list, oldest.call), released: oldest.call };
}

// ===== 候選清單（有人叫我）：[{ call, order, freqHz, parity, snr, grid, text, at }] =====

const fresh = (list, now) => list.filter((c) => now - c.at <= CANDIDATE_TTL_MS);

// order＝對方那則的序列步驟（CQ 記 0）；4、5（已收尾）與雜湊呼號不收
export function addCandidate(list, cand, now) {
  if (!cand.call || cand.order >= 4 || cand.call.includes('...')) return list;
  let out = fresh(list, now);
  while (out.length >= MAX_CANDIDATES) out = out.slice(1);
  const i = out.findIndex((c) => c.call === cand.call);
  if (i < 0) return [...out, { ...cand, at: now }];
  const old = out[i];
  const updated = cand.order > old.order ? { ...old, ...cand, at: now } : { ...old, at: now }; // 再出現就刷新時效
  return out.map((c, j) => (j === i ? updated : c));
}

export const removeCandidate = (list, call) => list.filter((c) => c.call !== call);

// 取 order 最高的（同分取後面那筆），連同同呼號的其他項目一併移除
export function takeCandidate(list, now) {
  const out = fresh(list, now);
  if (out.length === 0) return { list: out, picked: null };
  let best = 0;
  out.forEach((c, i) => { if (c.order >= out[best].order) best = i; });
  const picked = out[best];
  return { list: removeCandidate(out, picked.call), picked };
}
