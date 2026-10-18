// 使用人數心跳（design D18）：每 2 分鐘向轉送站送一次匿名的接收者 ID。
// 後台使用統計（add-relay-admin，使用者 2026-10-07）：有填呼號時一併帶呼號與「是否正在接收」，轉送站記每天使用分鐘數；
// 送出條件為「前景或正在接收」（背景分頁仍在解碼也算使用中）。只給管理者看；送失敗靜默略過，不影響解碼與回報。
import { isValidCallsign } from './settings.mjs';
import { parseMinBuild } from './update.mjs';

export const HEARTBEAT_MS = 120_000;

const MIN_GAP_MS = 30_000; // 快速切換分頁時不重複送（與 /spots 共用同一 IP 的限流額度）

// getStatus()：{ callsign, rx, psk? }（目前設定的呼號、是否正在接收、上傳開關 { spots, qso }）；不給時只送匿名 id（舊行為）
// version：完整版本（add-version-tracking，後台看每位使用者的版本）；onReply({ minBuild, forward? })：轉送站回的最低流水號
// （舊轉送站回 204 → 0；其他錯誤、壞 JSON 不呼叫）。forward（add-relay-forward-control F6）：{ psk, aprs, you }，舊轉送站沒有時不帶
export function parseForward(v) {
  if (typeof v !== 'object' || v === null) return null;
  if (typeof v.psk !== 'boolean' || typeof v.aprs !== 'boolean' || !['allow', 'block', 'none'].includes(v.you)) return null;
  return { psk: v.psk, aprs: v.aprs, you: v.you };
}

export function startHeartbeat({ base, id, getStatus = null, version = null, onReply = null, fetchFn = fetch, doc = document,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = Date.now }) {
  let last = -Infinity;
  const beat = () => {
    const st = getStatus?.() ?? null;
    if (doc.visibilityState !== 'visible' && !st?.rx) return;
    last = now();
    const body = { id };
    if (st) {
      const call = String(st.callsign ?? '').trim().toUpperCase();
      if (call && isValidCallsign(call)) body.callsign = call;
      body.rx = Boolean(st.rx);
      // 上傳開關（後台看誰開了回報）：兩個都要是布林才帶
      if (typeof st.psk?.spots === 'boolean' && typeof st.psk?.qso === 'boolean') body.psk = { spots: st.psk.spots, qso: st.psk.qso };
    }
    if (version) body.version = version;
    fetchFn(`${base}/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).then(async (res) => {
      if (!onReply) return;
      if (res.status === 204) onReply({ minBuild: 0 });
      else if (res.status === 200) {
        const j = await res.json();
        const forward = parseForward(j?.forward);
        onReply(forward ? { minBuild: parseMinBuild(j?.minBuild), forward } : { minBuild: parseMinBuild(j?.minBuild) });
      }
    }).catch(() => {});
  };
  beat();
  let timer = setIntervalFn(beat, HEARTBEAT_MS);
  doc.addEventListener('visibilitychange', () => {
    if (now() - last < MIN_GAP_MS) return;
    const before = last;
    beat();
    if (last === before) return; // 沒送（仍在背景且沒在接收）
    // 補送後重新起算（code review）：否則下一次定時心跳離這次太近，被轉送站 110 秒去重，少算使用分鐘
    clearIntervalFn(timer);
    timer = setIntervalFn(beat, HEARTBEAT_MS);
  });
}
