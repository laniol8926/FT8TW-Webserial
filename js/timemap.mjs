// AudioContext 時間 → performance 時間的偏移量（tasks 3.2）。
// 原始偏移＝getOutputTimestamp().performanceTime − contextTime×1000。讀到的對應關係會抖動，而且只往「偏大」抖：
// 桌機幾 ms；手機開著麥克風輸入時可達 +500 ms、contextTime 甚至倒退（2026-10-06 Note 8 Chrome 101 實測）。
// 舊作法（指數平滑、跳超過 50 ms 就重設）在手機上每幾百 ms 重設一次，時間戳記跟著跳，切段緩衝一直被清空、整晚解不出東西。
// 真值是這些讀數的「地板」，所以取最近 WINDOW_UPDATES 次（約 5 秒）的最小值：
//   抖動不影響輸出；音效卡與系統時鐘的緩慢漂移照樣跟得上；真的中斷時偏移變小立即採用、變大在一個視窗內採用。

export const WINDOW_UPDATES = 125; // 每 40 ms 一段 → 5 秒

export class ContextClock {
  constructor({ windowUpdates = WINDOW_UPDATES } = {}) {
    this.windowUpdates = windowUpdates;
    this.recent = []; // 最近的原始偏移，最舊的在前
    this.offset = null;
  }

  update(rawOffsetMs) {
    this.recent.push(rawOffsetMs);
    if (this.recent.length > this.windowUpdates) this.recent.shift();
    let min = Infinity;
    for (const v of this.recent) if (v < min) min = v;
    this.offset = min;
    return min;
  }
}

// AudioContext 時間 → performance 時鐘的 epoch（ms）；呼叫端再加時鐘差。
// 輸出還沒真正開始（剛 resume）時 getOutputTimestamp 回 0：那種讀數會成為假的地板黏住整個視窗，不拿來更新，
// 沿用之前的偏移；一次都還沒有時用 performance.now() − currentTime 估計（估計值不進視窗）
export function contextTimeToEpoch(ctx, contextClock, contextTime) {
  const ts = ctx.getOutputTimestamp();
  let offset;
  if (ts.performanceTime > 0 && ts.contextTime > 0) offset = contextClock.update(ts.performanceTime - ts.contextTime * 1000);
  else offset = contextClock.offset ?? performance.now() - ctx.currentTime * 1000;
  return performance.timeOrigin + contextTime * 1000 + offset;
}

// worklet 送來的相鄰兩段（每段 40 ms）是否接得上。接不上（worklet 重新起算、AudioContext 暫停後恢復）時呼叫端要
// 換新的 ContextClock 並清空切段緩衝：偏移變大時最小值要一個視窗才跟上，不清的話中斷前後的音訊會被拼成一個 slot
export const CHUNK_SEC = 0.04;
export function isContinuation(prevContextTime, contextTime, { chunkSec = CHUNK_SEC, toleranceSec = 0.02 } = {}) {
  if (prevContextTime === null || prevContextTime === undefined) return true;
  return Math.abs(contextTime - (prevContextTime + chunkSec)) <= toleranceSec;
}
