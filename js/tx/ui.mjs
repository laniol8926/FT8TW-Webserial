// 發射區塊的畫面串接（add-web-transmit T1）。依賴瀏覽器 API，以真瀏覽器檢查（tools/ui-tx-check.mjs）驗證；
// 邏輯在 controller／scheduler／guard／output／prefs，皆有單元測試。完整仿 FT8TW 的呼叫頁在 T3。
import { TxController } from './controller.mjs';
import { TxOutput } from './output.mjs';
import { cqParity } from './scheduler.mjs';
import { defaultTxText, loadTxPrefs, saveTxPrefs } from './prefs.mjs';
import { selectedDial } from '../bands.mjs';
import { formatUtc } from '../format.mjs';
import { loadConfig, supervisionMs } from '../config/model.mjs';
import { buildJs8Frames } from '../js8/encode.mjs';
import { loadJs8Tables } from '../js8/message.mjs';
import { t } from '../i18n/index.mjs';

const ENCODE_TIMEOUT_MS = 5000;

// 發射專用的編碼 Worker（與收訊的 Worker 分開，發射不必等解碼）。Worker 出錯就作廢，下次重建；每次編碼有逾時
function createEncoder() {
  let worker = null;
  const pending = new Map();
  let nextId = 1;
  const failAll = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('../../worker/decoder-worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve({ samples: data.samples });
    };
    worker.onerror = (e) => {
      worker.terminate();
      worker = null;
      failAll(new Error(e.message ?? t('tx.encoderLoadFailed')));
    };
    return worker;
  }
  // what：FT8／FT4／FT2 是文字；JS8 是 { frame: { payload, itype } }；JTTY 原始酬載序列是 { jttyFrames: [{ hi, lo }] }（add-jtty-utx）
  return (what, { mode, freqHz, freeText, submode = 0 }) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(t('tx.encodeTimeout')));
    }, ENCODE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    const body = typeof what === 'string' ? { text: what }
      : what.jttyFrames ? { frames: what.jttyFrames.map(({ hi, lo }) => ({ hi, lo })) }
        : { frame: { payload: Array.from(what.frame.payload), itype: what.frame.itype } };
    ensureWorker().postMessage({ id, kind: 'encode', mode, freqHz, freeText, submode, ...body });
  });
}

// onActiveChange(active)：發射開始／結束（通聯區塊用來同步狀態機）；onSent({ text, mode, audioHz, slotStart })：每個發射 slot 開始時（呼叫清單用）
// getJs8Submode()：JS8 發射速度（通訊畫面的速度下拉，add-web-js8-chat J2）
// getJs8ForceUtx()：強化編碼（J3）——開著時 JS8 保留原文大小寫，資料段需要時走 UTX
// ptt：電台控制的 PTT 介面（add-web-rig-control，rig/ui.mjs；null＝VOX）：active() 選了 CAT／RTS／DTR、ready() 電台已連線
// getDialHz(settings)：撥號頻率（CAT 連線時是電台實際頻率，D14）
export function initTxUi({ getSettings, getJs8Submode = () => 0, getJs8ForceUtx = () => false, utcNow, utcToPerf, storage, mediaDevices, onTransmitting = () => {}, onActiveChange = () => {}, onSent = () => {},
  ptt = null, getDialHz = (s) => selectedDial(s), onOutputInterrupted = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const prefs = loadTxPrefs(storage);
  $('tx-freq').value = prefs.audioHz;
  $('tx-parity').value = prefs.parity;
  $('tx-gain').value = prefs.gain;
  $('tx-gain-value').textContent = `${Math.round(prefs.gain * 100)}%`;

  let ctl = null;
  // onOutputInterrupted：同一個輸出也給 JTTY 隨時發射用（add-web-jtty D9），輸出被系統關掉時它也要停
  const output = new TxOutput({ onInterrupted: (state) => {
    const reason = t(state === 'closed' ? 'tx.outputClosed' : 'tx.outputSuspended');
    if (ctl?.active) ctl.stop(reason);
    onOutputInterrupted(reason);
  } });
  output.setGain(prefs.gain);
  let resolvedParity = null; // 「自動」在按下發射時決定，之後固定
  let parityFn = null; // 通聯模式：時序由狀態機決定（換對象時會變）
  const encoder = createEncoder();
  let armedWith = null; // 開始發射時的模式與波段：發射中換了就停止

  const savePrefs = () => saveTxPrefs(storage, {
    audioHz: Number($('tx-freq').value), parity: $('tx-parity').value, sinkId: $('tx-device').value, gain: Number($('tx-gain').value),
  });

  const params = () => {
    const s = getSettings();
    return {
      mode: s.mode,
      // JS8 不在這裡轉大寫：buildJs8Frames 自己有大寫影子（一般編碼用），強化編碼要原文（UTX）
      text: s.mode === 'JS8' ? $('tx-text').value.trim() : $('tx-text').value.trim().toUpperCase(),
      freeText: $('tx-free').checked,
      audioHz: Number($('tx-freq').value),
      parity: parityFn ? parityFn() : resolvedParity,
      supervisionMs: supervisionMs(loadConfig(storage).config), // 設置頁「發射監管」
      submode: s.mode === 'JS8' ? getJs8Submode() : 0,
      callsign: s.callsign,
      dialHz: getDialHz(s),
    };
  };

  const status = (text, isError = false) => {
    $('tx-status').textContent = text;
    $('tx-status').className = isError ? 'hint error' : 'hint';
  };

  let lastActive = false;
  let bannerText = '';
  let swrText = ''; // 發射中讀到的 SWR（電台控制，D11），附在浮窗後面
  let pttStuck = false; // PTT 關可能沒送出（安全審查 #1）：浮窗一直顯示警告，直到 PTT 關成功
  let transmitting = false;
  // 浮窗：發射中顯示訊息（＋SWR）；PTT 關沒確定送出時顯示醒目警告（role=alert、aria-live assertive）
  function renderBanner() {
    const el = $('tx-banner');
    el.hidden = !transmitting && !pttStuck;
    el.classList.toggle('stuck', pttStuck);
    el.textContent = transmitting ? bannerText + swrText : '';
    if (pttStuck) {
      const warn = Object.assign(document.createElement('strong'), { className: 'ptt-stuck', textContent: t('rig.pttStuck') });
      warn.setAttribute('role', 'alert');
      warn.setAttribute('aria-live', 'assertive');
      el.append(warn);
    }
  }
  let lastSentSlot = null; // onSent 每個發射 slot 只通知一次（onState 在同一個 slot 可能被呼叫多次）
  ctl = new TxController({
    utcNow,
    utcToPerf,
    getParams: params,
    encode: encoder,
    // JS8（D4）：字表在按下發射時已載入；以設定的呼號與網格拆 frame，錯誤字串照 FT8TW
    buildJs8Frames: (text) => {
      const s = getSettings();
      const { frames, error } = buildJs8Frames(text, { mycall: s.callsign, mygrid: s.grid, submode: getJs8Submode(), forceUtx: getJs8ForceUtx() });
      if (error) throw new Error(error);
      return frames;
    },
    output,
    ptt,
    onState: (st) => {
      $('tx-start').disabled = st.active;
      $('tx-stop').disabled = !st.active;
      document.body.classList.toggle('tx-armed', st.active);
      document.body.classList.toggle('tx-on', Boolean(st.transmitting));
      transmitting = Boolean(st.transmitting);
      if (!st.transmitting) swrText = '';
      if (st.transmitting) bannerText = t('tx.banner', { mode: st.mode, hz: st.audioHz, text: st.text, part: st.part ?? '' });
      renderBanner();
      if (st.transmitting) {
        status(t('tx.transmitting', { time: formatUtc(st.slotStart) }));
        if (st.slotStart !== lastSentSlot) {
          lastSentSlot = st.slotStart;
          onSent({ text: st.text, mode: st.mode, audioHz: st.audioHz, slotStart: st.slotStart }); // 呼叫清單列出我方訊息
        }
      } else if (st.error) status(st.error, true);
      else if (st.message) status(st.message);
      else if (st.active && st.nextSlot) status(t('tx.waiting', { time: formatUtc(st.nextSlot), parity: resolvedParity }));
      else if (!st.active) status(t('tx.stopped'));
      onTransmitting(Boolean(st.transmitting));
      if (st.active !== lastActive) {
        lastActive = st.active;
        onActiveChange(st.active);
      }
    },
  });

  // 開始發射。driver／parity：通聯模式由狀態機決定每輪訊息與時序（2.5）；沒給時發輸入框的固定訊息。
  // 回傳不能開始的原因（null＝已開始）
  async function begin({ driver = null, parity = null } = {}) {
    if (ctl.active || $('tx-start').disabled) return t('tx.alreadyActive');
    $('tx-start').disabled = true; // 立即停用：避免開啟輸出期間連點開出兩個 AudioContext
    try {
      const s = getSettings();
      if (!$('tx-text').value.trim()) $('tx-text').value = defaultTxText(s);
      const p = $('tx-parity').value;
      parityFn = typeof parity === 'function' ? parity : null;
      resolvedParity = parityFn ? null : p === 'auto' ? cqParity(utcNow(), s.mode) : Number(p);
      const pre = params();
      // 選了 CAT／RTS／DTR 但電台沒連上：不要默默改成 VOX 發射（電台不會鍵下，或 VOX 意外鍵下）
      if (ptt?.active() && !ptt.ready()) {
        status(t('rig.notConnectedTx'), true);
        return t('rig.notConnectedTx');
      }
      const blocked = ctl.blockReason(pre, null);
      if (blocked) {
        status(blocked, true);
        return blocked;
      }
      status(t('tx.preparing'));
      // 先編碼一次：檢查訊息、也讓編碼器先載入（第一個 slot 不會因冷啟動來不及）。JS8 先載字表、拆 frame
      try {
        if (pre.mode === 'JS8') {
          await loadJs8Tables();
          const [first] = ctl.buildJs8Frames(pre.text);
          if (!first) throw new Error(t('tx.noFrames'));
          await encoder({ frame: first }, { mode: 'JS8', freqHz: pre.audioHz, submode: pre.submode });
        } else {
          await encoder(pre.text, { mode: pre.mode, freqHz: pre.audioHz, freeText: pre.freeText });
        }
      } catch (err) {
        status(t('tx.cannotTx', { msg: err.message }), true);
        return err.message;
      }
      try {
        const { sinkApplied } = await output.open({ sinkId: $('tx-device').value || undefined });
        $('tx-device-hint').textContent = $('tx-device').value && !sinkApplied ? t('tx.defaultOutputOnly') : '';
      } catch (err) {
        status(t('tx.outputOpenFailed', { msg: err.message }), true);
        return err.message;
      }
      // 準備期間（熱身編碼、開輸出）設定可能被改過：以「現在」的模式與波段為準，並重新檢查防護
      const now = getSettings();
      if (now.mode !== s.mode || now.band !== s.band || now.dialHz !== s.dialHz) {
        status(t('tx.changedDuringPrepRetry'), true);
        return t('tx.changedDuringPrep');
      }
      armedWith = { mode: now.mode, band: now.band, dialHz: now.dialHz }; // 撥號頻率（同波段改頻率也算，add-web-frequency-list D11）
      ctl.driver = driver;
      return ctl.start();
    } finally {
      if (!ctl.active) $('tx-start').disabled = false;
    }
  }
  $('tx-start').addEventListener('click', () => begin());
  $('tx-stop').addEventListener('click', () => ctl.stop());
  // 關閉或重新整理分頁時立即停止（W1：切到背景照常發射）
  window.addEventListener('pagehide', () => ctl.stop());
  for (const id of ['tx-freq', 'tx-parity', 'tx-device']) $(id).addEventListener('change', savePrefs);
  $('tx-gain').addEventListener('input', () => {
    output.setGain(Number($('tx-gain').value));
    $('tx-gain-value').textContent = `${Math.round(Number($('tx-gain').value) * 100)}%`;
    savePrefs();
  });

  // 輸出裝置清單：取得麥克風權限後才有名稱；不支援選擇輸出的瀏覽器停用選單（D7）
  async function refreshDevices() {
    const select = $('tx-device');
    const supported = 'setSinkId' in AudioContext.prototype;
    select.disabled = !supported;
    if (!supported) {
      $('tx-device-hint').textContent = t('tx.defaultOutputOnly');
      return;
    }
    const devices = (await mediaDevices?.enumerateDevices?.()) ?? [];
    const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    select.replaceChildren(new Option(t('tx.systemDefault'), ''), ...outputs.map((d, i) => new Option(d.label || t('tx.outputN', { n: i + 1 }), d.deviceId)));
    // 記住的輸出裝置現在沒接上：保留在選單（標「未連接」），不要被之後的存檔清成系統預設（設定組切換後常見）
    if (prefs.sinkId && !outputs.some((d) => d.deviceId === prefs.sinkId)) select.append(new Option(t('tx.outputMissing'), prefs.sinkId));
    select.value = prefs.sinkId || '';
  }

  // 設定改變時：發射中換了模式、波段或撥號頻率就停止（避免在錯的頻率或模式發射）；呼號變了而訊息是預設 CQ 時跟著更新
  function syncDefaultText() {
    const s = getSettings();
    if (ctl.active && armedWith && (s.mode !== armedWith.mode || s.band !== armedWith.band || s.dialHz !== armedWith.dialHz)) ctl.stop(t('tx.modeBandChanged'));
    if (!ctl.active && (!$('tx-text').value || /^CQ /.test($('tx-text').value))) $('tx-text').value = defaultTxText(getSettings());
  }
  syncDefaultText();

  // 電台讀到的 SWR：顯示在發射浮窗（D11）
  function setSwr(swr) {
    swrText = Number.isFinite(swr) ? t('tx.swr', { swr: swr.toFixed(2) }) : '';
    if (transmitting) renderBanner();
  }

  function setPttStuck(on) {
    const shown = !$('tx-banner').hidden;
    pttStuck = Boolean(on);
    renderBanner();
    if (pttStuck && !shown) onTransmitting(true); // 浮窗原本藏著：放到記住的位置
  }

  // JTTY 隨時發射（add-web-jtty D9）共用輸出（音量、輸出裝置同一套）：還沒開或已關才開
  async function ensureOutput() {
    if (output.ctx && output.ctx.state !== 'closed') return;
    const { sinkApplied } = await output.open({ sinkId: $('tx-device').value || undefined });
    $('tx-device-hint').textContent = $('tx-device').value && !sinkApplied ? t('tx.defaultOutputOnly') : '';
  }

  return { controller: ctl, refreshDevices, syncDefaultText, begin, status, setSwr, setPttStuck, encode: encoder, output, ensureOutput };
}
