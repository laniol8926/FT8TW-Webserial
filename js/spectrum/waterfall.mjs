// 頻譜＋瀑布圖元件（add-web-transmit D21、tasks 6.1～6.2），外觀仿 FT8TW SpectrumFragment：
// 上方頻率尺（黃色三角形＝發射聲音頻率）、頻譜曲線、下方瀑布圖（最新在上、往下捲）；
// 每個 slot 邊界畫白＋紅雙線與「UTC : hh:mm:ss ↑ 時序 ↑」；解碼到的呼號以直書標在該 slot 的頻率上；
// 點一下（觸控）回報頻率。
//
// 效能：FFT 在 spectrum-worker，每 160 ms 一幀；畫圖用 requestAnimationFrame 且只在有變動時畫；
// 分頁在背景或元件 display:none（ResizeObserver 量到 0）時不送 FFT、不畫。
import {
  Agc, BIN_HZ, adjustRange, FFT_SIZE, Framer, HOP, RowClock, binsFor, buildLut, freqToX, labelStep, markColor, markLabel, pickFreq,
  rulerTicks, slotLabel, toLevels,
} from './model.mjs';

const RULER_H = 30; // CSS px；有外部 rulerCanvas 時不佔主畫布
const MAX_INFLIGHT = 3; // Worker 積壓超過就丟幀，免得延遲越來越大
const COLORS = { bg: '#000', ruler: '#00ffff', tx: '#ffff00', line: '#ffffff', slotRed: '#ff0000', label: '#00ffff' };

function defaultWorker() {
  return new Worker(new URL('../../worker/spectrum-worker.mjs', import.meta.url), { type: 'module' });
}

export function createWaterfall({
  canvas, rulerCanvas = null, onPickFreq = () => {}, maxHz = 3000, rowPx = 2, history = 1024,
  markEnabled = true, adjust = { zeroDb: 0, gainDb: 0 }, myCall = () => '', createWorker = defaultWorker,
}) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  const bins = binsFor(maxHz);
  const lut = buildLut();
  const agc = new Agc();
  const framer = new Framer({ size: FFT_SIZE, hop: HOP });
  const rows = new RowClock(history);

  // 瀑布圖歷史畫在離屏畫布（寬＝bin 數、高＝history 列，與顯示尺寸無關，resize 只是縮放）。
  // 環狀倒放：第 r 列在 y = history-1-(r % history)，新的列 y 較小，畫的時候最多分兩段貼上。
  const off = doc.createElement('canvas');
  off.width = bins;
  off.height = history;
  const offCtx = off.getContext('2d');
  offCtx.fillStyle = COLORS.bg;
  offCtx.fillRect(0, 0, bins, history);
  const rowImg = offCtx.createImageData(bins, 1);
  const levels = new Uint8Array(bins);
  const curve = new Uint8Array(bins); // 最新一列的強度，畫頻譜曲線
  let lastDb = null;

  const state = {
    width: 0, height: 0, dpr: 1, visible: false, txHz: null, channelHz: null, markEnabled,
    stations: [], // JTTY 字幕各台 { freqHz, color }（jtty/ticker-ui.mjs）：頻率尺 ▼、瀑布圖通道虛線
    adjust: { ...adjust },
    boundaries: [], // { utc, parity }
    marks: [], // { utc, freqHz, label, color, periodMs }
    periodMs: 15000, lastSlotUtc: null,
    inflight: 0, dirty: true, raf: 0, destroyed: false,
  };

  const worker = createWorker();
  worker.onmessage = ({ data }) => {
    state.inflight = Math.max(0, state.inflight - 1);
    if (state.destroyed) return;
    addRow(data.db, data.utc);
  };

  function addRow(db, utc) {
    if (rows.count > 0 && utc <= rows.at(rows.count - 1)) return; // 時間倒退（重新開始接收）的殘幀
    lastDb = db;
    const range = adjustRange(agc.update(db, bins), state.adjust);
    toLevels(db, range, levels, bins);
    const px = rowImg.data;
    for (let i = 0; i < bins; i++) px.set(lut.subarray(levels[i] * 4, levels[i] * 4 + 4), i * 4);
    const r = rows.add(utc);
    offCtx.putImageData(rowImg, 0, history - 1 - (r % history));
    curve.set(levels);
    prune();
    invalidate();
  }

  // 捲出歷史的 slot 線與標記丟掉
  function prune() {
    const oldestUtc = rows.at(rows.oldest);
    if (state.boundaries.length && state.boundaries[0].utc < oldestUtc) state.boundaries = state.boundaries.filter((b) => b.utc >= oldestUtc);
    if (state.marks.length && state.marks[0].utc + state.marks[0].periodMs < oldestUtc) {
      state.marks = state.marks.filter((m) => m.utc + m.periodMs >= oldestUtc);
    }
  }

  const active = () => state.visible && !doc.hidden && !state.destroyed;

  function invalidate() {
    state.dirty = true;
    if (!state.raf && active()) state.raf = win.requestAnimationFrame(draw);
  }

  // ── 繪圖 ──
  function draw() {
    state.raf = 0;
    if (!active() || !state.dirty) return;
    state.dirty = false;
    const ctx = canvas.getContext('2d');
    const { width: W, height: H, dpr } = state;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    const rulerH = rulerCanvas ? 0 : RULER_H;
    const specH = Math.round(Math.min(140, Math.max(48, (H - rulerH) * 0.3)));
    const wfTop = rulerH + specH;
    if (rulerCanvas) drawRulerCanvas();
    else drawRuler(ctx, W, rulerH);
    drawSpectrum(ctx, W, rulerH, specH);
    drawWaterfall(ctx, W, wfTop, H - wfTop);
  }

  function drawRuler(ctx, W, h) {
    ctx.save();
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, h);
    ctx.strokeStyle = COLORS.ruler;
    ctx.fillStyle = COLORS.ruler;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = labelStep(W, maxHz);
    let lastRight = -Infinity;
    for (const t of rulerTicks(maxHz)) {
      const x = Math.round(freqToX(t.hz, W, maxHz)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, t.major ? 6 : 3);
      if (t.label && t.hz % step === 0) {
        const w = ctx.measureText(t.label).width;
        const lx = Math.min(W - w, Math.max(0, x - w / 2));
        if (lx >= lastRight + 4) { // 兩端貼邊後仍會撞到前一個標籤就略過
          ctx.fillText(t.label, lx, 7);
          lastRight = lx + w;
        }
      }
    }
    ctx.stroke();
    // JTTY 字幕各台：頻率尺下緣的 ▼（顏色同字幕色塊）；畫在黃色 ▲ 之前，重疊時發射頻率在上
    for (const st of state.stations) {
      const x = freqToX(st.freqHz, W, maxHz);
      ctx.fillStyle = st.color;
      ctx.beginPath();
      ctx.moveTo(x - 5, h - 10);
      ctx.lineTo(x + 5, h - 10);
      ctx.lineTo(x, h - 1);
      ctx.closePath();
      ctx.fill();
    }
    if (state.txHz !== null) {
      const x = freqToX(state.txHz, W, maxHz);
      ctx.fillStyle = COLORS.tx;
      ctx.beginPath();
      ctx.moveTo(x, h - 12);
      ctx.lineTo(x - 6, h - 1);
      ctx.lineTo(x + 6, h - 1);
      ctx.closePath();
      ctx.fill();
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      const label = `${state.txHz}Hz`;
      const w = ctx.measureText(label).width;
      ctx.fillText(label, x + 8 + w > W ? x - 8 - w : x + 8, h);
    }
    ctx.restore();
  }

  function drawRulerCanvas() {
    const r = rulerCanvas;
    const w = r.clientWidth;
    const h = r.clientHeight;
    if (!w || !h) return;
    const { dpr } = state;
    if (r.width !== Math.round(w * dpr)) r.width = Math.round(w * dpr);
    if (r.height !== Math.round(h * dpr)) r.height = Math.round(h * dpr);
    const ctx = r.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRuler(ctx, w, h);
  }

  function drawSpectrum(ctx, W, top, h) {
    if (rows.count === 0) return;
    ctx.save();
    const bottom = top + h;
    ctx.beginPath();
    ctx.moveTo(0, bottom);
    for (let x = 0; x <= W; x++) {
      const bin = Math.min(bins - 1, Math.round(maxHz * (x / W) / BIN_HZ));
      ctx.lineTo(x, bottom - (curve[bin] / 255) * (h - 4));
    }
    ctx.lineTo(W, bottom);
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, '#2a6cff');
    grad.addColorStop(1, '#00008a');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    drawChannel(ctx, W, top, h);
    if (state.txHz !== null) {
      const x = Math.round(freqToX(state.txHz, W, maxHz)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,0,0.6)';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    ctx.restore();
  }

  // JTTY 通道標示（add-web-jtty D12）：從 #tx-freq（最低 tone）起 channelHz 寬的半透明黃帶與兩條邊線
  function drawChannel(ctx, W, top, h) {
    drawStations(ctx, W, top, h);
    if (state.txHz === null || !state.channelHz) return;
    const x0 = Math.round(freqToX(state.txHz, W, maxHz));
    const x1 = Math.round(freqToX(state.txHz + state.channelHz, W, maxHz));
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,0,0.12)';
    ctx.fillRect(x0, top, Math.max(1, x1 - x0), h);
    ctx.strokeStyle = 'rgba(255,255,0,0.55)';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    for (const x of [x0 + 0.5, x1 + 0.5]) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + h);
    }
    ctx.stroke();
    ctx.restore();
  }

  // JTTY 字幕各台的通道（f～f＋channelHz）：兩條該台顏色的虛線
  function drawStations(ctx, W, top, h) {
    if (!state.channelHz || !state.stations.length) return;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    for (const st of state.stations) {
      ctx.strokeStyle = st.color;
      ctx.beginPath();
      for (const hz of [st.freqHz, st.freqHz + state.channelHz]) {
        const x = Math.round(freqToX(hz, W, maxHz)) + 0.5;
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + h);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawWaterfall(ctx, W, top, h) {
    if (h <= 0 || rows.count === 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, W, h);
    ctx.clip();
    const n = rows.count;
    const count = Math.min(n - rows.oldest, Math.ceil(h / rowPx));
    const y0 = history - 1 - ((n - 1) % history);
    const a = Math.min(count, history - y0);
    // 來源 x：bin i 的中心在 i+0.5，所以 0 Hz ↔ 0.5、maxHz ↔ maxHz/BIN_HZ+0.5
    const sx = 0.5;
    const sw = maxHz / BIN_HZ;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, sx, y0, sw, a, 0, top, W, a * rowPx);
    if (count > a) ctx.drawImage(off, sx, 0, sw, count - a, 0, top + a * rowPx, W, (count - a) * rowPx);
    drawChannel(ctx, W, top, h);

    const rowY = (row) => top + (n - 1 - row) * rowPx; // 該列上緣
    // slot 分隔線：白線在上、紅線在下（FT8TW），線在該 slot 第一列的下緣；標籤在線下方，箭頭指回這個 slot
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const b of state.boundaries) {
      const row = rows.rowAtOrAfter(b.utc);
      if (row === null || row <= rows.oldest) continue;
      const y = rowY(row) + rowPx;
      if (y > top + h) continue;
      ctx.fillStyle = COLORS.line;
      ctx.fillRect(0, y, W, 1);
      ctx.fillStyle = COLORS.slotRed;
      ctx.fillRect(0, y + 1, W, 1);
      const text = slotLabel(b.utc, b.parity);
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(48, y + 3, tw + 4, 15);
      ctx.fillStyle = COLORS.label;
      ctx.fillText(text, 50, y + 4);
    }

    // 訊息標記：從該 slot 的最上緣（最新一列，即下一條 slot 線下方）往下直書
    if (state.markEnabled) {
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const m of state.marks) {
        const first = rows.rowAtOrAfter(m.utc);
        if (first === null) continue;
        const after = rows.rowAtOrAfter(m.utc + m.periodMs);
        const last = after === null ? n - 1 : Math.max(first, after - 1);
        const x = freqToX(m.freqHz, W, maxHz);
        const y = rowY(last) + 20; // 讓開 slot 線下方的時間標籤
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 2);
        const tw = ctx.measureText(m.label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(-1, -7, tw + 2, 14);
        ctx.fillStyle = m.color;
        ctx.fillText(m.label, 0, 0);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // ── 尺寸與可見性 ──
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = win.devicePixelRatio || 1;
    const visible = w > 0 && h > 0;
    if (!visible && state.visible) framer.reset(); // 藏起來的期間不累積，再出現時從新的音訊開始
    Object.assign(state, { width: w, height: h, dpr, visible });
    if (!visible) return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    invalidate();
  }
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => resize()) : null;
  observer?.observe(canvas);
  if (rulerCanvas) observer?.observe(rulerCanvas);
  const onVisibility = () => {
    if (doc.hidden) {
      framer.reset();
      if (state.raf) win.cancelAnimationFrame(state.raf);
      state.raf = 0;
    } else {
      invalidate();
    }
  };
  doc.addEventListener('visibilitychange', onVisibility);

  // ── 點選設定頻率：用 click 而非 pointerdown，觸控捲動（手指滑過畫布）不會誤改頻率 ──
  const onPointer = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    onPickFreq(pickFreq(e.clientX - rect.left, rect.width, maxHz));
  };
  canvas.addEventListener('click', onPointer);
  rulerCanvas?.addEventListener('click', onPointer);

  resize();

  return {
    // 接收中的 12 kHz 樣本（第一個樣本在 utc）；看不到時直接丟掉，不做 FFT
    push(samples, utc) {
      if (!active()) return;
      for (const f of framer.push(samples, utc)) {
        if (state.inflight >= MAX_INFLIGHT) continue;
        state.inflight++;
        worker.postMessage({ samples: f.samples, utc: f.utc, bins }, [f.samples.buffer]);
      }
    },
    // 解碼結果：[{ freqHz, text, utc（slot 起點）, periodMs? }]
    markMessages(items) {
      for (const it of items) {
        state.marks.push({
          utc: it.utc, freqHz: it.freqHz, label: markLabel(it.text), color: markColor(it.text, myCall()),
          periodMs: it.periodMs ?? state.periodMs,
        });
      }
      if (state.marks.length > 1000) state.marks.splice(0, state.marks.length - 1000);
      state.marks.sort((p, q) => p.utc - q.utc);
      invalidate();
    },
    // JTTY 通道寬度（Hz）；null＝不畫（其他模式）
    setChannel(widthHz) {
      const v = Number(widthHz);
      state.channelHz = widthHz !== null && Number.isFinite(v) && v > 0 ? v : null;
      invalidate();
    },
    // JTTY 字幕各台 [{ freqHz, color }]；空陣列＝不畫
    setStations(list) {
      state.stations = (list ?? []).filter((x) => Number.isFinite(x?.freqHz) && typeof x.color === 'string').map((x) => ({ freqHz: x.freqHz, color: x.color }));
      invalidate();
    },
    setTxFreq(hz) {
      const v = Number(hz);
      state.txHz = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
      invalidate();
    },
    // slot 邊界（起點 UTC、時序 0／1）；periodMs 省略時由相鄰兩次的間隔推得
    setSlot(utcStart, parity, periodMs) {
      if (state.lastSlotUtc === utcStart) return;
      if (periodMs) state.periodMs = periodMs;
      else if (state.lastSlotUtc !== null && utcStart > state.lastSlotUtc && utcStart - state.lastSlotUtc <= 30000) {
        state.periodMs = utcStart - state.lastSlotUtc;
      }
      state.lastSlotUtc = utcStart;
      state.boundaries.push({ utc: utcStart, parity });
      if (state.boundaries.length > 200) state.boundaries.shift();
      invalidate();
    },
    // 顯示調整（基準、對比，dB）：從下一列開始套用
    setAdjust({ zeroDb = 0, gainDb = 0 } = {}) {
      state.adjust = { zeroDb, gainDb };
    },
    setMarkEnabled(on) {
      state.markEnabled = Boolean(on);
      invalidate();
    },
    resize,
    // 本機開發／自動化檢查用：最新一列 dB 與目前狀態
    snapshot() {
      return {
        rows: rows.count, txHz: state.txHz, channelHz: state.channelHz, stations: state.stations.map((x) => ({ ...x })), visible: state.visible, marks: state.marks.length,
        boundaries: state.boundaries.length, binHz: BIN_HZ, latestDb: lastDb ? Array.from(lastDb) : null,
        firstUtc: rows.count ? rows.at(rows.oldest) : null, lastUtc: rows.count ? rows.at(rows.count - 1) : null,
        layout: { rulerH: rulerCanvas ? 0 : RULER_H, specH: Math.round(Math.min(140, Math.max(48, (state.height - (rulerCanvas ? 0 : RULER_H)) * 0.3))) },
      };
    },
    destroy() {
      state.destroyed = true;
      if (state.raf) win.cancelAnimationFrame(state.raf);
      observer?.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('click', onPointer);
      rulerCanvas?.removeEventListener('click', onPointer);
      worker.terminate();
    },
  };
}
