// JTTY 送出前先算 frame 數（code review 2026-10-09）：太長的訊息原本要到 Worker 編碼才失敗，那時輸入框已清空。
// 主執行緒第一次送出（或輸入預覽）時才載入編碼器（只用 pack／call28，約 20 KB WASM）；載入或打包失敗回 null。
// plan()：強化編碼與發話者 frame 的整則規劃（txplan.mjs，add-jtty-utx），frame 數含發話者 frame 與 UTX frame。
// split()：自動分則（add-jtty-utx U12）——整則放得下就一則；太長且不是巨集就切成多則（split.mjs），每則各自規劃。
import { planTx } from './txplan.mjs';
import { splitMessage } from './split.mjs';

const defaultLoad = async () => (await import('../../decoder/jttydecoder.mjs')).createJttyCodec();

export function createFrameCounter({ load = defaultLoad } = {}) {
  let codec = null;
  const ready = () => {
    codec ??= load().catch((err) => {
      codec = null; // 失敗可重試
      throw err;
    });
    return codec;
  };
  return {
    // 回 { frames: n } | { error: 'too-long'|'empty' } | null（不知道）
    async count(text) {
      try {
        const r = (await ready()).pack(text);
        return r.error ? { error: r.error } : { frames: r.frames.length };
      } catch {
        return null;
      }
    },
    // planTx 的結果（opts 不含 codec）；編碼器載入失敗或規劃丟例外回 null
    async plan(raw, opts = {}) {
      try {
        return planTx(raw, { ...opts, codec: await ready() });
      } catch {
        return null;
      }
    },
    // 回 { parts: [{ text, plan }] }（1 則以上）| { error, plan }（空的、表外字元；巨集太長）| null（編碼器載入失敗）
    async split(raw, opts = {}) {
      try {
        const codec = await ready();
        const one = planTx(raw, { ...opts, codec, capacity: false }); // 太長就分則，用不到可用字數
        if (!one.error) return { parts: [{ text: String(raw), plan: one }] };
        if (one.error !== 'too-long' || opts.isMacro) return { error: one.error, plan: one };
        // 分則時每則都要附發話者 frame（strictSender），規劃次數多，不算可用字數
        return splitMessage(raw, (s) => planTx(s, { ...opts, codec, strictSender: true, capacity: false }));
      } catch {
        return null;
      }
    },
  };
}
