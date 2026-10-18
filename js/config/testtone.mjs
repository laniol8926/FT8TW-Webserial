// 測試音（design W2）：從發射輸出播 1 秒 1000 Hz，讓使用者看電台 ALC 調音量。
// 測試音會經 VOX 讓電台真的發射，所以套用與發射相同的防護（tx/guard.mjs：呼號允許清單、撥號頻率、WSPR 頻段）。
import { txBlockReason } from '../tx/guard.mjs';
import { selectedDial } from '../bands.mjs';
import { t } from '../i18n/index.mjs';

export const TEST_TONE_HZ = 1000;
export const TEST_TONE_SECONDS = 1;
const RAMP_S = 0.01; // 頭尾 10 ms 淡入淡出，避免喀一聲（喀聲是寬頻雜訊）

export function toneSamples({ freq = TEST_TONE_HZ, seconds = TEST_TONE_SECONDS, sampleRate }) {
  const n = Math.round(seconds * sampleRate);
  const ramp = Math.max(1, Math.round(RAMP_S * sampleRate));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / ramp, (n - 1 - i) / ramp);
    out[i] = env * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

// 不能播的原因；可以播回 null。txActive：發射中（含等待下一個 slot）
// dialHz：電台實際撥號頻率（CAT 連線時，add-web-rig-control D14）；省略時用頻段的標準頻率
export function testToneBlockReason({ settings, txActive, now, dialHz = selectedDial(settings) }) {
  if (txActive) return t('config.toneBusy');
  const reason = txBlockReason({
    callsign: settings.callsign, dialHz, audioHz: TEST_TONE_HZ, startedAt: null, now,
  });
  return reason && t('config.toneBlocked', { reason });
}

// output：TxOutput（同發射的輸出與音量處理，含 sinkId 不支援時退回預設輸出）。播完關閉輸出
// ptt（add-web-rig-control D20，可省略）：CAT／RTS／DTR 時先按 PTT、等 PTT 延遲再播，播完（或出錯）一定放開
// stopped（code review 2026-10-09）：換頻率時被停止；還沒開始播就不播（播放中由 output.stop() 停止）
export async function playTestTone({ output, sinkId, gain, perfNow = () => performance.now(), ptt = null, stopped = () => false }) {
  const { sinkApplied } = await output.open({ sinkId: sinkId || undefined });
  const keyed = Boolean(ptt?.active());
  try {
    output.setGain(gain);
    if (stopped()) return { sinkApplied };
    const { sampleRate } = output.ctx;
    const delay = keyed ? Math.max(0, ptt.delayMs()) : 0;
    if (keyed) await ptt.on({ expectedMs: delay + TEST_TONE_SECONDS * 1000 + 50 });
    if (stopped()) return { sinkApplied };
    await output.play(toneSamples({ sampleRate }), { sampleRate, startPerfMs: perfNow() + 50 + delay });
  } finally {
    if (keyed) await ptt.off();
    await output.close();
  }
  return { sinkApplied };
}

// 按住發射（add-rig-autosetup A14）：調發射電平用。按住期間連續 1000 Hz，放開、或到單次上限就停；
// 任何結束方式（含 PTT 開失敗、播放例外）都送 PTT 關並關閉輸出。回傳 { done, release(), setGain(g) }
export const HOLD_MAX_MS = 15_000;
export function holdTestTone({ output, sinkId, gain, ptt = null, maxMs = HOLD_MAX_MS, perfNow = () => performance.now(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (id) => clearTimeout(id) }) {
  let released = false;
  let onRelease = () => {};
  const releasedP = new Promise((r) => { onRelease = r; });
  const release = () => {
    if (released) return;
    released = true;
    output.stop?.();
    onRelease(); // 不等 onended：AudioContext 被系統暫停時 onended 不會來，放開一定要馬上 PTT 關
  };
  const done = (async () => {
    const { sinkApplied } = await output.open({ sinkId: sinkId || undefined });
    const keyed = Boolean(ptt?.active());
    let timer = null;
    try {
      output.setGain(gain);
      if (released) return { sinkApplied, reason: 'released' };
      const delay = keyed ? Math.max(0, ptt.delayMs()) : 0;
      if (keyed) await ptt.on({ expectedMs: delay + maxMs + 50 });
      if (released) return { sinkApplied, reason: 'released' };
      const { sampleRate } = output.ctx;
      timer = setTimeoutFn(() => output.stop?.(), delay + maxMs + 50); // 音訊本身也只有 maxMs 長，這是備援
      const playing = output.play(toneSamples({ sampleRate, seconds: maxMs / 1000 }), { sampleRate, startPerfMs: perfNow() + 50 + delay });
      if (released) output.stop?.(); // play() 之前剛好被放開：source 這時才建立
      await Promise.race([playing, releasedP]);
      return { sinkApplied, reason: released ? 'released' : 'limit' };
    } finally {
      if (timer !== null) clearTimeoutFn(timer);
      if (keyed) await ptt.off();
      await output.close();
    }
  })();
  return { done, release, setGain: (g) => output.setGain(g) };
}
