// 頻譜區塊（#spectrum-panel）與主頁的接線，讓 main.mjs 只需幾行：
// 樣本流 → 瀑布圖（並依模式算 slot 邊界）、解碼結果 → 標記、點選 → 寫入 #tx-freq 並觸發 change（沿用 tx/ui 的保存）、
// #tx-freq 變更 → 黃色三角形；右鍵（手機長按）開「瀑布圖顯示調整」（同 FT8TW 長按瀑布圖）：基準、對比、標記訊息 → localStorage。
import { SLOT_MS, isSlotMode } from '../slot.mjs';
import { periodMs as js8PeriodMs } from '../js8/submodes.mjs';
import { createWaterfall } from './waterfall.mjs';
import { loadSpectrumPrefs, saveSpectrumPrefs, slotParity } from './model.mjs';
import { LONG_PRESS_MS } from '../qso/contextmenu.mjs'; // 長按時間同右鍵選單
import { t } from '../i18n/index.mjs';

const MOVE_TOLERANCE_PX = 10;
const signed = (db) => `${db > 0 ? '+' : ''}${db} dB`;

export function initSpectrumPanel({ doc = document, storage, getMyCall = () => '' }) {
  const canvas = doc.getElementById('spectrum-canvas');
  if (!canvas) return null;
  const txInput = doc.getElementById('tx-freq');
  const markBox = doc.getElementById('spectrum-mark');
  const prefs = loadSpectrumPrefs(storage);

  const waterfall = createWaterfall({
    canvas,
    markEnabled: prefs.markMessages,
    adjust: prefs,
    myCall: getMyCall,
    onPickFreq: (hz) => {
      if (!txInput) return;
      // 再依輸入框自己的 min／max 夾一次（發射設定只接受這個範圍，超出的值重新整理後會被丟掉）
      const min = Number(txInput.min) || 0;
      const max = Number(txInput.max) || Infinity;
      txInput.value = String(Math.min(max, Math.max(min, hz)));
      txInput.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });

  const syncTx = () => waterfall.setTxFreq(txInput?.value);
  txInput?.addEventListener('change', syncTx);
  txInput?.addEventListener('input', syncTx);
  syncTx();

  // ── 瀑布圖顯示調整 ──
  const dialog = doc.getElementById('spectrum-adjust');
  const zero = doc.getElementById('spectrum-zero');
  const gain = doc.getElementById('spectrum-gain');
  function showAdjust() {
    zero.value = String(prefs.zeroDb);
    gain.value = String(prefs.gainDb);
    markBox.checked = prefs.markMessages;
    doc.getElementById('spectrum-zero-label').textContent = t('spectrum.zeroLabel', { value: signed(prefs.zeroDb) });
    doc.getElementById('spectrum-gain-label').textContent = t('spectrum.gainLabel', { value: signed(prefs.gainDb) });
  }
  function applyAdjust(patch) {
    Object.assign(prefs, patch);
    waterfall.setAdjust(prefs);
    waterfall.setMarkEnabled(prefs.markMessages);
    showAdjust();
  }
  const save = () => saveSpectrumPrefs(storage, prefs); // 放手才存（拖曳中只即時套用）
  if (dialog) {
    zero.addEventListener('input', () => applyAdjust({ zeroDb: Number(zero.value) }));
    gain.addEventListener('input', () => applyAdjust({ gainDb: Number(gain.value) }));
    zero.addEventListener('change', save);
    gain.addEventListener('change', save);
    markBox.addEventListener('change', () => {
      applyAdjust({ markMessages: markBox.checked });
      save();
    });
    doc.getElementById('spectrum-auto').addEventListener('click', () => {
      applyAdjust({ zeroDb: 0, gainDb: 0 });
      save();
    });
    doc.getElementById('spectrum-adjust-close').addEventListener('click', () => dialog.close());
    showAdjust(); // 開啟前就把滑桿標籤換成目前語系（含 ±dB），不留 HTML 的中文後備
    // 點對話框外面（backdrop）關閉。不能只看 target===dialog：點到對話框自己的內距也是 dialog
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    });
    const openAdjust = () => {
      showAdjust();
      if (dialog.open) return;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', ''); // 舊瀏覽器沒有 showModal：直接顯示
    };
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openAdjust();
    });
    // 觸控長按（iOS Safari 長按不會觸發 contextmenu）；移動就取消。長按後接著的 click 不改發射頻率
    let press = null;
    // 只取消同一根手指的長按（其他指標，例如滑鼠的 pointerleave，不算）
    const cancelPress = (e) => {
      if (!press || (e && e.pointerId !== press.id)) return;
      clearTimeout(press.timer);
      press = null;
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      clearTimeout(press?.timer);
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
        press = null;
        openAdjust();
        // 放開手指產生的 click 會落在對話框的背景上（畫布已被 modal 擋住），吞掉這一次：不關閉、不改發射頻率
        const swallow = (ev) => {
          ev.stopImmediatePropagation();
          ev.preventDefault();
        };
        doc.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => doc.removeEventListener('click', swallow, { capture: true }), 1500);
      }, LONG_PRESS_MS) };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE_PX) cancelPress(e);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(type, cancelPress);

  }

  let lastSlot = null;
  return {
    waterfall,
    syncTx,
    // node.port.onmessage 的每段樣本（utc＝第一個樣本的校正後 UTC）
    // periodMs：目前 slot 長度（JS8 依速度，add-web-js8-chat J2）；省略＝SLOT_MS[mode]
    push(samples, utc, mode, periodMs = SLOT_MS[mode] ?? SLOT_MS.FT8) {
      const period = periodMs;
      if (!isSlotMode(mode)) { // JTTY 串流模式：沒有時槽分隔線（add-web-jtty D4）
        waterfall.push(samples, utc);
        return;
      }
      const start = Math.floor(utc / period) * period;
      if (start !== lastSlot) {
        lastSlot = start;
        waterfall.setSlot(start, slotParity(start, period), period);
      }
      waterfall.push(samples, utc);
    },
    // 解碼器 Worker 的結果（FT8／FT4／FT2）
    onDecoded(data) {
      if (!data.results?.length) return;
      const periodMs = data.mode === 'JS8' ? js8PeriodMs(data.submode ?? 0) : SLOT_MS[data.mode]; // JS8 標記寬度依速度
      waterfall.markMessages(data.results.map((r) => ({ freqHz: r.freqHz, text: r.text, utc: data.startUtc, periodMs })));
    },
  };
}
