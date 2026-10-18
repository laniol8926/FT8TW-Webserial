// JTTY 多 frame 組合（add-web-jtty jtty-protocol「多 frame 組合」）：
// 收到的 frame 若在前一 frame 之後 n 個週期（n＝1～3，±100 ms）、且頻率在訊息頻率 10＋3(n−1) Hz 內，接到同一則；
// n＞1 時中間插入 `...`；EOM 結束為完整；三個週期內沒有後續以「不完整」結束；同時最多追蹤 30 則，超過丟最舊的。
// frame 之間的文字直接相接（空白屬於 frame 內容；呼號字與 TEXT5 之間的空白由 Wave C 打包／解包決定）。
//
// 保留 bit＝1 的擴充 frame（kind 'ext'，add-jtty-utx U3、U4、U10）：
//   - 發話者 frame（ext 'sender'）：一次發射的第一個 frame → 開新訊息並記下 sender；同頻率接得上的未完訊息先以不完整結束。
//     只有發話者 frame、沒有內容的訊息不發事件（逾時悄悄丟掉）
//   - UTX（ext 'utx'）：S＝1 類型 001 開 UTX 段（新訊息，或接在同一則的發話者／呼號字 frame 之後）；
//     S＝0 只接到時間與頻率吻合、UTX 段進行中的訊息，否則丟棄（回 null，不建訊息）；段的增量文字直接接到訊息文字。
//     UTX 段停止（漏中段、非法內容）後的 frame 照收不出字；EOM 時段完整才算完整；逾時 abort
//   - UTX 段進行中的訊息不接保留 bit＝0 的 frame（多半是同頻率的別台或雜訊，接上會弄壞強化文字）
//   - ext frame 推入後在 frame 物件上寫 dropped（是否丟棄）與 utxText（這個 frame 解出的字），給解碼列表用
// UTX 段需要字表已載入（rx.mjs 在字表載入前暫存含 UTX frame 的結果）。
//
// 糾錯 frame（ext 'parity'，add-jtty-fec E5～E8）：不接到訊息上，另外收集。每個 frame（含被丟棄的 UTX 後續 frame）都記下內容字；
// 校驗 frame 依 n、校驗序號、欄推回訊息 slot 0 的起點（第 k 個資料 frame＝base＋k×1888 ms，±100 ms），同頻率（±10 Hz）、同 n 的歸成一組。
// 每來一個校驗 frame 就試著修復：該組的資料 frame 依時間排位；收到的與 n 一致（第 n−1 個才有 EOM、第 n 個位置沒有資料 frame）、
// 至少收到一個（孤立的校驗 frame 不用）；缺的數量 ≤ 各欄收到的校驗符號數就解出，還原保留 bit 與 EOM（fecrx.mjs，只有一種解讀才算），
// 用新的組合器重播一次（須組成同一則、完整）→ 取代原本那則（沿用 id 與起點，泡泡原地更新），快照帶 repaired（修復的 frame 數）、
// 修復的 frame 標 repaired。需要注入 unpack（WASM codec.unpack）；沒有就不修復（校驗 frame 照樣丟棄）。
import { JttyUtxSegment } from './utxsegment.mjs';
import { isUtxContinuation } from './utxframes.mjs';
import { parseParityWord, paritySlot, recoverWords, slotOf, PARITY_N_MAX } from './fec.mjs';
import { payloadOf, interpretations } from './fecrx.mjs';

export const FRAME_MS = 1888;
export const TIME_TOL_MS = 100;
export const MAX_GAP_FRAMES = 3;
export const MAX_TRACKED = 30;
export const GAP_MARK = '...';
export const FEC_FREQ_TOL_HZ = 10;
export const FEC_KEEP_FRAMES = PARITY_N_MAX + 8; // 記住多久以前的 frame／結束的訊息（校驗 frame 最晚在訊息起點後 n＋4 個週期）
const MAX_HEARD = 2000;

export function freqTolHz(n) {
  return 10 + 3 * (n - 1);
}

// 兩個 frame 起點相差 dtMs：是第幾個週期之後（1～3），不是後續就回 null
export function frameGap(dtMs) {
  const n = Math.round(dtMs / FRAME_MS);
  if (n < 1 || n > MAX_GAP_FRAMES) return null;
  return Math.abs(dtMs - n * FRAME_MS) <= TIME_TOL_MS ? n : null;
}

// 最後一個 frame 起點為 lastT0 的訊息：可能的後續 frame 最晚的起點；超過這個時刻還沒有後續就是不完整
export function expiryUtc(lastT0) {
  return lastT0 + MAX_GAP_FRAMES * FRAME_MS + TIME_TOL_MS;
}

function validFrame(f) {
  return Boolean(f) && Number.isFinite(f.t0) && Number.isFinite(f.freqHz) && typeof f.text === 'string';
}

function snapshot(m) {
  const snrs = m.frames.map((f) => f.snr).filter(Number.isFinite);
  return {
    id: m.id,
    t0: m.t0,
    freqHz: m.freqHz,
    snr: snrs.length ? Math.max(...snrs) : null,
    text: m.text,
    state: m.state,
    frames: m.frames.map((f) => ({ ...f })),
    ...(m.evicted ? { evicted: true } : {}),
    ...(m.utx ? { utx: true } : {}),
    ...(m.sender ? { sender: m.sender } : {}),
    ...(m.repaired ? { repaired: m.repaired } : {}),
  };
}

const isExt = (f) => f.kind === 'ext';

export class JttyAssembler {
  // onUpdate(snapshot)：每次訊息新增、接上 frame、結束（完整／不完整）都通知一次，UI 用 id 更新同一個泡泡
  // unpack(hi, lo)：WASM codec.unpack（糾錯修復時檢查文法）；null＝不修復
  constructor({ onUpdate = () => {}, maxTracked = MAX_TRACKED, unpack = null } = {}) {
    this.onUpdate = onUpdate;
    this.maxTracked = maxTracked;
    this.unpack = unpack;
    this.nextId = 1;
    this.tracked = []; // 接收中的訊息，最舊的在前
    this.heard = []; // 收過的 frame 的內容字（糾錯用）：{ t0, freqHz, snr, word, reserved, eom, msgId }
    this.groups = []; // 校驗 frame 組：{ base, freqHz, n, parity: Map, done, lastT0 }
    this.ended = new Map(); // 結束不久的訊息 id → { t0, lastT0 }（修復時沿用起點）
  }

  get open() {
    return this.tracked.map(snapshot);
  }

  clear() {
    this.tracked = [];
    this.heard = [];
    this.groups = [];
    this.ended.clear();
  }

  // 同一個解碼視窗的結果：解碼器輸出順序不保證，先依起點排序（同一則的兩個 frame 可能落在同一視窗）
  pushAll(frames) {
    return [...frames].sort((a, b) => a.t0 - b.t0).map((f) => this.push(f));
  }

  // 時間與頻率接得上 f 的追蹤中訊息（filter 再篩），依頻率差由小到大
  candidates(f, filter = () => true) {
    const out = [];
    for (const m of this.tracked) {
      const n = frameGap(f.t0 - m.lastT0);
      const df = Math.abs(f.freqHz - m.freqHz);
      if (n === null || df > freqTolHz(n) || !filter(m)) continue;
      out.push({ m, n, df });
    }
    return out.sort((a, b) => a.df - b.df);
  }

  // 新訊息（超過上限先丟最舊的）
  openMessage(f, extra = {}) {
    if (this.tracked.length >= this.maxTracked) this.end(this.tracked[0], { evicted: true });
    const m = { id: this.nextId++, t0: f.t0, freqHz: f.freqHz, lastT0: f.t0, text: '', frames: [], state: 'receiving', content: false, utx: null, sender: null, ...extra };
    this.tracked.push(m);
    return m;
  }

  // frame 接到訊息上（文字已決定）；EOM 結束，否則通知更新（只有發話者 frame 時不通知）
  append(m, f, text, { gapMark = false, content = true, complete = true } = {}) {
    m.text += (gapMark ? GAP_MARK : '') + text;
    m.frames.push({ ...f, text });
    m.lastT0 = f.t0;
    if (content) m.content = true;
    if (f.eom) return this.end(m, { complete });
    const snap = snapshot(m);
    if (m.content) this.onUpdate(snap);
    return snap;
  }

  // frame：{ t0（UTC ms）, freqHz, snr, text, eom, kind?, ext?, word?, call? }；回傳所屬訊息的快照，不合格或丟棄回 null
  push(frame) {
    if (!validFrame(frame)) return null;
    if (isExt(frame) && frame.ext === 'parity') return this.pushParity(frame);
    const snap = this.pushFrame(frame);
    this.remember(frame, snap);
    return snap;
  }

  pushFrame(frame) {
    if (isExt(frame)) return this.pushExt(frame);
    const f = { t0: frame.t0, freqHz: frame.freqHz, snr: frame.snr, text: frame.text, eom: Boolean(frame.eom) };
    const best = this.candidates(f, (m) => !m.utx)[0];
    if (best) return this.append(best.m, f, f.text, { gapMark: best.n > 1 });
    return this.append(this.openMessage(f), f, f.text);
  }

  // 記下內容字（糾錯用）；拿不到酬載的（瀏覽器檢查注入、測試）不記
  remember(frame, snap) {
    const p = payloadOf(frame) ?? (isExt(frame) && Number.isInteger(frame.word) ? { word: frame.word >>> 0, reserved: 1, eom: Boolean(frame.eom) } : null);
    if (!p) return;
    this.heard.push({ t0: frame.t0, freqHz: frame.freqHz, snr: Number.isFinite(frame.snr) ? frame.snr : null, ...p, msgId: snap?.id ?? null });
    if (this.heard.length > MAX_HEARD) this.heard.splice(0, this.heard.length - MAX_HEARD);
  }

  // 糾錯 frame：歸組、試著修復。回修復後的快照，否則 null；frame.dropped＝這組還沒有任何對得上的資料 frame（解碼列表不列）
  pushParity(frame) {
    const p = Number.isInteger(frame.word) ? parseParityWord(frame.word) : null;
    frame.utxText = '';
    if (!p || frame.eom) {
      frame.dropped = true;
      return null;
    }
    const base = frame.t0 - paritySlot(p) * FRAME_MS;
    let g = this.groups.find((x) => x.n === p.n && Math.abs(x.base - base) <= TIME_TOL_MS && Math.abs(x.freqHz - frame.freqHz) <= FEC_FREQ_TOL_HZ);
    if (!g) {
      g = { base, freqHz: frame.freqHz, n: p.n, parity: new Map(), done: false, lastT0: frame.t0 };
      this.groups.push(g);
    }
    g.lastT0 = Math.max(g.lastT0, frame.t0);
    const key = `${p.col},${p.idx}`;
    if (!g.parity.has(key)) g.parity.set(key, { col: p.col, idx: p.idx, sym: p.sym });
    const slots = this.slots(g);
    frame.dropped = slots === null || slots.every((x) => x === null);
    return g.done ? null : this.repair(g, slots);
  }

  // 一組的資料 frame 依時間排位：[n] 每格 heard 紀錄或 null；同一格兩個不同內容字、或與 n 不一致（EOM 不在最後一格、
  // 第 n 格有資料 frame、slot 0 之前還有同一則的 frame）時回 null
  slots(g) {
    const out = new Array(g.n).fill(null);
    const before = []; // slot 0 之前 3 格內的 frame
    for (const h of this.heard) {
      if (Math.abs(h.freqHz - g.freqHz) > FEC_FREQ_TOL_HZ) continue;
      const k = slotOf(h.t0, g.base);
      if (k === null || k < -MAX_GAP_FRAMES) continue;
      if (k < 0) {
        before.push(h);
        continue;
      }
      if (k >= g.n) {
        if (k === g.n) return null; // 第 n 格應該是校驗 frame：n 對不上
        continue;
      }
      if (out[k] && (out[k].word !== h.word || out[k].reserved !== h.reserved)) return null;
      out[k] = h;
    }
    // EOM 只在最後一格
    if (out.some((h, k) => h && h.eom !== (k === g.n - 1))) return null;
    // slot 0 之前還有同一則的 frame：訊息比 n 長，n 對不上
    const ids = new Set(out.filter((h) => h && h.msgId !== null).map((h) => h.msgId));
    if (before.some((h) => h.msgId !== null && ids.has(h.msgId))) return null;
    return out;
  }

  repair(g, slots) {
    if (!this.unpack || !slots || slots.every((h) => h === null)) return null; // 沒有 unpack、n 對不上、孤立的校驗 frame
    const missing = slots.filter((h) => h === null).length;
    if (missing === 0) {
      g.done = true; // 全收到，不必修
      return null;
    }
    const words = recoverWords(slots.map((h) => (h ? h.word : null)), [...g.parity.values()]);
    if (!words) return null; // 校驗 frame 還不夠：等下一個
    const ids = [...new Set(slots.filter((h) => h && h.msgId !== null).map((h) => h.msgId))];
    if (ids.length > 1) return null; // 收到的 frame 分屬多則（不該發生）：不動
    const freqHz = slots.find(Boolean).freqHz;
    const unpack = (hi, lo) => {
      try {
        return this.unpack(hi, lo);
      } catch {
        return null;
      }
    };
    const results = [];
    for (const cand of interpretations({ words, received: slots, base: g.base, freqHz, unpack })) {
      const snap = replay(cand.frames);
      if (snap) results.push({ cand, snap });
    }
    if (results.length !== 1) return null; // 沒有或不只一種解讀：不修復
    g.done = true;
    const { cand, snap } = results[0];
    const oldId = ids[0] ?? null;
    const old = oldId === null ? null : this.tracked.find((m) => m.id === oldId) ?? this.ended.get(oldId) ?? null;
    if (oldId !== null) {
      this.tracked = this.tracked.filter((m) => m.id !== oldId);
      this.ended.delete(oldId);
    }
    const id = oldId ?? this.nextId++;
    const m = {
      id, t0: old ? old.t0 : snap.t0, freqHz: snap.freqHz, lastT0: snap.frames.at(-1).t0, text: snap.text, state: 'complete',
      frames: snap.frames.map((f, k) => ({ ...f, ...(cand.frames[k].repaired ? { repaired: true } : {}) })),
      utx: snap.utx, sender: snap.sender ?? null, repaired: missing,
    };
    this.ended.set(id, { t0: m.t0, lastT0: m.lastT0 });
    const out = snapshot(m);
    this.onUpdate(out);
    return out;
  }

  pushExt(frame) {
    const f = { t0: frame.t0, freqHz: frame.freqHz, snr: frame.snr, eom: Boolean(frame.eom), kind: 'ext', ext: frame.ext };
    const drop = () => {
      frame.dropped = true;
      frame.utxText = '';
      return null;
    };
    if (frame.ext === 'sender' && frame.call) {
      // 新的一次發射：同頻率還沒結束的訊息不會再有後續
      for (const c of this.candidates(f)) this.end(c.m);
      frame.dropped = false;
      frame.utxText = '';
      return this.append(this.openMessage(f, { sender: frame.call }), { ...f, call: frame.call }, '', { content: false });
    }
    if (frame.ext !== 'utx' || !Number.isInteger(frame.word)) return drop();
    const word = frame.word >>> 0;
    const cands = this.candidates(f);
    let target = null;
    if (JttyUtxSegment.isStart(word)) {
      // 接在同一則的發話者／呼號字 frame 之後；否則開新訊息
      target = cands.find((c) => !c.m.utx) ?? null;
      if (target) target.m.utx = new JttyUtxSegment();
    } else if (!isUtxContinuation(word)) {
      return drop(); // S＝1 但不是已定義的類型
    } else {
      // S＝0：只接到 UTX 段還在的訊息（段已因漏 frame 停止的照收不出字，直到 EOM）
      target = cands.find((c) => c.m.utx) ?? null;
      if (!target) return drop();
    }
    const m = target ? target.m : this.openMessage(f, { utx: new JttyUtxSegment() });
    const r = m.utx.feed({ word, eom: f.eom, gap: target ? target.n : 1 });
    if (!r.accepted) return drop();
    frame.dropped = false;
    frame.utxText = r.delta;
    return this.append(m, { ...f, word }, r.delta, { complete: m.utx.state === 'complete' });
  }

  // 時鐘修正（SampleBuffer.shift）：之後的 frame 用新的時間標記，接收中的訊息一起移，免得間隔差了 deltaMs 接不上
  shift(deltaMs) {
    for (const m of this.tracked) {
      m.t0 += deltaMs;
      m.lastT0 += deltaMs;
      for (const f of m.frames) f.t0 += deltaMs;
    }
    for (const h of this.heard) h.t0 += deltaMs;
    for (const g of this.groups) {
      g.base += deltaMs;
      g.lastT0 += deltaMs;
    }
    for (const e of this.ended.values()) {
      e.t0 += deltaMs;
      e.lastT0 += deltaMs;
    }
  }

  // upToUtc：起點早於此時刻的 frame 都已送達（StreamCutter 的視窗解完時＝視窗起點＋acceptMs）。
  // 用資料時間而不是牆上時鐘：frame 要等視窗切出與解碼完才會到，牆上時鐘會讓 n＝3 的後續還沒到就逾時
  // 只有發話者 frame 的訊息悄悄丟掉（不回傳、不通知）
  tick(upToUtc) {
    const out = this.tracked.filter((m) => expiryUtc(m.lastT0) < upToUtc).map((m) => this.end(m)).filter(Boolean);
    // 糾錯用的紀錄：只留最近 FEC_KEEP_FRAMES 個週期（upToUtc＝Infinity 時全清）
    const since = upToUtc - FEC_KEEP_FRAMES * FRAME_MS;
    this.heard = this.heard.filter((h) => h.t0 >= since);
    this.groups = this.groups.filter((g) => g.lastT0 >= since);
    for (const [id, e] of this.ended) if (!(e.lastT0 >= since)) this.ended.delete(id);
    return out;
  }

  end(m, { complete = false, evicted = false } = {}) {
    this.tracked = this.tracked.filter((x) => x !== m);
    m.utx?.abort();
    m.state = complete ? 'complete' : 'incomplete';
    if (evicted) m.evicted = true;
    this.ended.set(m.id, { t0: m.t0, lastT0: m.lastT0 });
    if (!m.content) return null;
    const snap = snapshot(m);
    this.onUpdate(snap);
    return snap;
  }
}

// 補齊的 frame 列重播一次：須組成同一則、完整（EOM）且沒有缺段；否則回 null
function replay(frames) {
  let last = null;
  const asm = new JttyAssembler({ onUpdate: (snap) => { last = snap; } });
  for (const f of frames) asm.push({ ...f });
  if (!last || last.state !== 'complete' || last.frames.length !== frames.length || last.text.includes(GAP_MARK)) return null;
  return last;
}
