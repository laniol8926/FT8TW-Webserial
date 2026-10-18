// AudioWorklet：把輸入降到 12 kHz，每約 40 ms 送一段給主執行緒（tasks 3.1）。
// 每段附上第一個樣本的 AudioContext 時間，主執行緒再換算成 UTC。
// 第 n 個輸出樣本對應輸入時刻 n×(輸入取樣率/12000)，即串流起點後 n/12000 秒。
import { Resampler, OUT_RATE } from '../js/resample.mjs';

const CHUNK = 480; // 40 ms @ 12 kHz
const GLITCH_SEC = 0.02;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.restart();
  }

  restart() {
    // 係數表只建一次：在音訊執行緒重建 513 組係數可能再造成一次中斷
    this.resampler ??= new Resampler(sampleRate);
    this.resampler.reset();
    this.anchorTime = null; // 第 0 個輸出樣本的 context 時間
    this.inFrames = 0;
    this.outCount = 0;
    this.pending = [];
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    // 渲染中斷（分頁被節流、裝置重啟）時 currentTime 會跳：重新起算，不要讓時間戳記錯位
    const expected = this.anchorTime === null ? null : this.anchorTime + this.inFrames / sampleRate;
    if (expected !== null && Math.abs(currentTime - expected) > GLITCH_SEC) this.restart();
    if (this.anchorTime === null) this.anchorTime = currentTime;
    this.inFrames += channel.length;

    for (const v of this.resampler.process(channel)) this.pending.push(v);
    while (this.pending.length >= CHUNK) {
      const samples = Float32Array.from(this.pending.splice(0, CHUNK));
      const contextTime = this.anchorTime + this.outCount / OUT_RATE;
      this.outCount += CHUNK;
      this.port.postMessage({ samples, contextTime }, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor('ft8tw-capture', CaptureProcessor);
