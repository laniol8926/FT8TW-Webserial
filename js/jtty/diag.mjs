// JTTY 收訊診斷（使用者 2026-10-10：「似乎沒有保證送達的感覺，中間有一部分中斷了」）：只觀測、不改接收行為。
// 收集（環形緩衝，最近 10 分鐘、各最多 300 筆；每個視窗只記摘要，不存樣本）：
//   - 解碼視窗：起點、Worker 往返與解碼耗時、候選數（解碼器輸出）與留下的 frame 數、每個 frame 的 sync／nsync／nsymerr 與是否被去重、
//     StreamCutter 的 dropped／skipped 累計、當下分頁可見狀態、音訊 RMS（dBFS）與是否削波
//   - 事件：SampleBuffer 清空（gap，含長度）、視窗重新對齊（緩衝清空後跳過的範圍）、丟棄／跳過的視窗、時鐘 shift、
//     分頁前景／背景、AudioContext 狀態、瀏覽器音訊處理（processingStillOn）
//   - 訊息：組合器結束的每則（frame 序列、缺段位置與缺幾個週期、結束原因、頻率漂移、SNR 範圍）；
//     糾錯修復（add-jtty-fec）後同一則會再來一次：取代先前那筆，記「已修復」與修復數（修復的 frame 仍算缺，照樣找原因）
//   - 差一點接上：新訊息的第一個 frame 與別則最後一個 frame 同頻 ±30 Hz、間隔 n×1888 ±300 ms，但超出組合器容差
// diagnose(snapshot)：純函式，把每個缺的 frame 對到當時的視窗與事件，依規則產出 1～3 條原因（i18n key＋參數，由畫面翻譯）。
import { FRAME_MS, TIME_TOL_MS, MAX_GAP_FRAMES, freqTolHz } from './assembler.mjs';
import { ACCEPT_MS, OVERLAP_MS } from './stream.mjs';

export const DIAG_MAX_AGE_MS = 600_000;
export const DIAG_MAX_ITEMS = 300;
// 訊號太弱：缺段前後的 SNR 在這以下。本解碼器 −12 dB 幾乎全收、−13 dB 起開始漏 frame、−15 dB 以下幾乎解不出
// （2026-10-10 以 Node 串流解碼量測），所以門檻放在 −12 dB（不是 WSJT-X 的 −15 dB 級距）
export const WEAK_SNR_DB = -12;
export const NEAR_TIME_MS = 300;
export const NEAR_FREQ_HZ = 30;
export const CLIP_LEVEL = 0.99;
export const MAX_RULES = 3;
export const SPLIT_FRAMES = 5; // 被拆成兩則的同一次發射：前一則最後 frame 後 5 個週期內同頻開始的算後續（自動分則預設休息 4 frame，下一則在 6 個週期後，不算）
const MIN_DB = -120;
const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const round = (x) => (Number.isFinite(x) ? Math.round(x) : null);

// 視窗音訊電平：RMS（dBFS，全靜音記 −120）、峰值、是否削波。迴圈一次，4 s 視窗約 48k 樣本
export function audioLevel(samples) {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return { rmsDb: rms > 0 ? Math.max(MIN_DB, round1(20 * Math.log10(rms))) : MIN_DB, peak: Math.round(peak * 1000) / 1000, clipped: peak >= CLIP_LEVEL };
}

// 組合器結束的訊息快照 → 摘要：frame 序列、缺段（第幾個 frame 之後缺幾個週期）、結束原因、頻率漂移、SNR 範圍；
// 糾錯修復過的：end 'repaired'、repaired＝修復數，修復的 frame 標 repaired（不算缺段，但算進 missing）
export function messageSummary(snap) {
  const frames = (snap.frames ?? []).filter((f) => Number.isFinite(f.t0));
  const seq = frames.map((f) => ({ t0: f.t0, freqHz: round1(f.freqHz), snr: Number.isFinite(f.snr) ? f.snr : null, eom: Boolean(f.eom), ...(f.kind === 'ext' ? { kind: 'ext' } : {}),
    ...(f.repaired ? { repaired: true } : {}) }));
  const gaps = [];
  for (let i = 1; i < frames.length; i++) {
    const n = Math.round((frames[i].t0 - frames[i - 1].t0) / FRAME_MS);
    if (n > 1) gaps.push({ after: i - 1, missing: n - 1 });
  }
  const last = frames.at(-1);
  let end = 'receiving';
  if (snap.evicted) end = 'evicted';
  else if (snap.state === 'complete' && snap.repaired) end = 'repaired';
  else if (snap.state === 'complete') end = 'eom';
  else if (snap.state === 'incomplete') end = last?.eom ? 'eomIncomplete' : 'timeout';
  const snrs = seq.map((f) => f.snr).filter(Number.isFinite);
  const freqs = frames.filter((f) => !f.repaired).map((f) => f.freqHz).filter(Number.isFinite);
  const repaired = seq.filter((f) => f.repaired).length;
  return {
    id: snap.id,
    t0: snap.t0,
    freqHz: round1(snap.freqHz),
    text: String(snap.text ?? ''),
    frames: seq,
    gaps,
    missing: gaps.reduce((s, g) => s + g.missing, 0) + (end === 'timeout' || end === 'evicted' ? 1 : 0) + repaired,
    end,
    snrMin: snrs.length ? Math.min(...snrs) : null,
    snrMax: snrs.length ? Math.max(...snrs) : null,
    driftHz: freqs.length ? round1(Math.max(...freqs) - Math.min(...freqs)) : 0,
    ...(snap.utx ? { utx: true } : {}),
    ...(repaired ? { repaired } : {}),
  };
}

// 一則訊息的 frame 圖：● 收到、◐ 糾錯補回、○ 缺（中間缺段＋逾時／被擠掉的結尾）
export function frameDots(m) {
  let s = '';
  m.frames.forEach((f, i) => {
    s += f.repaired ? '◐' : '●';
    const g = m.gaps.find((x) => x.after === i);
    if (g) s += '○'.repeat(g.missing);
  });
  if (m.end === 'timeout' || m.end === 'evicted') s += '○';
  return s;
}

// 新訊息第一個 frame f 與別則最後一個 frame（prev）：在 ±NEAR 範圍內、但組合器（±100 ms、10＋3(n−1) Hz）接不上就回差一點的紀錄
export function nearMiss(f, prev) {
  const dt = f.t0 - prev.lastT0;
  const n = Math.round(dt / FRAME_MS);
  if (n < 1 || n > MAX_GAP_FRAMES) return null;
  const timeErrMs = dt - n * FRAME_MS;
  const dfHz = Math.abs(f.freqHz - prev.freqHz);
  if (Math.abs(timeErrMs) > NEAR_TIME_MS || dfHz > NEAR_FREQ_HZ) return null;
  const timeOk = Math.abs(timeErrMs) <= TIME_TOL_MS;
  const freqOk = dfHz <= freqTolHz(n);
  if (timeOk && freqOk) return null; // 接得上：不是容差的問題（多半是 UTX 段或發話者 frame 刻意另開）
  return { t0: f.t0, freqHz: round1(f.freqHz), prevT0: prev.lastT0, prevFreqHz: round1(prev.freqHz), n, timeErrMs: round(timeErrMs), dfHz: round1(dfHz), why: timeOk ? 'freq' : freqOk ? 'time' : 'both' };
}

class Ring {
  constructor(max) {
    this.max = max;
    this.items = [];
  }

  push(x) {
    this.items.push(x);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  prune(since) {
    let i = 0;
    while (i < this.items.length && this.items[i].at < since) i++;
    if (i) this.items.splice(0, i);
  }
}

export class JttyDiag {
  // now()：牆上時鐘（epoch ms，用來砍掉 10 分鐘以前的）；getVisibility()：'visible'｜'hidden'；onChange()：有新資料（畫面節流重畫）
  constructor({ now = () => Date.now(), getVisibility = () => 'visible', onChange = () => {}, maxItems = DIAG_MAX_ITEMS, maxAgeMs = DIAG_MAX_AGE_MS } = {}) {
    Object.assign(this, { now, getVisibility, onChange, maxAgeMs });
    this.windows = new Ring(maxItems);
    this.events = new Ring(maxItems);
    this.messages = new Ring(maxItems);
    this.nearMisses = new Ring(maxItems);
    this.env = { processingStillOn: [] };
    this.seen = new Map(); // 接收中／剛結束的訊息 id → { lastT0, freqHz, utx, done }（找差一點接上的）
  }

  changed() {
    const since = this.now() - this.maxAgeMs;
    for (const r of [this.windows, this.events, this.messages, this.nearMisses]) r.prune(since);
    this.onChange();
  }

  // 解碼視窗：{ startUtc, roundTripMs, workerMs, candidates, frames:[{ t0, freqHz, snr, sync, nsync, nsymerr, kind, dup }], dropped, skipped, rmsDb, peak, clipped, error? }
  window(w) {
    const frames = (w.frames ?? []).map((f) => ({
      t0: f.t0, freqHz: round1(f.freqHz), snr: Number.isFinite(f.snr) ? f.snr : null, sync: round1(f.sync), nsync: Number.isFinite(f.nsync) ? f.nsync : null,
      nsymerr: Number.isFinite(f.nsymerr) ? f.nsymerr : null, kind: f.kind ?? 'text', ...(f.dup ? { dup: true } : {}),
    }));
    this.windows.push({
      at: this.now(), startUtc: w.startUtc, roundTripMs: round(w.roundTripMs), workerMs: round(w.workerMs),
      candidates: w.candidates ?? frames.length, kept: frames.filter((f) => !f.dup).length, frames,
      dropped: w.dropped ?? 0, skipped: w.skipped ?? 0, visibility: w.visibility ?? this.getVisibility(),
      rmsDb: w.rmsDb ?? null, peak: w.peak ?? null, clipped: Boolean(w.clipped), ...(w.error ? { error: String(w.error) } : {}),
    });
    this.changed();
  }

  // 事件：gap { utc, ms }、realign { fromUtc, toUtc }、dropped { startUtc, n }、skipped { startUtc }、clockShift { ms, utc }、
  // visibility { state }、audioState { state }、reset { reason }
  event(type, data = {}) {
    this.events.push({ at: this.now(), type, ...data });
    this.changed();
  }

  setEnv(env) {
    Object.assign(this.env, env);
    this.onChange();
  }

  // 組合器的每次更新：新訊息先找差一點接上的；結束的記摘要
  message(snap) {
    const frames = snap.frames ?? [];
    const last = frames.at(-1);
    if (!last) return;
    if (!this.seen.has(snap.id)) {
      const first = frames[0];
      const opened = !(first.kind === 'ext' && first.ext === 'sender') && !snap.utx; // 發話者 frame、UTX 段都是刻意另開
      if (opened) {
        for (const [id, prev] of this.seen) {
          if (id === snap.id || prev.done || prev.utx) continue;
          const nm = nearMiss(first, prev);
          if (nm) this.nearMisses.push({ at: this.now(), msgId: snap.id, prevMsgId: id, ...nm });
        }
      }
    }
    const done = snap.state !== 'receiving';
    this.seen.set(snap.id, { lastT0: last.t0, freqHz: snap.freqHz, utx: Boolean(snap.utx), done: done && snap.state === 'complete' });
    // 只留最近的（差一點接上最多相隔 3 個週期）
    for (const [id, prev] of this.seen) if (last.t0 - prev.lastT0 > (MAX_GAP_FRAMES + 1) * FRAME_MS) this.seen.delete(id);
    if (done && snap.repaired) this.messages.items = this.messages.items.filter((x) => x.id !== snap.id); // 修復後取代先前那筆
    if (done) this.messages.push({ at: this.now(), ...messageSummary(snap) });
    this.changed();
  }

  clear() {
    for (const r of [this.windows, this.events, this.messages, this.nearMisses]) r.items = [];
    this.seen.clear();
    this.onChange();
  }

  snapshot() {
    const since = this.now() - this.maxAgeMs;
    const keep = (r) => r.items.filter((x) => x.at >= since).map((x) => structuredClone(x));
    return {
      kind: 'ft8tw-jtty-diag',
      version: 1,
      createdAt: this.now(),
      env: structuredClone(this.env),
      windows: keep(this.windows),
      events: keep(this.events),
      messages: keep(this.messages),
      nearMisses: keep(this.nearMisses),
    };
  }
}

// 快照 → JSON 文字（給使用者貼給開發者）。只有收訊統計、訊息文字（呼號與內容）與時間，沒有其他個資
export function serializeSnapshot(snap, extra = {}) {
  return JSON.stringify({ ...snap, ...extra });
}

// 起點 E 的 frame 會由哪個視窗收（起點在 [startUtc, startUtc＋2.1 s)）
const covers = (w, e) => w.startUtc <= e && e < w.startUtc + ACCEPT_MS + OVERLAP_MS;
// frame [e, e＋1888) 與時間範圍 [a, b] 重疊
const overlaps = (e, a, b) => e < b && e + FRAME_MS > a;

// 每則訊息缺的 frame：中間的缺段（第 k 個週期）＋逾時／被擠掉的結尾（下一個週期；被拆成兩則時到後一則開始前）。附前後 frame 的 SNR
export function missingFrames(messages) {
  const out = [];
  for (const m of messages) {
    const fs = m.frames;
    // 糾錯補回的 frame：當時也是沒收到
    const got = fs.filter((f) => !f.repaired).map((f) => f.snr).filter(Number.isFinite);
    for (const f of fs) if (f.repaired) out.push({ msgId: m.id, t0: f.t0, freqHz: m.freqHz, snr: got.length ? Math.max(...got) : null, where: 'repaired' });
    for (const g of m.gaps) {
      const a = fs[g.after];
      const b = fs[g.after + 1];
      const snr = [a.snr, b.snr].filter(Number.isFinite);
      for (let k = 1; k <= g.missing; k++) out.push({ msgId: m.id, t0: a.t0 + k * FRAME_MS, freqHz: m.freqHz, snr: snr.length ? Math.max(...snr) : null, where: 'gap' });
    }
    if ((m.end === 'timeout' || m.end === 'evicted') && fs.length) {
      // 結尾缺：連漏超過 3 個週期時組合器把同一次發射拆成兩則，後面那則（同頻、SPLIT_FRAMES 個週期內開始）之前的週期都算缺
      const a = fs.at(-1);
      const next = messages.filter((x) => x !== m && x.frames.length && Math.abs(x.freqHz - m.freqHz) <= NEAR_FREQ_HZ && x.frames[0].t0 > a.t0
        && x.frames[0].t0 - a.t0 <= SPLIT_FRAMES * FRAME_MS + NEAR_TIME_MS).sort((x, y) => x.frames[0].t0 - y.frames[0].t0)[0];
      const n = next ? Math.max(1, Math.round((next.frames[0].t0 - a.t0) / FRAME_MS) - 1) : 1;
      const snr = [a.snr, next?.frames[0].snr].filter(Number.isFinite);
      for (let k = 1; k <= n; k++) out.push({ msgId: m.id, t0: a.t0 + k * FRAME_MS, freqHz: m.freqHz, snr: snr.length ? Math.max(...snr) : null, where: next ? 'split' : 'tail' });
    }
  }
  return out;
}

// 一個缺的 frame 當時的狀況 → 原因標記
export function classifyMissing(mf, snap) {
  const tags = new Set();
  const ev = snap.events;
  const ws = snap.windows;
  const w = ws.find((x) => covers(x, mf.t0));
  if (!w) {
    const gap = ev.some((e) => (e.type === 'gap' && overlaps(mf.t0, e.utc, e.utc + Math.abs(e.ms)))
      || (e.type === 'realign' && mf.t0 >= e.fromUtc - ACCEPT_MS && mf.t0 < e.toUtc + ACCEPT_MS));
    const dropped = ev.some((e) => (e.type === 'dropped' || e.type === 'skipped') && mf.t0 >= e.startUtc && mf.t0 < e.startUtc + (e.n ?? 1) * ACCEPT_MS + OVERLAP_MS);
    if (gap) tags.add('gap');
    else if (dropped) tags.add('dropped');
    else if (ws.length && ws[0].startUtc <= mf.t0 && mf.t0 <= ws.at(-1).startUtc) tags.add('dropped'); // 前後都有視窗、偏偏這個沒解
  } else {
    if (w.visibility === 'hidden') tags.add('hidden');
    if (w.clipped) tags.add('clip');
    if (w.error) tags.add('dropped');
  }
  if (Number.isFinite(mf.snr) && mf.snr <= WEAK_SNR_DB) tags.add('weak');
  if (snap.nearMisses.some((n) => Math.abs(n.t0 - mf.t0) <= NEAR_TIME_MS + TIME_TOL_MS && Math.abs(n.freqHz - mf.freqHz) <= NEAR_FREQ_HZ)) tags.add('nearMiss');
  if (ev.some((e) => e.type === 'clockShift' && Number.isFinite(e.utc) && Math.abs(e.utc - mf.t0) <= 2 * FRAME_MS)) tags.add('clock');
  return tags;
}

const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

// 視窗統計（畫面與規則共用）
export function windowStats(snap) {
  const ws = snap.windows;
  const rtt = ws.map((w) => w.roundTripMs).filter(Number.isFinite);
  const rms = ws.map((w) => w.rmsDb).filter(Number.isFinite);
  const ev = snap.events;
  const gaps = ev.filter((e) => e.type === 'gap');
  return {
    windows: ws.length,
    rttAvg: avg(rtt),
    rttMax: rtt.length ? Math.max(...rtt) : null,
    dropped: ev.filter((e) => e.type === 'dropped').reduce((s, e) => s + (e.n ?? 1), 0),
    skipped: ev.filter((e) => e.type === 'skipped').length,
    hiddenPct: ws.length ? Math.round((100 * ws.filter((w) => w.visibility === 'hidden').length) / ws.length) : 0,
    gaps: gaps.length,
    gapMs: gaps.reduce((s, e) => s + Math.abs(e.ms ?? 0), 0),
    rmsMin: rms.length ? Math.min(...rms) : null,
    rmsMax: rms.length ? Math.max(...rms) : null,
    clipped: ws.filter((w) => w.clipped).length,
    nearMisses: snap.nearMisses.length,
  };
}

// 規則的先後（同分時）
const ORDER = ['processing', 'weak', 'dropped', 'gap', 'hidden', 'nearMiss', 'clip', 'clock'];

// 快照 → 最可能的原因 1～3 條：[{ key, score, params }]；key 對應 i18n 'jtty.diag.rule.<key>'
export function diagnose(snap) {
  const stats = windowStats(snap);
  if (!snap.windows.length && !snap.messages.length) return [{ key: 'nodata', score: 0, params: {} }];
  const missing = missingFrames(snap.messages).map((mf) => ({ ...mf, tags: classifyMissing(mf, snap) }));
  const count = (tag) => missing.filter((m) => m.tags.has(tag)).length;
  const out = [];
  const add = (key, score, params) => out.push({ key, score, params });

  const stillOn = snap.env?.processingStillOn ?? [];
  if (stillOn.length) add('processing', 1000, { list: stillOn.join(', ') });

  const weak = missing.filter((m) => m.tags.has('weak'));
  if (weak.length && weak.length * 2 >= missing.length) add('weak', weak.length, { n: weak.length, total: missing.length, snr: Math.max(...weak.map((m) => m.snr)) });

  const nDropped = count('dropped');
  if (nDropped || stats.dropped || stats.skipped) add('dropped', nDropped || 0.5, { n: Math.max(stats.dropped + stats.skipped, nDropped), miss: nDropped, avg: stats.rttAvg ?? 0, max: stats.rttMax ?? 0 });

  const nGap = count('gap');
  if (nGap || stats.gaps) add('gap', nGap || 0.5, { n: stats.gaps, ms: stats.gapMs, miss: nGap });

  const nHidden = count('hidden');
  if (nHidden) add('hidden', nHidden, { n: nHidden });

  const nNear = count('nearMiss');
  if (snap.nearMisses.length) {
    const worst = snap.nearMisses.reduce((a, b) => (Math.abs(b.timeErrMs) > Math.abs(a.timeErrMs) ? b : a));
    const maxDf = Math.max(...snap.nearMisses.map((n) => n.dfHz));
    add('nearMiss', nNear || 0.5, { n: snap.nearMisses.length, ms: worst.timeErrMs, hz: maxDf });
  }

  if (stats.clipped) add('clip', count('clip') || 0.5, { n: stats.clipped });

  const nClock = count('clock');
  if (nClock) add('clock', nClock, { n: nClock });

  out.sort((a, b) => b.score - a.score || ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  if (missing.length && !out.some((r) => r.key !== 'processing' && r.score >= 1)) out.push({ key: 'unknown', score: 0, params: { n: missing.length } });
  if (!out.length) return [{ key: 'ok', score: 0, params: { n: snap.messages.length } }];
  return out.slice(0, MAX_RULES);
}

// 畫面摘要：最近 10 則訊息（新的在前）、視窗統計、原因
export function summarize(snap, { maxMessages = 10 } = {}) {
  return { messages: snap.messages.slice(-maxMessages).reverse(), stats: windowStats(snap), causes: diagnose(snap) };
}
