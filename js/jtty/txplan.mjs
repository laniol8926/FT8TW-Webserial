// JTTY 送出規劃（add-jtty-utx U2、U5、U6、U7、U10）：一則訊息 → 要發射的原始酬載序列 [{ hi, lo }]。純函式，codec 由呼叫端注入
// （主執行緒的 createJttyCodec，只用 pack／call28／unpack）。發射時 Worker 照這個序列產生波形（encodeFrames）。
//   - 發話者 frame（U10）：設定開、我的呼號是標準呼號、訊息沒有明確帶自己呼號（sender.mjs namesSelf）時放在第一個 frame；
//     16 frame 上限含這個 frame。一般訊息剛好 16 frame 時不附（不因此拒送）；UTX 訊息的容量先扣掉它
//   - 強化編碼（U5）：開關開、不是巨集、needsUtxJtty 時走 UTX：開頭呼號字照一般 frame（不設 EOM），其餘 UTX frame（保留 bit＝1）
//   - 其餘照 JTTY 原樣（正規化成大寫）；開關關或巨集時 TEXT5 以外的字拒送
//   - 糾錯 frame（add-jtty-fec E1～E5）：fec＝'standard'（每則 2 個）／'strong'（4 個）／'off'；發話者 frame 以外 ≥3 個資料 frame 才加，
//     接在 EOM 之後（frames 的最後）。frameCount＝資料 frame 數（16 上限與分則只看它）；parityCount、totalFrames、seconds 含校驗 frame
import { normalize, unsupportedChars } from './text5.mjs';
import { needsUtxJtty, planUtxMessage, toHiLo, MAX_FRAMES } from './utxframes.mjs';
import { namesSelf } from './sender.mjs';
import { parityFrames, fecLevel } from './fec.mjs';

export const FRAME_SEC = 1.888;
export const SENDER_EXT_TYPE = 0b010;

/** 發話者 frame 的酬載（S＝1、類型 010、call28；保留 bit 1、EOM 0）；非標準呼號回 null */
export function senderFrame(codec, call) {
  const c28 = codec.call28(String(call ?? '').trim().toUpperCase());
  if (!Number.isInteger(c28) || c28 < 0) return null;
  return toHiLo((((0b1000 | SENDER_EXT_TYPE) << 28) | c28) >>> 0, { reserved: 1 });
}

// 開頭呼號字 → 一個 frame（不設 EOM）；打包不是單一呼號字回 null
function callWordFrame(codec, text) {
  const r = codec.pack(text);
  if (r.error || r.frames.length !== 1) return null;
  const f = r.frames[0];
  if (codec.unpack(f.hi, f.lo)?.kind !== 'call') return null;
  return { hi: f.hi, lo: (f.lo & ~1) >>> 0 };
}

// 資料 frame（含發話者 frame）＋糾錯 frame
function done(frames, extra, fec) {
  const r = fec && fec !== 'off' ? fecLevel(fec) : 0;
  const words = frames.map(({ hi, lo }) => ((((hi & 3) << 30) | (lo >>> 2)) >>> 0));
  const parity = parityFrames(words, r, { contentFrames: frames.length - (extra.sender ? 1 : 0) });
  const total = frames.length + parity.length;
  return { ...extra, frames: [...frames, ...parity], frameCount: frames.length, parityCount: parity.length, totalFrames: total, seconds: total * FRAME_SEC };
}

/**
 * @param {string} raw 輸入框原文（或巨集展開後的文字）
 * @param {{ codec, utxOn?: boolean, isMacro?: boolean, myCall?: string, attachCall?: boolean, maxFrames?: number,
 *   strictSender?: boolean, capacity?: boolean, fec?: 'off'|'standard'|'strong' }} opts
 *   strictSender：發話者 frame 要附但放不下時當太長（自動分則 U12：每則都附，不因剛好 16 frame 就拿掉）；
 *   capacity＝false：太長時不算可用字數（分則規劃用，省時間）
 *   fec：糾錯 frame 等級（預設 'off'；畫面依設定傳入）
 * @returns 成功：{ text（泡泡文字）, frames（含糾錯 frame）, frameCount（資料 frame）, parityCount, totalFrames, seconds, utx, sender }；
 *   失敗：{ error: 'empty' } | { error: 'unsupported', chars, index, canUtx } | { error: 'too-long', utx, capacityChars? }
 */
export function planTx(raw, { codec, utxOn = false, isMacro = false, myCall = '', attachCall = true, maxFrames = MAX_FRAMES, strictSender = false, capacity = true, fec = 'off' }) {
  const src = String(raw ?? '');
  if (!src.trim()) return { error: 'empty' };
  const sender = attachCall && !namesSelf(src, myCall) ? senderFrame(codec, myCall) : null;
  const reserve = sender ? 1 : 0;

  if (utxOn && !isMacro && needsUtxJtty(src)) {
    const plan = planUtxMessage(src, { isStandardCall: (tok) => codec.call28(tok) >= 0, maxFrames: maxFrames - reserve, withCapacity: capacity });
    if (plan.utx) {
      if (!plan.fits) return { error: 'too-long', utx: true, capacityChars: plan.capacityChars };
      const prefix = plan.prefixTexts.map((p) => callWordFrame(codec, p));
      if (prefix.some((f) => !f)) return { error: 'too-long', utx: true, capacityChars: 0 }; // 不會發生：切分已確認是標準呼號
      const body = plan.utxWords.map((w) => toHiLo(w.word, { reserved: 1, eom: w.last }));
      const text = [...plan.prefixTexts, plan.utxText].join(' ');
      return done([...(sender ? [sender] : []), ...prefix, ...body], { text, utx: true, sender: Boolean(sender) }, fec);
    }
  }

  const bad = unsupportedChars(src);
  if (bad.length) return { error: 'unsupported', chars: [...new Set(bad.map((b) => b.char))], index: bad[0].index, canUtx: !isMacro };
  const text = normalize(src).replace(/\s+/gu, ' ').trim();
  const r = codec.pack(text);
  if (r.error) return { error: r.error === 'empty' ? 'empty' : 'too-long', utx: false };
  const withSender = sender && r.frames.length + 1 <= maxFrames;
  if (sender && !withSender && strictSender) return { error: 'too-long', utx: false };
  return done([...(withSender ? [sender] : []), ...r.frames], { text, utx: false, sender: Boolean(withSender) }, fec);
}
