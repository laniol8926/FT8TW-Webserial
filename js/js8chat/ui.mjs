// JS8 通訊畫面的接線（add-web-js8-chat J1，仿 FT8TW Js8Fragment）：收訊 → 泡泡、輸入 → 發射、自動回覆、HB 定時。
// 規則都在純函式模組（store／model／compose／quickreply／autoreply）；這裡只負責 DOM 與把各部分接起來。
// 發射沿用既有的 TxController（txUi.begin）：防護、排程、監管都同一套，不另寫一份。
import { t } from '../i18n/index.mjs';
import { bucketKey } from '../js8/message.mjs';
import { filterByStation, stationsWithChat, shouldResetSelection, MAX_MESSAGES } from './store.mjs';
import { createChatView } from './chatview.mjs';
import { fullText, periodSec } from './model.mjs';
import { prependSelectedCall, quickMenu, previewFrames, aprsCmd } from './compose.mjs';
import { loadRetention, cutoffFor } from '../retention.mjs';
import { replyOptions } from './quickreply.mjs';
import { createAutoReply, nextHeartbeatDue, heartbeatText, HEARING_MINUTES } from './autoreply.mjs';
import { SUBMODES, SUBMODE_LIST } from '../js8/submodes.mjs';
import { verifyStillCurrent, igateRequest, parsePasscode, gateCall, passcodeIndicator, verifyOutcome, igateErrorKey } from './igate.mjs';
import { selectedDial } from '../bands.mjs';

const PREFS_KEY = 'ft8tw.js8chat';

const SPEEDS = SUBMODE_LIST.map((submode) => ({ submode, ...SUBMODES[submode] })); // J2：五種速度全開（design D2）

const DEFAULT_PREFS = {
  station: null, submode: 0, multiSpeed: false, forceUtx: false, local: false, sort: 'call', autoReply: false, replyCq: false, replyHb: false,
  hbHourly: 6, hbPerCall: 1, hbMin: 0, info: '', status: '',
};

export function loadChatPrefs(storage) {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(storage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function saveChatPrefs(storage, prefs) {
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 無痕模式等：只是下次不記得
  }
}

// 訊息開頭的目標呼號（TX 泡泡 meta「TX → CALL」用）：CQ／HB／@群組 沒有單一目標
export function targetOf(text) {
  const first = String(text).trim().split(/\s+/)[0]?.replace(/:$/, '') ?? '';
  if (!first || /^(CQ|HB|HEARTBEAT)$/.test(first) || first.startsWith('@') || !/^[A-Z0-9/]{3,}$/.test(first)) return '';
  return first;
}

/**
 * storeReady：openJs8Chat() 的 Promise；getSettings()：{ callsign, grid, band, mode }；utcNow()：校正後 UTC；
 * isRunning()：接收中；tx：initTxUi 的回傳；version：版本字串（INFO? 的 VERSION）
 */
// relay：轉送站網址（iGate 的 POST /aprs）；notify(text)：主畫面狀態列（JS8 面板藏起來時也看得到）
// getDialHz(settings)：JS8 撥號頻率（CAT 時是電台實際頻率，與回報、通聯紀錄一致）
export function initJs8Chat({ storeReady, getSettings, utcNow, isRunning, tx, storage, version = '', relay = '', notify = () => {}, getDialHz = (s) => selectedDial(s, 'JS8') }) {
  const $ = (id) => document.getElementById(id);
  const prefs = loadChatPrefs(storage);
  const save = () => saveChatPrefs(storage, prefs);
  const autoReply = createAutoReply();
  let store = null;
  let saved = []; // 已定稿的訊息（store.list）
  const live = new Map(); // bucketKey → 接收中訊息（只在記憶體，同 App liveMessages）
  let queued = null; // 發射中按送出的「下一則」
  let lastSentText = ''; // AGN? 用：只記手動送出（同 App noteTx）
  let lastHbUtc = 0;
  let sending = false; // tx.begin 準備中（載字表、熱身編碼、開輸出）：這段期間 controller 還不是 active，但 #tx-text 不能被改
  let stationSig = ''; // 選台選項沒變就不重建（手機展開下拉時重建會把它關掉）

  const view = createChatView({
    list: $('js8c-list'),
    timeOpts: () => ({ local: prefs.local }),
    menuItems: (m) => bubbleMenu(m),
    onMenu: (item, m) => item.run(m),
    emptyInfo: () => ({ running: isRunning(), station: prefs.station }),
  });

  // ── 下拉選單 ──
  const speedSel = $('js8c-speed');
  speedSel.replaceChildren(...SPEEDS.map((s) => {
    const o = new Option(s.short, String(s.submode));
    o.title = s.ft8twOnly ? `${s.name} — ${t('js8chat.ft8tw_only')}` : s.name;
    return o;
  }));
  speedSel.value = String(SPEEDS.some((s) => s.submode === prefs.submode) ? prefs.submode : 0);
  prefs.submode = Number(speedSel.value);
  // 改速度、改「同時解碼其他速度」：主程式重建 JS8 切窗器（add-web-js8-chat D6）
  const rxChanged = () => document.dispatchEvent(new CustomEvent('ft8tw:js8rx'));
  speedSel.addEventListener('change', () => {
    prefs.submode = Number(speedSel.value);
    save();
    refreshPreview();
    rxChanged();
  });

  function allMessages() {
    return [...saved, ...live.values()].sort((a, b) => a.utc - b.utc);
  }

  // 新紀錄併進 saved（不必每次整批讀 IndexedDB），超過上限丟最舊的
  function appendSaved(rec) {
    if (!rec) return;
    saved.push(rec);
    saved.sort((a, b) => a.utc - b.utc);
    if (saved.length > MAX_MESSAGES) saved = saved.slice(-MAX_MESSAGES);
  }

  function refreshStations() {
    const sel = $('js8c-station');
    const all = allMessages();
    // 對話紀錄還沒從 IndexedDB 載入前不判斷（清單是空的，會誤把選台重設回全部）
    if (store && shouldResetSelection(all, prefs.station)) {
      prefs.station = null;
      save();
    }
    const fmt = (s) => [s.call, s.snr == null ? '' : `${s.snr < 0 ? '-' : '+'}${String(Math.abs(s.snr)).padStart(2, '0')}`, s.grid ?? ''].filter(Boolean).join(' ');
    const list = stationsWithChat(all, { sort: prefs.sort, myCall: getSettings().callsign });
    const opts = [new Option(t('js8chat.station_all'), ''), ...list.map((s) => new Option(fmt(s), s.call))];
    // 選定台目前不在清單（只送過、還沒聽到）也要留著，不然選單會跳回全部
    if (prefs.station && !list.some((s) => s.call === prefs.station)) opts.push(new Option(prefs.station, prefs.station));
    const sig = opts.map((o) => `${o.value}|${o.textContent}`).join('\n');
    if (sig !== stationSig) {
      stationSig = sig;
      sel.replaceChildren(...opts);
    }
    sel.value = prefs.station ?? '';
  }
  $('js8c-station').addEventListener('change', () => {
    prefs.station = $('js8c-station').value || null;
    save();
    refresh();
  });

  function refresh() {
    refreshStations();
    view.render(filterByStation(allMessages(), prefs.station).slice(-MAX_MESSAGES), Date.now());
  }

  // ── 收訊 ──
  function rxRecord(m, extra = {}) {
    return {
      dir: 'rx', utc: m.utcMs ?? utcNow(), from: m.callsignFrom ?? '', to: m.callsignTo ?? '', text: m.text ?? '',
      complete: Boolean(m.complete), snr: m.snr, freqHz: m.freqHz, submode: m.submode ?? 0, grid: m.grid ?? '',
      isCq: Boolean(m.isCq), isHeartbeat: Boolean(m.isHeartbeat), directedCmd: m.directedCmd ?? -1, utx: false, ...extra,
    };
  }

  // 一輪解碼：本輪送出（定稿）的訊息寫入 store；接收中泡泡直接用 assembler 的 pending()（即時預覽）重建，
  // 不自己鏡像組裝（新 First 蓋掉舊訊息、UTX 只回「…」等情況才對得上）
  async function onCycle({ messages, pending = [], submode = 0 }) {
    for (const [k, v] of live) if ((v.submode ?? 0) === submode) live.delete(k); // 只換本速度的（其他速度各自的週期更新）
    for (const p of pending) {
      if (!p.text && !p.callsignFrom) continue;
      const key = bucketKey(p.submode ?? submode, p.freqHz);
      live.set(key, { ...rxRecord(p), id: `live:${key}`, live: true });
    }
    for (const m of messages) {
      appendSaved(store ? await store.add(rxRecord(m)) : null);
      maybeAutoReply(m);
      maybeGate(m);
    }
    refresh();
  }

  // 逾時沒收完的接收中泡泡由 assembler 以不完整送出；換波段、換模式、停止時清掉
  function resetLive() {
    live.clear();
    refresh();
  }

  // ── 發射 ──
  // 忙碌＝發射中或準備中（準備中 controller 還不是 active，但第二則不能進來改 #tx-text）
  const txActive = () => tx.controller.active || sending;

  async function transmit(text, { manual = true } = {}) {
    const s = getSettings();
    if (!s.callsign) return showStatus(t('js8chat.err_no_callsign'), true);
    if (txActive()) return showStatus(t('tx.alreadyActive'), true);
    sending = true;
    syncSendButton();
    let err;
    try {
      $('tx-text').value = text; // 沿用發射區塊（防護、排程、監管同一套）
      err = await tx.begin();
    } finally {
      sending = false;
      syncSendButton();
    }
    if (err) return showStatus(err, true);
    if (manual) lastSentText = text;
    // 真的產生了 UTX frame 才標「FT8TW」（只有 FT8TW 解得開）；導向呼號拆掉後剩下的資料段才算，同 buildJs8Frames
    const utx = previewFrames(text, { mycall: s.callsign, mygrid: s.grid, submode: prefs.submode, forceUtx: prefs.forceUtx }).utx === true;
    const rec = { dir: 'tx', utc: utcNow(), from: s.callsign, to: targetOf(text.toUpperCase()), text, complete: true, snr: null, freqHz: Number($('tx-freq').value), submode: prefs.submode, utx };
    try {
      appendSaved(store ? await store.add(rec) : rec);
    } catch (e) {
      showStatus(e.message, true); // 已經在發射；只是紀錄沒寫進去
    }
    refresh();
    return null;
  }

  // 強化編碼（J3，design D10）：開著時保留原文（大小寫、中文走 UTX）；關著照舊轉大寫
  function typedText() {
    const v = $('js8c-text').value.trim();
    return prefs.forceUtx ? v : v.toUpperCase();
  }

  async function onSend() {
    if (txActive() && !$('js8c-text').value.trim()) { // 發射中按送出＝停止（排隊的也一起取消）
      queued = null;
      return tx.controller.stop();
    }
    const text = prependSelectedCall(typedText(), prefs.station);
    if (!text) return null;
    if (txActive()) { // 有字：排隊下一則，目前這則發完自動送出
      queued = text;
      $('js8c-text').value = '';
      showStatus(t('js8chat.queued'));
      return syncSendButton();
    }
    const err = await transmit(text);
    if (!err) $('js8c-text').value = '';
    refreshPreview();
    syncSendButton(); // 發射開始時輸入框還有字（顯示「排入下一則」），清空後改回「停止」
    return err;
  }
  $('js8c-send').addEventListener('click', () => onSend());
  $('js8c-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { // Enter 送出、Shift+Enter 換行
      e.preventDefault();
      onSend();
    }
  });
  $('js8c-text').addEventListener('input', () => {
    refreshPreview();
    syncSendButton();
  });

  function syncSendButton() {
    const b = $('js8c-send');
    const typed = Boolean($('js8c-text').value.trim());
    const label = !txActive() ? 'js8chat.send' : typed ? 'js8chat.queue' : 'js8chat.stop';
    b.textContent = t(label);
    b.classList.toggle('danger', label !== 'js8chat.stop');
    // 發射中不可改速度（spec「速度選擇」：後面的 frame 換速度對方組不回訊息）
    speedSel.disabled = txActive();
    speedSel.title = txActive() ? t('js8chat.speed_locked') : '';
  }

  // 發射結束：正常發完才送排隊的下一則；被停止（使用者、換波段／模式、監管逾時、錯誤）就取消，不可繞過防護
  function onTxActiveChange(active) {
    syncSendButton();
    if (active || !queued) return;
    const next = queued;
    queued = null;
    if (!tx.controller.endedNormally || getSettings().mode !== 'JS8') {
      showStatus(t('js8chat.queue_cancelled'), true);
      return;
    }
    transmit(next).catch((e) => showStatus(e.message, true));
  }

  function showStatus(text, isError = false) {
    $('js8c-rxstatus').textContent = text;
    $('js8c-rxstatus').classList.toggle('error', isError);
    return isError ? text : null;
  }

  function refreshPreview() {
    const text = prependSelectedCall(typedText(), prefs.station);
    if (!text) {
      $('js8c-frames').textContent = '';
      return;
    }
    const s = getSettings();
    const p = previewFrames(text, { mycall: s.callsign, mygrid: s.grid, submode: prefs.submode, forceUtx: prefs.forceUtx });
    $('js8c-frames').textContent = p.error ? p.error : t('js8chat.frames', { n: p.frames, s: p.seconds });
  }

  // ── 自動回覆、HB ──
  function heardRecently(now, minutes = HEARING_MINUTES, max = 4) {
    const out = [];
    for (const m of [...saved].reverse()) {
      if (m.dir !== 'rx' || !m.from || m.from.startsWith('<') || now - m.utc > minutes * 60_000) continue;
      if (!out.includes(m.from)) out.push(m.from);
      if (out.length >= max) break;
    }
    return out;
  }

  function autoCtx() {
    const s = getSettings();
    return {
      enabled: prefs.autoReply, replyCq: prefs.replyCq, replyHb: prefs.replyHb, hbHourlyLimit: prefs.hbHourly, hbPerCallLimit: prefs.hbPerCall,
      myCall: s.callsign, myGrid: s.grid, info: prefs.info, version, txBusy: txActive(), txSubmode: prefs.submode,
      heardRecently, lastSentText,
    };
  }

  async function maybeAutoReply(m) {
    if (getSettings().mode !== 'JS8') return;
    const r = autoReply.decide(m, autoCtx(), utcNow());
    if (!r.text) return;
    try {
      const err = await transmit(r.text, { manual: false });
      if (!err) autoReply.commit(r); // 真的送出才記冷卻／額度（同 App）
    } catch (e) {
      showStatus(e.message, true);
    }
  }

  async function sendHeartbeat() {
    if (txActive()) return showStatus(t('tx.alreadyActive'), true);
    lastHbUtc = utcNow(); // 失敗也算一次：等下一個間隔再試，不會每次 tick 重送
    const err = await transmit(heartbeatText(getSettings().grid), { manual: false });
    if (!err) showStatus(t('js8chat.hb_sent'));
    return err;
  }
  $('js8c-hb-now').addEventListener('click', () => sendHeartbeat().catch((e) => showStatus(e.message, true)));

  // 每秒：倒數、接收中跑點、HB 定時（只在 JS8 模式且接收中；發射中就等下一次）
  function tick() {
    if (getSettings().mode !== 'JS8') return; // 畫面不顯示時不做事
    const now = utcNow();
    const period = (periodSec(prefs.submode) ?? 15) * 1000;
    $('js8c-countdown').textContent = `${String(Math.ceil((period - (now % period)) / 1000)).padStart(2, '0')}s`;
    view.tick(Date.now());
    if (isRunning() && !txActive() && nextHeartbeatDue(prefs.hbMin, lastHbUtc, now)) {
      if (lastHbUtc === 0) lastHbUtc = now; // 剛打開定時：從現在起算，不馬上送（避免一開就發射）
      else sendHeartbeat().catch((e) => showStatus(e.message, true));
    }
  }
  setInterval(tick, 400);

  // ── APRS-IS iGate（J4）：符合條件的 @APRSIS 訊息交轉送站；passcode 存這個瀏覽器（W2），設定框可清除 ──
  const IGATE_KEY = 'ft8tw.igate';
  const igate = (() => {
    try {
      const v = JSON.parse(storage.getItem(IGATE_KEY) ?? '{}');
      return { enabled: v.enabled === true, passcode: Number.isInteger(v.passcode) ? v.passcode : null };
    } catch {
      return { enabled: false, passcode: null };
    }
  })();
  let igateSent = 0;
  const saveIgate = () => {
    try {
      storage.setItem(IGATE_KEY, JSON.stringify(igate));
    } catch {
      // 只是下次要重填
    }
  };
  // iGate 登入呼號：複合呼號（BV6LC/P）取基本呼號，轉送站只收這個、passcode 也以它算
  const myGateCall = () => gateCall(getSettings().callsign);
  // passcode 提示：沒呼號／沒 passcode／對不上回提示文字，相符回 ''（開關時用）
  function igateWarn() {
    const st = passcodeIndicator(myGateCall(), igate.passcode);
    return st.ok ? '' : t(st.key, st.params);
  }
  // 設定框的提示列：相符綠色（本機計算，D23）、其他紅色；顏色用 class（深色模式另配色）
  function showIgateWarn() {
    const st = passcodeIndicator(myGateCall(), igate.passcode);
    const el = $('js8c-igate-warn');
    el.textContent = t(st.key, st.params);
    el.classList.toggle('ok', st.ok);
    el.classList.toggle('error', !st.ok);
  }
  // 登入檢查結果：ok true 綠、false 紅、null 不上色（檢查中）；不帶參數＝清掉（passcode 改了，舊結果不再算數）
  let verifyGen = 0; // 清掉結果就換一輪，進行中的舊請求回來時不顯示
  function setVerifyResult(text = '', ok = null) {
    if (text === '') verifyGen++;
    const el = $('js8c-igate-verify-result');
    el.textContent = text;
    el.classList.toggle('ok', ok === true);
    el.classList.toggle('error', ok === false);
  }
  // 測試封包只在轉送站連本機／私有 APRS-IS 時允許（D22）；狀態不明（null）照常可按
  function setTestAllowed(allowed) {
    $('js8c-igate-test').disabled = allowed === false;
    $('js8c-igate-test-hint').hidden = allowed !== false;
  }
  function igateStatusLine(text, isError = false) {
    $('js8c-igate-state').textContent = text;
    if (igate.enabled) showStatus(`iGate：${text}`, isError);
  }
  async function maybeGate(m) {
    if (!igate.enabled || getSettings().mode !== 'JS8') return;
    const s = getSettings();
    const body = igateRequest(m, { gate: { call: gateCall(s.callsign), passcode: igate.passcode }, dialHz: getDialHz(s) ?? selectedDial(s, 'JS8') ?? 0 });
    if (!body) return;
    try {
      const r = await fetch(`${relay}/aprs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 202) {
        igateStatusLine(t('js8chat.igate_sent', { n: ++igateSent, from: body.from })); // 202＝排進轉送站佇列，還沒送上 APRS-IS
        // 轉送站先回 202 才連線、登入 APRS-IS（最久約 25 秒）：5 秒、30 秒各看一次有沒有被拒（unverified）
        for (const ms of [5000, 30000]) setTimeout(refreshIgateState, ms);
      }
      else if (r.status === 200 && j.duplicate) igateStatusLine(t('js8chat.igate_dup', { from: body.from }));
      else igateStatusLine(t('js8chat.igate_failed', { why: igateError(r.status, j.error) }), true);
    } catch (e) {
      igateStatusLine(t('js8chat.igate_failed', { why: e.message }), true);
    }
  }
  function igateError(status, code) {
    const key = igateErrorKey(code);
    return key ? t(key) : `HTTP ${status}${code ? ` ${code}` : ''}`;
  }
  async function refreshIgateState() {
    const call = myGateCall();
    if (!call) return;
    try {
      const r = await fetch(`${relay}/aprs/status?call=${encodeURIComponent(call)}`);
      if (!r.ok) return igateStatusLine(t('js8chat.igate_failed', { why: igateError(r.status, (await r.json().catch(() => ({}))).error) }), true);
      const j = await r.json();
      setTestAllowed(typeof j.testAllowed === 'boolean' ? j.testAllowed : null);
      igateStatusLine(t(`js8chat.igate_state.${j.state}`, { n: j.sent ?? 0 }), j.state === 'unverified' || j.state === 'error');
    } catch (e) {
      igateStatusLine(t('js8chat.igate_failed', { why: e.message }), true);
    }
    return null;
  }
  const igateDlg = $('js8c-igate-dialog');
  $('js8c-igate').checked = igate.enabled;
  $('js8c-igate').addEventListener('change', () => {
    const warn = igateWarn();
    if ($('js8c-igate').checked && igate.passcode === null) { // 沒有 passcode 不能開
      $('js8c-igate').checked = false;
      showStatus(warn, true);
      igateDlg.showModal();
      return;
    }
    igate.enabled = $('js8c-igate').checked;
    saveIgate();
    if (igate.enabled) {
      if (warn) showStatus(warn, true);
      refreshIgateState();
    }
  });
  const openIgate = () => {
    $('js8c-igate-pass').value = igate.passcode ?? '';
    showIgateWarn();
    setVerifyResult();
    igateDlg.showModal();
    refreshIgateState();
  };
  $('js8c-igate-settings').addEventListener('click', openIgate);
  $('js8c-igate').closest('label').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openIgate();
  });
  $('js8c-igate-pass').addEventListener('input', () => {
    igate.passcode = parsePasscode($('js8c-igate-pass').value);
    saveIgate();
    showIgateWarn();
    setVerifyResult();
  });
  $('js8c-igate-clear').addEventListener('click', () => {
    igate.passcode = null;
    igate.enabled = false;
    $('js8c-igate').checked = false;
    $('js8c-igate-pass').value = '';
    saveIgate();
    showIgateWarn();
    setVerifyResult();
  });
  $('js8c-igate-test').addEventListener('click', async () => {
    try {
      const r = await fetch(`${relay}/aprs/test`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gate: { call: myGateCall(), passcode: igate.passcode } }),
      });
      const j = await r.json().catch(() => ({}));
      igateStatusLine(r.ok ? t('js8chat.igate_test_ok') : t('js8chat.igate_failed', { why: igateError(r.status, j.error) }), !r.ok);
    } catch (e) {
      igateStatusLine(t('js8chat.igate_failed', { why: e.message }), true);
    }
  });
  // 登入檢查（D23）：轉送站另開短暫連線只登入、不送封包；請求中停用按鈕
  $('js8c-igate-verify').addEventListener('click', async () => {
    const btn = $('js8c-igate-verify');
    const call = myGateCall();
    if (!call || igate.passcode === null) return setVerifyResult(igateWarn(), false);
    btn.disabled = true;
    setVerifyResult(t('js8chat.igate_verifying'));
    const sent = { gen: verifyGen, call, passcode: igate.passcode };
    const current = () => verifyStillCurrent(sent, { gen: verifyGen, call: myGateCall(), passcode: igate.passcode });
    try {
      const r = await fetch(`${relay}/aprs/verify`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gate: { call, passcode: igate.passcode } }),
      });
      const out = verifyOutcome(r.status, await r.json().catch(() => ({})), call);
      if (!current()) return;
      if (out.error) setVerifyResult(t('js8chat.igate_failed', { why: igateError(out.error.status, out.error.code) }), false);
      else setVerifyResult(t(out.key, out.params), out.ok);
    } catch (e) {
      if (current()) setVerifyResult(t('js8chat.igate_failed', { why: e.message }), false);
    } finally {
      btn.disabled = false;
    }
  });
  $('js8c-igate-close').addEventListener('click', () => igateDlg.close());
  // 離開 JS8 畫面：iGate 一起停（design D22）。JS8 面板此時藏起來，提示改顯示在主畫面狀態列；轉發計數歸零
  let inJs8 = getSettings().mode === 'JS8'; // FT8↔FT4 互換不算「離開 JS8」
  document.addEventListener('ft8tw:mode', (e) => {
    const left = inJs8 && e.detail !== 'JS8';
    inJs8 = e.detail === 'JS8';
    if (!left || !igate.enabled) return;
    igateSent = 0;
    notify(t('js8chat.igate_paused'));
  });

  // ── 快速選單、泡泡選單 ──
  const menu = $('js8c-menu');
  function closeMenu() {
    menu.hidden = true;
    menu.replaceChildren();
  }
  function openMenu(anchor, items) {
    menu.replaceChildren(...items.map((it) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', textContent: it.label });
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        closeMenu();
        it.run();
      });
      return b;
    }));
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, r.top - menu.offsetHeight - 4)}px`;
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== $('js8c-quick')) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });

  function fillInput(text, station) {
    // 只有合法呼號才切選台（空字串、<雜湊>、@群組 會讓篩選看起來像紀錄不見了）
    if (station && !/^[<@]/.test(station) && station !== prefs.station) {
      prefs.station = station;
      save();
      refresh();
    }
    $('js8c-text').value = text;
    $('js8c-text').focus();
    refreshPreview();
    syncSendButton();
    showStatus(t('js8chat.reply_filled'));
  }

  $('js8c-quick').addEventListener('click', () => {
    if (!menu.hidden) return closeMenu();
    const s = getSettings();
    const lastRx = prefs.station ? [...saved].reverse().find((m) => m.dir === 'rx' && m.from === prefs.station) ?? null : null;
    const items = quickMenu({ myCall: s.callsign, myGrid: s.grid, selectedCall: prefs.station, lastRx, infoText: prefs.info, statusText: prefs.status });
    // disabled 的項目仍可點：說明原因（同 App 跳 Toast）
    openMenu($('js8c-quick'), items.map((it) => ({
      label: t(it.labelKey),
      run: () => {
        if (it.needsInput) return openAprsDialog();
        if (!it.text) return showStatus(t(it.reasonKey), true);
        fillInput(it.text);
        if (it.coarse) showStatus(t('js8chat.quick.coarse_grid'));
        return null;
      },
    })));
  });

  // 長按泡泡：依內容的回覆選項（只填入、不發射）、複製、複製完整內容、刪除；接收中的只給複製
  function bubbleMenu(m) {
    const s = getSettings();
    const items = [];
    if (!m.live) {
      const env = { myCall: s.callsign, myGrid: s.grid, infoText: prefs.info, statusText: prefs.status, hearing: heardRecently(utcNow()), lastTxText: lastSentText };
      for (const o of replyOptions(m, env)) {
        items.push({ label: o.call ? t('js8chat.reply_call', { call: m.from }) : o.text, run: () => fillInput(o.text, m.dir === 'rx' ? m.from : m.to || prefs.station) });
      }
    }
    items.push({ label: t('js8chat.copy'), run: () => copy(m.text ?? '') });
    items.push({ label: t('js8chat.copy_full'), run: () => copy(fullText(m, { local: prefs.local })) });
    if (!m.live) items.push({ label: t('js8chat.delete'), run: () => removeMessage(m) });
    return items;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      showStatus(t('js8chat.copied'));
    } catch {
      showStatus(text);
    }
  }

  async function removeMessage(m) {
    if (!store || !window.confirm(t('js8chat.delete_confirm'))) return;
    await store.remove(m.id);
    saved = saved.filter((x) => x.id !== m.id);
    refresh();
  }

  // 發 APRS 訊息（@APRSIS CMD）：先問收件人與內文（同 App 對話框），組好後填入輸入框
  const aprsDlg = $('js8c-aprs-dialog');
  function openAprsDialog() {
    $('js8c-aprs-error').textContent = '';
    aprsDlg.showModal();
    $('js8c-aprs-to').focus();
  }
  $('js8c-aprs-cancel').addEventListener('click', () => aprsDlg.close());
  $('js8c-aprs-ok').addEventListener('click', () => {
    const r = aprsCmd($('js8c-aprs-to').value, $('js8c-aprs-text').value); // 一律大寫 legacy（UTX 的 iGate 不轉）
    if (r.error) {
      $('js8c-aprs-error').textContent = t(`js8chat.aprs.${r.error}`, { ch: r.badChar ?? '' });
      return;
    }
    aprsDlg.close();
    fillInput(r.text);
  });

  // ── FUN、自動回覆設定 ──
  const funDlg = $('js8c-fun-dialog');
  $('js8c-local').checked = prefs.local;
  $('js8c-utx').disabled = false;
  $('js8c-utx').checked = prefs.forceUtx;
  $('js8c-utx').addEventListener('change', () => {
    prefs.forceUtx = $('js8c-utx').checked;
    save();
    $('js8c-text').setAttribute('autocapitalize', prefs.forceUtx ? 'sentences' : 'characters');
    refreshPreview();
  });
  $('js8c-text').setAttribute('autocapitalize', prefs.forceUtx ? 'sentences' : 'characters');
  $('js8c-multispeed').disabled = false;
  $('js8c-multispeed').checked = prefs.multiSpeed;
  $('js8c-multispeed').addEventListener('change', () => {
    prefs.multiSpeed = $('js8c-multispeed').checked;
    save();
    rxChanged();
  });
  $('js8c-sort').value = prefs.sort;
  $('js8c-fun').addEventListener('click', () => funDlg.showModal());
  $('js8c-fun-close').addEventListener('click', () => funDlg.close());
  $('js8c-local').addEventListener('change', () => {
    prefs.local = $('js8c-local').checked;
    save();
    refresh();
  });
  $('js8c-sort').addEventListener('change', () => {
    prefs.sort = $('js8c-sort').value;
    save();
    refreshStations();
  });
  $('js8c-clear-all').addEventListener('click', async () => {
    if (!store || !window.confirm(t('js8chat.clear_all_confirm'))) return;
    await store.clearAll();
    saved = [];
    prefs.station = null;
    save();
    refresh();
    funDlg.close();
  });

  const autoDlg = $('js8c-auto-dialog');
  $('js8c-autoreply').checked = prefs.autoReply;
  $('js8c-autoreply').addEventListener('change', () => {
    prefs.autoReply = $('js8c-autoreply').checked;
    save();
  });
  // 右鍵（手機長按）自動回覆開關＝開設定（同 App 長按）
  $('js8c-autoreply').closest('label').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    autoDlg.showModal();
  });
  const autoFields = { 'js8c-auto-cq': 'replyCq', 'js8c-auto-hb': 'replyHb' };
  for (const [id, key] of Object.entries(autoFields)) {
    $(id).checked = prefs[key];
    $(id).addEventListener('change', () => {
      prefs[key] = $(id).checked;
      save();
    });
  }
  const numFields = { 'js8c-hb-hour': 'hbHourly', 'js8c-hb-call': 'hbPerCall' };
  for (const [id, key] of Object.entries(numFields)) {
    $(id).value = String(prefs[key]);
    $(id).addEventListener('change', () => {
      prefs[key] = Number($(id).value);
      save();
    });
  }
  const textFields = { 'js8c-info': 'info', 'js8c-status-text': 'status' };
  for (const [id, key] of Object.entries(textFields)) {
    $(id).value = prefs[key];
    $(id).addEventListener('change', () => {
      prefs[key] = $(id).value.trim().toUpperCase();
      save();
    });
  }
  $('js8c-auto-close').addEventListener('click', () => autoDlg.close());

  $('js8c-hb').value = String(prefs.hbMin);
  $('js8c-hb').addEventListener('change', () => {
    prefs.hbMin = Number($('js8c-hb').value);
    lastHbUtc = 0;
    save();
  });

  // 發射音頻：與發射區塊的 #tx-freq 同一個值（頻譜點選也寫 #tx-freq）
  const freq = $('js8c-freq');
  const syncFreq = () => { freq.value = $('tx-freq').value; };
  syncFreq();
  $('tx-freq').addEventListener('change', syncFreq);
  $('tx-freq').addEventListener('input', syncFreq);
  freq.addEventListener('change', () => {
    const v = Math.min(2500, Math.max(500, Math.round(Number(freq.value) || 1500)));
    freq.value = String(v);
    $('tx-freq').value = String(v);
    $('tx-freq').dispatchEvent(new Event('change'));
  });

  function setStatus(text) {
    $('js8c-status').textContent = text;
  }
  function setDial(text) {
    $('js8c-dial').textContent = text;
  }

  storeReady.then(async (s) => {
    store = s;
    // 保留期限沿用 SWL Log 的設定（design D11）：開啟時清一次
    await store.purgeOlderThan(cutoffFor(Date.now(), loadRetention(storage)));
    saved = await store.list({ limit: MAX_MESSAGES });
    refresh();
    view.scrollToEnd();
  }).catch((err) => showStatus(err.message, true));

  syncSendButton();
  refresh();
  // visible()：對話區目前顯示的訊息（跟著選台篩選；地圖在 JS8 模式只畫這些電台）
  return { onCycle, resetLive, onTxActiveChange, setStatus, setDial, refresh, visible: () => view.messages(), prefs: () => ({ ...prefs }), hasQueued: () => Boolean(queued) }; // prefs().forceUtx：發射介面拆 frame 用
}
