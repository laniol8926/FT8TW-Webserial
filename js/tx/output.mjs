// 發射音訊輸出（add-web-transmit 1.6、design D5、D7）：VOX，不控制 PTT。
// 時間換算以 AudioContext.getOutputTimestamp() 為準：它說「performanceTime 這一刻，喇叭正在播 contextTime」，
// 所以排出的時間已含輸出延遲，音訊落在 slot 起點（背景分頁的計時器節流不影響 AudioContext 的排程，W1）。
import { t } from '../i18n/index.mjs';

export const DEFAULT_GAIN = 0.8; // FT8TW volumePercent

// targetPerfMs：要讓喇叭開始播的 performance 時刻（ms）
// 輸出時間戳記超過這個時間沒更新（剛開啟或剛 resume 的 AudioContext）就視為過期；
// 與 currentTime 估計相差超過 MAX_DISAGREE_S 也不採用（正常輸出延遲遠小於此，藍牙約 0.2～0.4 s）
const STALE_AGE_MS = 500;
const MAX_DISAGREE_S = 1.0;

export function contextTimeFor(ctx, targetPerfMs, perfNow = () => performance.now()) {
  const now = perfNow();
  // 用 currentTime 扣輸出延遲的估計：一定可用，但輸出延遲只是瀏覽器的估計值（Safari 沒有 outputLatency）
  const estimate = ctx.currentTime + (targetPerfMs - now) / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
  const ts = ctx.getOutputTimestamp?.();
  if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && now - ts.performanceTime <= STALE_AGE_MS) {
    const precise = ts.contextTime + (targetPerfMs - ts.performanceTime) / 1000;
    // 時間戳記已含真實輸出延遲，較準；只在明顯不合理時退回估計值
    if (Math.abs(precise - estimate) < MAX_DISAGREE_S) return precise;
  }
  return estimate;
}

export class TxOutput {
  // onInterrupted(state)：AudioContext 被系統暫停或關閉（裝置拔除、手機來電），發射要立刻停
  constructor({ AudioContextCtor = globalThis.AudioContext, perfNow = () => performance.now(), onInterrupted = () => {} } = {}) {
    this.AudioContextCtor = AudioContextCtor;
    this.onInterrupted = onInterrupted;
    this.perfNow = perfNow;
    this.ctx = null;
    this.gainNode = null;
    this.gainValue = DEFAULT_GAIN;
    this.source = null;
  }

  // 回傳 { sinkApplied }：瀏覽器不支援 AudioContext sinkId 時退回預設輸出（D7）
  async open({ sinkId } = {}) {
    if (this.ctx) await this.close();
    let sinkApplied = false;
    if (sinkId) {
      try {
        this.ctx = new this.AudioContextCtor({ sinkId, latencyHint: 'interactive' });
        // 不支援 sinkId 的瀏覽器會默默忽略這個參數：以實際的 ctx.sinkId 判斷
        sinkApplied = this.ctx.sinkId === sinkId;
      } catch {
        this.ctx = null;
      }
    }
    this.ctx ??= new this.AudioContextCtor({ latencyHint: 'interactive' });
    await this.ctx.resume();
    const ctx = this.ctx;
    ctx.addEventListener?.('statechange', () => {
      if (this.ctx === ctx && ctx.state !== 'running') this.onInterrupted(ctx.state);
    });
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.gainValue;
    this.gainNode.connect(this.ctx.destination);
    return { sinkApplied };
  }

  setGain(value) {
    this.gainValue = Math.min(1, Math.max(0, Number(value) || 0));
    if (this.gainNode) this.gainNode.gain.value = this.gainValue;
  }

  // samples：單聲道波形；startPerfMs：喇叭開始播的 performance 時刻。回傳播完（或被停止）時 resolve 的 Promise
  play(samples, { sampleRate, startPerfMs }) {
    if (!this.ctx) throw new Error(t('tx.outputNotOpen'));
    this.stop();
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gainNode);
    const when = contextTimeFor(this.ctx, startPerfMs, this.perfNow);
    const done = new Promise((resolve) => { src.onended = resolve; });
    src.start(when > this.ctx.currentTime ? when : 0); // 時間已過就立刻開始（遲到，未過截止）
    this.source = src;
    return done;
  }

  stop() {
    const src = this.source;
    this.source = null;
    if (src) {
      try {
        src.stop();
      } catch {
        // 還沒開始或已結束
      }
    }
  }

  async close() {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    this.gainNode = null;
    if (ctx && ctx.state !== 'closed') await ctx.close();
  }
}
