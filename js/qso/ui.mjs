// 通聯區塊（add-web-transmit 2.5、D10～D13）：呼叫 CQ、從解碼清單呼叫、6 則訊息下拉、自動回應 CQ。
// 每個接收 slot 解碼完把結果交給狀態機（onDecoded），每個我方 slot 前問狀態機要發哪一則（beforeTransmit，經發射控制的 driver）。
// 依賴瀏覽器 API，以真瀏覽器端到端（tools/e2e-qso.mjs）驗證；狀態機本身是純函式並有黃金向量測試。
import { createSession, onDecoded, beforeTransmit, startCq, callTo, selectOrder, stop as stopSession, messagesFor } from './session.mjs';
import { REFUSAL, formatReport, hasReport } from './messages.mjs';
import { cqParity, sequenceOf } from '../tx/scheduler.mjs';
import { SLOT_MS } from '../slot.mjs';
import { bandOf, selectedDial } from '../bands.mjs';
import { t } from '../i18n/index.mjs';
import { formatOffset } from '../format.mjs';

// 自動通聯只在時槽模式；JS8、JTTY（add-web-jtty D15）停用
export const QSO_MODES = Object.freeze(['FT8', 'FT4', 'FT2']);
const REFUSAL_TEXT = {
  [REFUSAL.HASHED]: t('qso.refuse.hashed'),
  [REFUSAL.MYSELF]: t('qso.refuse.myself'),
  [REFUSAL.NOT_STANDARD]: t('qso.refuse.notStandard'),
};
const RETRY_MS = 100;
// 我方 slot 起點後最多等上一輪解碼這麼久，依模式留在發射截止時間內（FT8 2.5 s、FT4 1.25 s、FT2 0.6 s）
export const WAIT_DECODE_MS = Object.freeze({ FT8: 1500, FT4: 1050, FT2: 400 });
// 收訊音訊延遲 vs 等待時間（add-dt-offset-advisor D18）：對方那個 slot 的音訊晚 L 才收齊，解碼完成約在我方 slot 起點＋L＋解碼時間；
// 超過等待時間就趕不上回覆。只警告、不改通聯時序。decodeMs 還沒量到時用預估值
export const DEFAULT_DECODE_MS = 300;
export function rxDelayRisk({ mode, rxDelayMs, decodeMs }) {
  const wait = WAIT_DECODE_MS[mode];
  if (wait === undefined || !(rxDelayMs > 0)) return false;
  return rxDelayMs > wait - (Number.isFinite(decodeMs) ? decodeMs : DEFAULT_DECODE_MS);
}
export const rxDelayWarning = (opts) => (rxDelayRisk(opts) ? t('qso.rxDelayWarn', { delay: formatOffset(opts.rxDelayMs) }) : '');

// readPrefs()：設置頁的自動通聯設定（ft8tw.config）；savePrefs(patch)：通聯區塊的「自動回應 CQ」寫回同一份設定
// getDialHz(settings)：撥號頻率（CAT 時是電台實際頻率，add-web-rig-control D14；使用者 2026-10-09：通聯紀錄要記實際頻率）
export function initQsoUi({ tx, getSettings, utcNow, qsoLog, getSelectedRow, readPrefs = () => ({}), savePrefs = () => {}, getDialHz = (s) => selectedDial(s), getDecodeMs = () => undefined }) {
  const $ = (id) => document.getElementById(id);
  let session = null;
  let lastDecodedSlot = -Infinity; // 最近一次解碼完成的接收 slot 起點（不論通聯是否進行中）
  let beginning = false; // 正在開始發射（熱身編碼、開輸出）

  const status = (text, isError = false) => {
    $('qso-status').textContent = text;
    $('qso-status').className = isError ? 'hint error' : 'hint';
  };

  function config() {
    const s = getSettings();
    const p = readPrefs();
    return {
      myCall: s.callsign, myGrid: (s.grid ?? '').slice(0, 4), modifier: p.cqModifier || null, band: s.band,
      slotMs: SLOT_MS[s.mode], noReplyLimit: p.noReplyLimit ?? 0, finishRetryLimit: p.finishRetryLimit ?? 2,
      autoFollowCQ: p.autoFollowCQ ?? $('qso-autofollow').checked,
    };
  }

  // 每次使用前套用最新設定；同一個 session 沿用冷卻與失敗清單
  function ensureSession() {
    const cfg = config();
    session = session ? { ...session, cfg: { ...session.cfg, ...cfg } } : createSession(cfg);
    return session;
  }

  // 收訊音訊延遲太大時的警告（D18）：設定、模式、解碼時間改變時重算
  function renderDelayWarning() {
    const el = $('qso-delay-warn');
    if (!el) return;
    const text = rxDelayWarning({ mode: getSettings().mode, rxDelayMs: readPrefs().rxAudioDelayMs, decodeMs: getDecodeMs() });
    if (el.textContent !== text) el.textContent = text;
    el.hidden = !text;
  }

  function render() {
    renderDelayWarning();
    const s = session;
    $('qso-autofollow').checked = readPrefs().autoFollowCQ ?? $('qso-autofollow').checked; // 與設置頁同步
    const target = s?.active && s.target ? s.target.call : '—';
    $('qso-target').textContent = target;
    const select = $('qso-order');
    // 還沒開始通聯時也顯示 6 則（同 FT8TW 呼叫頁底部一直看得到「6 CQ …」）
    const preview = s ?? (getSettings().callsign ? createSession(config()) : null);
    const msgs = preview ? messagesFor(preview) : [];
    const callingCq = !s?.target || s.target.call === 'CQ';
    select.replaceChildren(...msgs.map((m, i) => {
      const o = new Option(`${i + 1}  ${m.text}`, String(i + 1));
      o.disabled = callingCq && i !== 5; // 呼 CQ 時只有第 6 則
      return o;
    }));
    select.value = String(s?.active ? s.order : 6);
    select.disabled = !s?.active;
  }

  const logDialHz = (st = getSettings()) => getDialHz(st) ?? selectedDial(st);

  async function writeLog(log) {
    if (!log) return;
    const st = getSettings();
    const dial = logDialHz(st); // 同 FT8TW 記撥號頻率；CAT 時是電台讀回的實際頻率
    const r = await qsoLog.add({
      // 報告寫成兩位數（-07、+05），同發射的訊息與 WSJT-X 記錄；沒有報告（-100）寫空字串
      ...log, rstSent: hasReport(log.rstSent) ? formatReport(log.rstSent) : '', rstRcvd: hasReport(log.rstRcvd) ? formatReport(log.rstRcvd) : '',
      myCall: st.callsign, myGrid: st.grid, mode: st.mode, freqHz: dial, country: '',
      band: bandOf(dial) ?? log.band ?? st.band, // 波段跟著實際頻率（電台被調到別的波段時不會記錯）
    });
    status(r.added ? t('qso.logged', { call: log.call }) : t('qso.dupLog', { call: log.call }));
  }

  function apply(r) {
    session = r.state;
    if (r.log) writeLog(r.log).catch((err) => status(t('qso.logWriteFailed', { msg: err.message }), true));
    if (r.reason && !r.stopped) status(r.reason);
    render();
    return r;
  }

  // 發射控制每個我方 slot 前呼叫：上一輪還沒解碼完就稍後再問
  function driver(slot) {
    const now = utcNow();
    const { mode } = getSettings();
    // 先比對時序：beforeTransmit 有副作用（收尾會寫記錄），時序不對（換了對象）就不要呼叫，下一輪再發
    if (session.mySeq !== sequenceOf(slot.slotStart, mode)) return null;
    const prevSlot = slot.slotStart - session.cfg.slotMs;
    if (lastDecodedSlot < prevSlot && now < slot.slotStart + (WAIT_DECODE_MS[mode] ?? 1000)) return { retryMs: RETRY_MS };
    const r = apply(beforeTransmit(session, now));
    if (r.stopped) return { stop: true, reason: r.reason || t('qso.ended') };
    if (!r.tx) return null;
    status(t('qso.sendingOrder', { order: r.tx.order, to: r.tx.to }));
    return { text: r.tx.text };
  }

  async function ensureTransmitting() {
    if (tx.controller.active || beginning) return null; // 已在發射（通聯驅動中）或正在開始：狀態機已更新，下一輪就會照新的發
    beginning = true;
    try {
      const reason = await tx.begin({ driver, parity: () => session.mySeq });
      if (reason) {
        session = stopSession(session).state;
        render();
      }
      return reason;
    } finally {
      beginning = false;
    }
  }

  // 手動發射（發射區塊的固定訊息）進行中：不接手，避免狀態機以為在叫某台、電台卻照舊發固定訊息
  function manualBusy() {
    if (tx.controller.active && !tx.controller.driver) {
      status(t('qso.manualBusy'), true);
      return true;
    }
    return false;
  }

  function modeOk() {
    const { mode } = getSettings();
    if (QSO_MODES.includes(mode)) return true;
    status(t('qso.noQsoMode', { mode }), true);
    return false;
  }

  $('qso-cq').addEventListener('click', async () => {
    if (!modeOk() || manualBusy()) return;
    ensureSession();
    const now = utcNow();
    apply(startCq(session, { parity: tx.controller.active ? session.mySeq : cqParity(now, getSettings().mode), now }));
    status(t('qso.callingCq'));
    await ensureTransmitting();
  });

  // 從解碼清單呼叫（雙擊／長按，或按「呼叫選取的電台」）
  async function callRow(row) {
    if (!row) return status(t('qso.selectRowFirst'), true);
    if (!modeOk() || manualBusy()) return;
    const { mode } = getSettings();
    if (row.mode && row.mode !== mode) return status(t('qso.modeMismatch', { rowMode: row.mode, mode }), true);
    ensureSession();
    const r = callTo(session, {
      message: { text: row.text, snr: row.snr, freqHz: row.freqHz }, msgUtc: row.startUtc,
      parity: sequenceOf(row.startUtc, mode), now: utcNow(),
    });
    if (r.refusal !== REFUSAL.NONE) return status(REFUSAL_TEXT[r.refusal] ?? t('qso.refuse.generic'), true);
    apply(r);
    status(r.warning ? t('qso.callingWarn', { call: session.target.call, warning: r.warning }) : t('qso.calling', { call: session.target.call }));
    await ensureTransmitting();
  }
  $('qso-call').addEventListener('click', () => callRow(getSelectedRow()));

  $('qso-order').addEventListener('change', () => {
    if (!session?.active) return;
    apply(selectOrder(session, Number($('qso-order').value), utcNow()));
    status(t('qso.thisCycleOrder', { n: $('qso-order').value }));
  });
  $('qso-autofollow').addEventListener('change', () => {
    savePrefs({ autoFollowCQ: $('qso-autofollow').checked });
    if (session) session = { ...session, cfg: { ...session.cfg, autoFollowCQ: $('qso-autofollow').checked } };
  });

  render();
  return {
    logDialHz, // 寫進通聯紀錄的頻率（瀏覽器檢查用）
    callRow,
    render, // 設定（呼號、網格、CQ 對象）改了：更新底部的 6 則預覽
    renderDelayWarning, // 每個時槽解完（解碼時間會變）
    // 主程式：每個 FT8／FT4／FT2 接收 slot 解碼完（含 0 則）
    onSlotDecoded({ startUtc, mode, results }) {
      lastDecodedSlot = Math.max(lastDecodedSlot, startUtc);
      if (!session?.active || !QSO_MODES.includes(mode)) return;
      const r = apply(onDecoded(session, {
        parity: sequenceOf(startUtc, mode), now: utcNow(),
        messages: results.map((x) => ({ text: x.text, snr: x.snr, freqHz: x.freqHz })),
      }));
      if (r.stopped && tx.controller.active) tx.controller.stop();
      if (r.stopped) status(r.reason || t('qso.ended'));
    },
    // 發射停止（按停止、防護擋下、單次通聯完成）：狀態機也停
    onTxActiveChange(active) {
      if (!active && session?.active) {
        session = stopSession(session).state;
        render();
      }
    },
    session: () => session,
  };
}
