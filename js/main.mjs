// 網頁主程式：音訊 → AudioWorklet 降到 12 kHz → 依 UTC 切 slot → Worker 解碼 → 清單（tasks 3.x），
// 設定畫面見 settings-ui.mjs（4.3）。
import './config/boot.mjs'; // 設定組切換：要在所有模組讀設定之前（add-web-profiles P3）
import { listInputs, openInput } from './audio.mjs';
import { ClockSync, evaluateClock } from './clock.mjs';
import { relayBase, isDevHost, WEB_VERSION } from './config.mjs';
import { startHeartbeat } from './hello.mjs';
import { createScreenKeeper } from './wakelock.mjs';
import { createInputSwitcher } from './inputswitch.mjs';
import { createUpdater, initUpdateBanner } from './update.mjs';
import { Js8MessageAssembler, loadJs8Tables, STALL_SLOTS } from './js8/message.mjs';
import { hexToBytes, js8CycleOutputs } from './js8/cycle.mjs';
import { BUILD_TIME, BUILD_NUMBER } from './version.mjs';
import { clockDetail, clockSummary, clockWarningText, formatOffset, formatUtc, processingWarning, reportStatusText, feedInsertIndex } from './format.mjs';
import { SLOT_MS, SlotCutter, MultiCutter, SampleBuffer, captureWindow, isSlotMode, waitingStateKey } from './slot.mjs';
import { dialInfoOf, freqKey, FreqTimeline, slotRecordable } from './slotfreq.mjs';
import { enabledRxSubmodes, reportable, periodMs as js8PeriodMs } from './js8/submodes.mjs';
import { progressBars, statusLine } from './progress.mjs';
import { ContextClock, contextTimeToEpoch, isContinuation } from './timemap.mjs';
import { timeoutSignal } from './compat.mjs'; // 舊 Chrome（< 103）沒有 AbortSignal.timeout
import { initSettingsUi } from './settings-ui.mjs';
import { initFreqUi } from './freq-ui.mjs';
import { createDebouncer } from './debounce.mjs';
import { initSwlLogUi } from './swllog-ui.mjs';
import { bandOf, selectedDial } from './bands.mjs';
import { formatMHz } from './freqlist.mjs';
import { initRigUi } from './rig/ui.mjs';
import { rigErrorText } from './rig/errors.mjs';
import { initRigWizard } from './rig/wizard-ui.mjs';
import { testToneBlockReason } from './config/testtone.mjs';
import { MeterState, displayFreq, meterView } from './rig/meter-view.mjs';
import { createMeterUi } from './rig/meter-ui.mjs';
import { initMenu } from './layout.mjs';
import { initConfigUi } from './config/ui.mjs';
import { Reporter } from './reporter.mjs';
import { getReceiverId } from './settings.mjs';
import { loadAutoStart, saveAutoStart, shouldAutoStart } from './autostart.mjs';
import { ensureRunning } from './audioctx.mjs';
import { candidateInputs, markDeviceChosen, needsDetection, pickBest, rmsOf, summarize } from './detect.mjs';
import { runDetection } from './detect-run.mjs';
import { initTxUi } from './tx/ui.mjs';
import { nextTxSlot } from './tx/scheduler.mjs';
import { initListTabs, initTabs } from './tabs.mjs';
import { initPhoneUi } from './phone-ui.mjs';
import { initFloat } from './tx/float.mjs';
import { renderQsoList } from './qso/logview.mjs';
import { initQsoUi } from './qso/ui.mjs';
import { openQsoLog } from './qso/log.mjs';
import { importAdif } from './qso/adif-import.mjs';
import { initRowCall } from './tx/rowcall.mjs';
import { menuItems } from './qso/menu.mjs';
import { initContextMenu } from './qso/contextmenu.mjs';
import { initCards } from './cards/ui.mjs';
import { decodeHidden } from './cards/rules.mjs';
import { initSpectrumPanel } from './spectrum/panel.mjs';
import { initMapPanel } from './map/panel.mjs';
import { resolveTileSource } from './map/tilesource.mjs';
import { applyDom, missingKeys, locale, t } from './i18n/index.mjs';
import { initQsoDashboard } from './station/dashboard.mjs';
import { parseMessage } from './ft8parse.mjs';
import { initJs8Chat } from './js8chat/ui.mjs';
import { createFeedCache } from './feedcache.mjs';
import { initSideLayout } from './sidelayout.mjs';
import { openJs8Chat } from './js8chat/store.mjs';
import { requireDisclaimer } from './disclaimer.mjs';
import { DtAdvisor, probeWindow, JS8_SCAN_SUBMODE } from './dtadvisor.mjs';
import { initRxDelayCancel } from './rxdelay-ui.mjs';
import { initDtBanner } from './dtadvisor-ui.mjs';
import { hideSplash } from './splash.mjs';
import { JttyReceiver, frameText } from './jtty/rx.mjs';
import { JttyDiag } from './jtty/diag.mjs';
import { initJttyDiagPanel } from './jtty/diag-ui.mjs';
import { loadUtxTable, isUtxLoaded } from './js8/utx.mjs';
import { initJttyChat } from './jtty/ui.mjs';
import { initJttyTicker } from './jtty/ticker-ui.mjs';
import { DB_NAME as JTTY_DB } from './jtty/chatmodel.mjs';
import { createFrameCounter } from './jtty/framecount.mjs';
import { formatUtcTenths } from './format.mjs';
import { txAudioMaxHz, clampTxAudioHz } from './tx/guard.mjs';

const JTTY_CHANNEL_HZ = 127; // JTTY 佔用頻寬（add-web-jtty D12：瀑布圖從 #tx-freq 起畫 127 Hz）
const $ = (id) => document.getElementById(id);
applyDom(); // 多語系：把 data-i18n 換成目前語系（其他程式之後寫入的文字由各自用 t() 產生）
$('version').textContent = `${WEB_VERSION} ${BUILD_TIME}`; // 完整版本（同送 PSKReporter 的，使用者 2026-10-06）
const dev = isDevHost(location);
// 本機開發版：依轉送站 /time 的 live 顯示回報去向（真的 PSKReporter 或測試用的假伺服器），避免誤會
function showReportDestination(live) {
  const note = $('dev-report-note');
  note.hidden = !dev || live === undefined;
  const strong = (text) => Object.assign(document.createElement('strong'), { textContent: text });
  note.replaceChildren(...(live
    ? [t('page.dev.live_a'), strong(t('page.dev.live_b')), t('page.dev.live_c')]
    : [t('page.dev.fake_a'), strong(t('page.dev.fake_b'))]));
}
const params = new URLSearchParams(location.search);

// performance 時鐘換算成 epoch：與 AudioContext.getOutputTimestamp() 的 performanceTime 同一個時鐘
const epochNow = () => performance.timeOrigin + performance.now();

let phone = null; // 手機版面（web-phone-app-layout），底部分頁建好後才建立
let bottomTabs = null;
const menu = initMenu({ toggle: $('menu-toggle'), drawer: $('menu'), backdrop: $('menu-backdrop'), closeButton: $('menu-close'),
  background: [document.querySelector('main'), document.querySelector('header')],
  asPage: () => Boolean(phone?.asPage()), openPage: () => bottomTabs?.select('settings') }); // 手機：設置是第 5 個分頁
let rigUi = null; // 電台控制（add-web-rig-control），settingsUi 建好後才建立
let jttyTicker = null; // JTTY 字幕區（jtty/ticker-ui.mjs），頻譜建好後才建立；換頻率（設定 onChange）可能更早用到，要先宣告
let jtty = null; // JTTY 通訊畫面（add-web-jtty，jtty/ui.mjs），txUi 建好後才建立；設定、電台事件、狀態列都會用到，要先宣告
let freqUi = null; // 頻率下拉與頻率表編輯（add-web-frequency-list），settingsUi 建好後才建立
// 自動偵測時間偏差（add-dt-offset-advisor）：統計 FT8／FT4／JS8 的 Δt、解不到時掃描延遲；橫幅在頁面最後建立（dtReady 之前不畫）
const dtAdvisor = new DtAdvisor();
let dtReady = false;
let drawDt = () => {};
let drawRxDelay = () => {}; // 青色跑馬條與「取消偏差調整」（D20、D21），頁面最後建立
// 送去解碼的工作：id → { rms, generation }（一般時槽）或 { probe }（掃描用的探測，結果不顯示、不回報）
const slotMeta = new Map();
let lastTune = null; // 上次設給電台的「撥號頻率/模式」（add-web-frequency-list D10：同波段改頻率也要設）
// CAT 設頻延後約 300 ms（code review 2026-10-09）：頻率下拉用鍵盤上下鍵連按時，停下才設一次電台；停止發射仍是立即
const tuneLater = createDebouncer({ delayMs: 300 });
// 摘要列後面的電台資訊組（add-rig-meters）：電腦版 #rig-meters、手機紫色頂列 .pbar-rig；事件來就重算，另每秒重算一次（10 s 過期）
const meterState = new MeterState();
const meterUi = createMeterUi([document.getElementById('rig-meters'), ...document.querySelectorAll('.pbar-rig')]);
// 頻率（add-web-frequency-list）：選的頻率在摘要列的下拉裡；電台讀回的實際頻率與它不同時才在電台組顯示
function drawMeters() {
  if (!rigUi) return;
  const freq = displayFreq(rigUi.actualHz(), selectedDial(settingsUi.get()));
  meterUi.render(meterView(meterState, { ...rigUi.meterInfo(), freq }, Date.now()));
}
setInterval(drawMeters, 1000);
// 撥號頻率與波段（D14）：CAT 連線中用電台實際頻率（10 s 內讀到的），波段由實際頻率推得；不在業餘波段內時 band、dialHz 都是 null（回報暫停）
// 沒有 CAT 時是目前選的頻率（add-web-frequency-list D2）
function dialInfo(band, mode) {
  return dialInfoOf({ actualHz: rigUi?.actualHz() ?? null, band, selectedHz: selectedDial(settingsUi.get(), mode) });
}
// 頻率時間線（add-web-frequency-list D12）：選的頻率、模式、CAT 實際頻率改變時記下（接收 UTC，與切出的樣本同一個時間），
// 切出時槽時取錄音期間的頻率快照；錄音期間變了的時槽只顯示、不回報、不記 SWL Log
const freqTimeline = new FreqTimeline();
function noteFreq() {
  const s = settingsUi.get();
  const actualHz = rigUi?.actualHz() ?? null;
  const at = epochNow() + clock.rxOffsetMs + app.alignShiftMs; // 同 contextTimeToUtc
  freqTimeline.note(freqKey({ mode: s.mode, selectedHz: s.dialHz, actualHz }), dialInfo(s.band, s.mode), at);
}
// 設置頁（左上角抽屜，仿 FT8TW）與主頁的設定摘要列（config/ui.mjs）
let mapPanel = null; // 地圖區塊（下面建立）；設定頁改了線上地圖來源時用到，要先宣告
const configUi = initConfigUi({ storage: localStorage, menu, getSettings: () => settingsUi.get(),
  // 切換設定組前（add-web-profiles P4）：發射中不切；停止發射、斷開電台（PTT 關沒確定送出就不切）
  canReload: () => safeToReload(),
  beforeProfileSwitch: async () => {
    // 發射中、排隊等待、正在準備發射（編碼、開輸出）都不切（review #7）
    if (document.body.classList.contains('tx-armed') || txUi?.controller?.active || jtty?.busy() || $('tx-start').disabled) return t('config.profileBusyTx');
    // PTT 關沒確定送出（含埠已斷但旗標還在）：不切，免得補送的 PTT 關送到新設定組的電台（review C）
    if (rigUi?.rig.pttStuck || rigUi?.rig.readStuck()) return t('rig.pttStuck');
    try {
      await rigUi?.releaseForSwitch(); // 連線中先等開埠完成再斷（review B）
    } catch (err) {
      return rigErrorText(err);
    }
    return null;
  },
  getPtt: () => rigUi?.ptt ?? null, getDialHz: (s) => dialInfo(s.band, s.mode).dialHz,
  onLockChange: () => { drawDt(); drawRxDelay(); }, // 設定組切換中、另一個分頁換了設定組：時間偏差橫幅、取消鈕停用（D19）
  onChange: (cfg) => {
    // 時間偏移或收訊延遲改了：舊的 Δt 不再代表現況，audio-latency 警告不殘留（使用者操作才會呼叫，那時 app、clock 已建立）
    if (cfg.timeOffsetMs !== lastTiming.timeOffsetMs || cfg.rxAudioDelayMs !== lastTiming.rxAudioDelayMs) app.recentDt = [];
    lastTiming = { timeOffsetMs: cfg.timeOffsetMs, rxAudioDelayMs: cfg.rxAudioDelayMs };
    clock.setManualOffset(cfg.timeOffsetMs); // 設置 › 時間偏移
    clock.setRxDelay(cfg.rxAudioDelayMs); // 收訊音訊延遲：只影響接收（下一段音訊時改標已收的樣本）
    render();
    cards?.refreshAll();
    qsoUi?.renderDelayWarning(); // 收訊延遲 vs 自動通聯等待時間（D18）
    mapPanel?.setTileSource(resolveTileSource(cfg)); // 線上地圖來源改了：清圖磚快取、2D／3D 重畫（add-map-tile-source S5）
    syncAdvisor(); // 偏移改了、開關改了：清空統計
    drawRxDelay();
    syncScreenKeeper(); // 接收中保持螢幕開啟的開關
  } });
let lastTiming = { timeOffsetMs: configUi.get().timeOffsetMs, rxAudioDelayMs: configUi.get().rxAudioDelayMs };
const updateSummary = configUi.updateSummary;

// 設定以 localStorage 為準（會覆寫瀏覽器重新整理時自行保留的勾選狀態）
const settingsUi = initSettingsUi({
  storage: localStorage,
  geolocation: navigator.geolocation,
  onChange: (s) => {
    noteFreq(); // 先記下換頻率的時間：正在收的時槽跨兩個頻率就不回報（D12）
    if (s.dialHz !== app.dialHz || s.mode !== app.mode) {
      stopTestTx(); // 換頻率：測試音、精靈的按住發射也停
      jtty?.stopTx(t('tx.modeBandChanged')); // JTTY 隨時發射：換模式或頻率就停（同 txUi.syncDefaultText）
    }
    updateSummary(s);
    drawMeters(); // 電台組：實際頻率與選的頻率比對（add-rig-meters、add-web-frequency-list）
    freqUi?.sync(s); // 頻率下拉（摘要列、手機頂列、設置頁）
    $('mode-select').value = s.mode;
    txUi?.syncDefaultText(); // 發射中換了模式或頻率會先停止發射（PTT 關），之後才設電台
    if (`${s.dialHz}/${s.mode}` !== lastTune) {
      lastTune = `${s.dialHz}/${s.mode}`;
      tuneLater.call(() => rigUi?.tune(s.dialHz)); // 停下 300 ms 才設；先模式、800 ms 後頻率；PTT 開著時延到 PTT 關後
    }
    qsoUi?.render();
    mapPanel?.setMe(s.grid);
    if (s.mode !== app.mode) setMode(s.mode);
    else if (s.dialHz !== app.dialHz) {
      resetJs8(); // 換頻率：舊頻率上進行中的 JS8 訊息不能和新頻率的接在一起（D11）
      resetJttyLive(); // JTTY 同理
    }
    if (s.band !== app.band) clearDecodes(); // 換波段：上一個波段的解碼跟新波段無關，清單、計數一起歸零（使用者需求）
    app.band = s.band;
    app.dialHz = s.dialHz;
    syncJs8Dial();
    render(); // 回報狀態列依呼號／網格而變
    jtty?.refreshFkeys(); // JTTY：巨集按鈕提示跟著呼號更新；防護提示（允許清單）條件解除就清掉
    cards?.refreshAll(); // 卡片的叫我、距離、撥號頻率依呼號／網格／波段而變
    syncAdvisor(); // 換模式／波段／音訊輸入：清空統計
  },
});
// 換頻率、換模式時停止測試音與電台精靈的「按住發射」（code review 2026-10-09；一般發射由 txUi.syncDefaultText 停止）
function stopTestTx() {
  try {
    configUi.stopTestTone();
    rigWizard?.release();
  } catch {
    // 頁面還在初始化（精靈還沒建立）
  }
}
updateSummary(settingsUi.get());
freqUi = initFreqUi({ settingsUi });
lastTune = `${settingsUi.get().dialHz}/${settingsUi.get().mode}`;
// 電台控制（設置 › 電台與聲音）：事件轉給發射與頂列
rigUi = initRigUi({
  storage: localStorage,
  getTargetHz: () => selectedDial(settingsUi.get()),
  onEvent: (type, d) => {
    try {
      onRigEvent(type, d);
    } catch {
      // 頁面還在初始化：下一次事件再處理
    }
  },
});
drawMeters();
function onRigEvent(type, d) {
  noteFreq(); // CAT 實際頻率變了（含連線、斷線）：頻率世代加一（D12）
  meterState.event(type, d, Date.now());
  drawMeters(); // 'prefs'（控制方式、機型改了）也要重畫
  const tx = txUi?.controller;
  if (type === 'freq') syncJs8Dial();
  if (type === 'swr') txUi?.setSwr(d.swr);
  if (type === 'pttStuck') txUi?.setPttStuck(d.stuck); // 發射浮窗也顯示（發射已結束時也要看得到）
  // 改電台設定、換埠、中斷連線：先停止發射（PTT 關），再斷線（安全審查 #5）；JTTY 隨時發射也一樣
  const reasons = [];
  if (type === 'disconnecting') reasons.push(t('rig.changedTx'));
  else if (type === 'pttStuck' && d.stuck) reasons.push(t('rig.pttStuck'));
  if (type === 'swrStop') reasons.push(t('rig.swrStop', { swr: d.swr.toFixed(2) }));
  else if (type === 'disconnect') reasons.push(t('rig.disconnectedTx'));
  else if (type === 'pttWatchdog') reasons.push(t('rig.pttWatchdog'));
  for (const reason of reasons) {
    if (tx?.active) tx.stop(reason);
    jtty?.stopTx(reason);
  }
}

const app = {
  mode: settingsUi.get().mode,
  band: settingsUi.get().band,
  dialHz: settingsUi.get().dialHz,
  running: null, // { ctx, stream, node, cutter }
  worker: null,
  nextId: 1,
  recentDt: [],
  processingWarning: null,
  alignShiftMs: 0, // 只在本機開發 ?align=1 時使用
  results: [], // 本機開發時供自動化讀取
  skips: [],
  timing: [],
};
// 接收中保持螢幕開啟（Screen Wake Lock，使用者 2026-10-18）：手機自動鎖定會暫停分頁、收訊中斷
const screenKeeper = createScreenKeeper();
function syncScreenKeeper() {
  screenKeeper.set(Boolean(app.running) && configUi.get().keepScreenOn);
}

const clock = new ClockSync({
  now: epochNow,
  fetchTime: async () => {
    // 加逾時：轉送站卡住時不要讓量測永遠停住（第一次量測卡住會連定期量測都排不上）
    const res = await fetch(`${relayBase(location)}/time`, { cache: 'no-store', signal: timeoutSignal(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    showReportDestination(body.live);
    return body;
  },
  // 自動校時的時鐘差變動 > 200 ms：時間偏差統計清空（D17）
  onChange: (state) => {
    if (dtAdvisor.noteClockOffset(state.offsetMs)) app.recentDt = [];
    render();
    drawDt();
  },
});
// 發射、通聯、卡片、JS8 用的時間：真實時鐘（自動校時＋時間偏移），不含收訊音訊延遲（D14）
const txClock = (epoch = epochNow()) => epoch + clock.offsetMs;
clock.setManualOffset(configUi.get().timeOffsetMs, { notify: false }); // 載入時：不觸發 render（reporter 還沒宣告）
clock.setRxDelay(configUi.get().rxAudioDelayMs);
noteFreq(); // 頻率時間線的起點（D12）
setInterval(noteFreq, 1000); // CAT 實際頻率 10 s 沒讀到就退回選的頻率：也算頻率改變
// 設置 › 時間偏移：「同步時間」立刻重新校時；卡片顯示校時結果與多久前量的
$('cfg-time-sync').addEventListener('click', async () => {
  $('cfg-time-sync').disabled = true;
  $('cfg-clock-detail').textContent = t('page.clock.syncing');
  try {
    await clock.measure();
  } finally {
    $('cfg-time-sync').disabled = false;
    drawClockDetail();
  }
});
function drawClockDetail() {
  const text = clockDetail(clock.state, clock.manualMs, Date.now());
  if ($('cfg-clock-detail').textContent !== text) $('cfg-clock-detail').textContent = text; // aria-live：沒變不重念
}
setInterval(drawClockDetail, 30_000); // 「n 分鐘前」

// ── 回報（tasks 4.2）──
const receiverId = getReceiverId(localStorage, crypto);
// 使用人數（D18）與後台使用統計（add-relay-admin：呼號＋是否接收中），只給管理者看
// 帶網頁版本（add-version-tracking）；回應的最低流水號交給版本檢查（updater 在頁面最後建立，之前收到的先記著）
let updater = null;
let relayMinBuild = 0;
// 轉發控制（add-relay-forward-control F6、F7）：帶上傳開關；回應的 forward 交給 reporter，暫停狀態有變就重畫狀態列
startHeartbeat({ base: relayBase(location), id: receiverId, getStatus: () => ({ callsign: settingsUi.get().callsign, rx: Boolean(app.running), psk: { spots: Boolean(configUi.get().pskSpots), qso: Boolean(configUi.get().pskQso) } }),
  version: WEB_VERSION, onReply: ({ minBuild, forward }) => { relayMinBuild = minBuild; updater?.setMinBuild(minBuild); if (reporter.setForward(forward)) render(); } });

async function postSpots(payload) {
  const res = await fetch(`${relayBase(location)}/spots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: timeoutSignal(15_000),
  });
  const retryAfter = Number(res.headers.get('retry-after'));
  // 403 要看原因：trial-not-open 才是試驗期，其他（例如 no-client-ip）是轉送站設定問題
  const withReason = res.status === 403 || res.status === 503; // 503 forward-paused（轉發控制）
  const reason = withReason ? (await res.json().catch(() => null))?.error : undefined;
  if (!withReason) res.body?.cancel().catch(() => {});
  return { status: res.status, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined, reason };
}

const reporter = new Reporter({
  send: postSpots,
  getReceiver: () => {
    const s = settingsUi.get();
    return { id: receiverId, callsign: s.callsign, locator: s.grid, webVersion: WEB_VERSION };
  },
  canReport: () => configUi.spotsEnabled() && evaluateClock(clock.state, app.recentDt).canReport,
});
// 每秒檢查是否該送；狀態有變才重畫，免得每秒重建警告清單
setInterval(() => {
  const before = JSON.stringify(reporter.status());
  const after = () => { if (JSON.stringify(reporter.status()) !== before) render(); };
  reporter.tick().then(after, after);
}, 1000);

function render() {
  const ev = evaluateClock(clock.state, app.recentDt);
  const s = settingsUi.get();
  $('clock').textContent = clockSummary(clock.state);
  drawClockDetail();
  $('report').textContent = configUi.spotsEnabled()
    ? reportStatusText(reporter.status(), { canReport: ev.canReport, callsign: s.callsign, grid: s.grid })
    : t('page.report.disabled');
  const items = [];
  if (app.processingWarning) items.push(app.processingWarning);
  for (const code of ev.warnings) items.push(clockWarningText(code, clock.state));
  $('warnings').replaceChildren(...items.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
}

let js8chat = null; // JS8 通訊畫面（add-web-js8-chat），txUi 建好後才建立
// 通訊畫面頂列的波段與 JS8 撥號頻率（沒有 CAT 時請使用者自己把電台換到這個頻率；CAT 連線時顯示電台實際頻率）
function syncJs8Dial() {
  const s = settingsUi.get();
  const hz = rigUi?.actualHz() ?? selectedDial(s, 'JS8');
  const band = (hz && bandOf(hz)) || s.band;
  js8chat?.setDial(hz ? `${band} ${formatMHz(hz)} MHz` : band); // 7.0475 不四捨五入
  const jhz = rigUi?.actualHz() ?? selectedDial(s, 'JTTY');
  const jband = (jhz && bandOf(jhz)) || s.band;
  jtty?.setDial(jhz ? `${jband} ${formatMHz(jhz)} MHz` : jband);
}
function setState(text) {
  $('state').textContent = text;
  js8chat?.setStatus(text); // 通訊畫面頂列也顯示收訊狀態（手機上看不到控制分頁）
  jtty?.setStatus(text);
}

async function refreshDevices() {
  const select = $('device');
  const current = select.value;
  const inputs = await listInputs(navigator.mediaDevices);
  select.replaceChildren(
    new Option(t('page.device.default'), ''),
    ...inputs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d) => new Option(d.label, d.deviceId)),
  );
  // 優先選回上次存的裝置（自動開始要用）；不在清單上就退回預設裝置
  const wanted = settingsUi.get().deviceId || current;
  select.value = [...select.options].some((o) => o.value === wanted) ? wanted : '';
}

// 音訊時鐘是連續的；換算到 performance 時鐘的偏移量每次讀都有抖動，平滑後再用（timemap.mjs）
// 接收用 clock.rxOffsetMs（時鐘差−收訊音訊延遲，add-dt-offset-advisor D14）：切出的 slot 對上空中時間；發射仍用 clock.offsetMs
function contextTimeToUtc(ctx, contextClock, contextTime) {
  return contextTimeToEpoch(ctx, contextClock, contextTime) + clock.rxOffsetMs + app.alignShiftMs;
}

// 每列解碼的原始資料（從解碼清單呼叫用，D13）；列被移除後自動回收
const rowData = new WeakMap();
// 解碼清單暫存（使用者 2026-10-07）：切換語言、重新整理後放回（同一分頁內，30 分鐘）
const feedCache = createFeedCache({ storage: (() => { try { return globalThis.sessionStorage; } catch { return null; } })() });
let cards = null; // 解碼卡片、呼叫清單、電台卡（cards/ui.mjs），在通聯區塊之後建立

// full：FT8／FT4／FT2 接收 slot（暫存取回時也放回呼叫清單、電台卡、地圖）；replay：從暫存放回，不再記一次
function addRows(msg, { full = false, replay = false } = {}) {
  if (!replay) feedCache.record(msg, { full });
  const tbody = $('decodes');
  const frag = document.createDocumentFragment();
  const visible = cards.decodeFilter(); // 時間、類別篩選（使用者 2026-10-09）
  msg.results.forEach((r, i) => {
    const tr = document.createElement('tr');
    // JTTY 每個 frame 有自己的起點（r.startUtc），同一個視窗的 frame 一次加入、只有第一列畫分隔線
    const data = { text: r.text, snr: r.snr, freqHz: r.freqHz, timeSec: r.timeSec, startUtc: r.startUtc ?? msg.startUtc, mode: msg.mode ?? app.mode };
    if (Number.isFinite(msg.dialHz)) data.dialHz = msg.dialHz;
    if (msg.own) data.own = true;
    rowData.set(tr, data);
    if (i === 0) tr.className = 'slot-start';
    tr.hidden = decodeHidden({ rowMode: data.mode, appMode: app.mode, visible: visible(data) }); // 清單只顯示目前模式（使用者 2026-10-08：JS8 混進 FT8 清單）且符合篩選
    cards.fillRow(tr, data); // FT8TW 卡片（S. dB Δt Hz 訊息 頻率／UTC 國名 D·I·C 距離），role 由它設定
    frag.append(tr);
  });
  // 新的在上；只看最上面幾列（我方列最多早一個 slot）
  const head = [...tbody.rows].slice(0, 40);
  const at = feedInsertIndex(head.map((tr) => rowData.get(tr)?.startUtc ?? Infinity), msg.startUtc);
  tbody.insertBefore(frag, head[at] ?? (at < head.length ? null : head.at(-1)?.nextSibling ?? null));
  updateDecodeCount();
}

// 目前模式看得到的列數（其他模式的列藏著，切回去還在）；有篩選時顯示「顯示中／總數」（總數＝目前模式的列）
function updateDecodeCount() {
  const rows = [...$('decodes').rows];
  const shown = rows.filter((tr) => !tr.hidden).length;
  const total = rows.filter((tr) => (rowData.get(tr)?.mode ?? app.mode) === app.mode).length;
  $('count').textContent = cards?.decodeCountText(shown, total) ?? t('page.decode.count', { n: shown });
  cards?.decodeEmpty(shown, total); // 沒有列看得到：清單中間顯示雷達
}
// 清空解碼清單（換波段、按「清除」都呼叫）：連同暫存一起清，否則重新整理後舊波段的列又冒出來
function clearDecodes() {
  $('decodes').replaceChildren();
  $('count').textContent = '';
  cards?.decodeEmpty(0, 0);
  feedCache.clear(); // 重新整理也不再冒出來
}
// 換模式或篩選改變：清單只留目前模式（FT8、FT4、FT2、JS8 各自一份）且符合時間、類別篩選的列
function filterDecodesByMode() {
  const visible = cards?.decodeFilter() ?? (() => true);
  for (const tr of $('decodes').rows) {
    const data = rowData.get(tr);
    tr.hidden = decodeHidden({ rowMode: data?.mode, appMode: app.mode, visible: !data || visible(data) });
  }
  updateDecodeCount();
}

// JS8（tasks 6.5）：字表第一次用到才載入；frame 依頻率桶組成訊息（同 FT8TW Js8Receiver）
let js8Tables = null;
function ensureJs8Tables() {
  js8Tables ??= loadJs8Tables().then(() => {
    js8TablesFailed = false;
  }, (err) => {
    js8Tables = null; // 下次重試；這一輪照樣顯示（JSC／UTX 文字會是空的）
    js8TablesFailed = true;
    setState(t('page.state.js8_tables_failed', { error: err.message }));
  });
  return js8Tables;
}
let js8Assembler = null;
let js8Generation = 0; // 換模式、換波段、停止時加一：等字表期間發生這些事，舊的一輪就丟掉
let js8TablesFailed = false;
function resetJs8() {
  js8Assembler = null;
  js8Generation += 1;
  js8chat?.resetLive(); // 接收中泡泡屬於舊頻率／舊模式
}

// meta：切出時槽時的快照（D12）：JS8 世代、錄音期間的頻率；錄音期間換了頻率的週期只顯示、不回報、不記 SWL Log
async function onJs8Decoded(data, meta) {
  const gen = meta?.js8Gen ?? js8Generation;
  const { band, dialHz } = meta?.freq ?? dialInfo(settingsUi.get().band, 'JS8');
  const recordable = slotRecordable(meta);
  await ensureJs8Tables();
  if (!app.running || gen !== js8Generation || app.mode !== 'JS8') return;
  js8Assembler ??= new Js8MessageAssembler({ now: () => epochNow() + clock.offsetMs });
  const submode = data.submode ?? 0;
  const frames = data.results.map((f) => ({ ...f, payload: hexToBytes(f.payload) }));
  const cycle = js8Assembler.processCycle(frames, submode); // 組訊息依速度分開（D7）
  if (cycle.error) setState(t('page.state.js8_bad_frame', { error: cycle.error.message ?? cycle.error }));
  const { rows, reports, logRecords } = js8CycleOutputs(cycle, { startUtc: data.startUtc });
  for (const r of rows) app.recentDt.push(r.timeSec);
  app.recentDt = app.recentDt.slice(-200);
  if (dev) app.results.push({ ...data, results: rows, messages: cycle.messages });
  // 字表沒載入時 JSC／UTX 文字不完整：不寫進 SWL Log（會永久留下錯字）
  if (recordable && !js8TablesFailed) swlLog?.record(logRecords.map((r) => ({ ...r, dialHz, band, mode: 'JS8' })));
  if (recordable && reportable(submode)) reporter.add({ startUtc: data.startUtc, mode: 'JS8', band, dialHz, results: reports }); // FTW 4S 不回報（W1）
  if (!recordable) setState(t('page.state.freq_changed', { mode: 'JS8', utc: formatUtc(data.startUtc), n: rows.length }));
  else if (!cycle.error && !js8TablesFailed) setState(t('page.state.receiving_js8', { utc: formatUtc(data.startUtc), n: rows.length, ms: Math.round(data.ms) }));
  app.decodeMs = data.ms;
  app.lastSlotRows = rows.length;
  if (rows.length) addRows({ startUtc: data.startUtc, mode: 'JS8', results: rows });
  if (rows.length) spectrum?.onDecoded({ startUtc: data.startUtc, mode: 'JS8', submode, results: rows }); // 瀑布圖標記 JS8 frame
  // 字表沒載入時文字不完整：不寫進對話紀錄（同 SWL Log）
  // cycle.error 時例外之前已送出的訊息照樣寫入（同 SWL Log）
  if (!js8TablesFailed) js8chat?.onCycle({ messages: cycle.messages, pending: js8Assembler.pending(submode), submode }).catch((err) => setState(t('page.state.js8_failed', { error: err.message })));
  render();
}

// ── JTTY 串流接收（add-web-jtty jtty-receiver、design D4）──
// 選 JTTY 且接收中：StreamCutter 與時槽切窗器共用同一個 SampleBuffer，每 2.0 s 切最近 4.0 s 送 Worker；結果進組合器 → 泡泡、解碼列表
let jttyRx = null;
// 收訊診斷（使用者 2026-10-10：訊息中間缺段時找原因；只觀測，不改接收行為）：接收器記視窗與丟棄，這裡記音訊中斷、分頁、AudioContext
let jttyDiagPanel = null;
const jttyDiag = new JttyDiag({ getVisibility: () => document.visibilityState, onChange: () => jttyDiagPanel?.schedule() });
let jttyDecodeError = null; // 同一個錯誤只顯示一次（Worker 載入失敗時每 2 s 都會回錯）
// 強化編碼（add-jtty-utx）：UTX 字表在開始收 JTTY 時就載入；含 UTX frame 的結果在載入完成前由接收器暫存
const jttyUtxReady = () => (isUtxLoaded() ? true : loadUtxTable());
// 主執行緒的 JTTY codec（約 20 KB WASM）：送出前的規劃（framecount）與糾錯修復（add-jtty-fec，unpack 檢查文法）共用一個；失敗可重試
let jttyCodecLoading = null;
const loadJttyCodec = () => (jttyCodecLoading ??= import('../decoder/jttydecoder.mjs').then((m) => m.createJttyCodec()).catch((err) => {
  jttyCodecLoading = null;
  throw err;
}));
function syncJttyRx() {
  const want = Boolean(app.running) && app.mode === 'JTTY';
  if (want && !jttyRx) {
    jttyDecodeError = null;
    loadUtxTable().catch(() => {}); // 失敗時第一個 UTX frame 到時再試一次
    jttyRx = new JttyReceiver({
      utxReady: jttyUtxReady,
      loadCodec: loadJttyCodec,
      diag: jttyDiag,
      buffer: app.running.cutter.buffer,
      post: (job, transfer) => app.worker.postMessage(job, transfer),
      nextWorkerId: () => app.nextId++,
      onMessage: onJttyMessage,
      onFrames: onJttyFrames,
      onDropped: (n) => {
        jtty?.setDropped(n);
        setState(t('jtty.dropped', { n }));
      },
      onError: (error) => {
        if (error === jttyDecodeError) return;
        jttyDecodeError = error;
        setState(t('page.state.decode_error', { error }));
      },
    });
    jtty?.setDropped(0);
    if (dev) app.jttyRx = jttyRx;
  } else if (!want && jttyRx) {
    jttyRx.stop();
    jttyRx = null;
    if (dev) app.jttyRx = null;
    jtty?.resetLive();
  }
}
// 換頻率：接收中的 JTTY 訊息屬於舊頻率
function resetJttyLive() {
  jttyRx?.asm.clear();
  jtty?.resetLive();
  jttyTicker?.clear();
}
// 每個視窗解出的 frame：解碼列表每個 frame 一列（起點 UTC 到 0.1 s、SNR、頻率、內容；不顯示 DT）。瀑布圖不標 JTTY（改由字幕區）。不回報（W1）
function onJttyFrames(frames, job) {
  jttyDecodeError = null;
  if (frames.length) {
    const sorted = [...frames].sort((a, b) => a.t0 - b.t0);
    // 擴充 frame（add-jtty-utx U7）：UTX 顯示這個 frame 解出的字並標「強化·只與 FT8TW 互通」，發話者 frame 顯示呼號
    const labels = { utxTag: t('jtty.utx_row'), senderText: (call) => t('jtty.sender_row', { call }), parityTag: t('jtty.parity_row') };
    addRows({ startUtc: sorted[0].t0, mode: 'JTTY', results: sorted.map((f) => ({ text: frameText(f, labels), snr: f.snr ?? 0, freqHz: f.freqHz, timeSec: 0, startUtc: f.t0 })) });
  }
  if (dev) app.results.push({ mode: 'JTTY', startUtc: job?.startUtc ?? null, results: frames });
  if (job) setState(t('jtty.state.receiving', { utc: formatUtcTenths(job.startUtc), n: frames.length }));
  app.lastSlotRows = frames.length;
}

// ── 時間偏差（add-dt-offset-advisor）──
// 清空條件（design D7）：波段、模式、音訊輸入、時間偏移、開關、開始／停止接收；內容變了就清空統計、世代加一
function syncAdvisor() {
  if (!dtReady) return;
  const s = settingsUi.get();
  dtAdvisor.setEnabled(configUi.get().dtAdvisor);
  dtAdvisor.setContext([s.band, app.mode, $('device').value, configUi.get().timeOffsetMs, configUi.get().rxAudioDelayMs, app.running ? 'rx' : 'idle'].join('|'));
  drawDt();
}

// 掃描偵測（design D6）：一般時槽解完、worker 空閒時送一個探測——假設音訊晚 d 秒，從共用緩衝取 [S＋d, S＋d＋slot)
// decodeMs：剛完成的正常解碼花的時間；超過時槽的 1/3（PROBE_MAX_DECODE_FRACTION）就不送，留到下一個時槽（不拖慢下一個正常解碼）
// JS8（D23）：只在 NOR 週期解完後送，用 NOR 的擷取窗（slot 前 1 秒起 14.84 秒）、帶 submode 0
function sendProbe(mode, decodeMs) {
  const submode = mode === 'JS8' ? JS8_SCAN_SUBMODE : undefined;
  const period = mode === 'JS8' ? SLOT_MS.JS8 : SLOT_MS[mode];
  const cap = captureWindow(mode, submode);
  const probe = dtAdvisor.nextProbe(mode, { now: epochNow() + clock.offsetMs, decodeMs, periodMs: period });
  if (!probe) return;
  const buffer = app.running?.cutter?.buffer;
  const end = buffer?.endUtc ?? null;
  const win = end === null ? null : probeWindow(end, period, probe.delaySec, cap);
  const samples = win && buffer.extract(win.fromUtc, cap.durationMs);
  if (!samples) {
    dtAdvisor.probeFailed(probe); // 緩衝還沒涵蓋：下一個時槽再試
    return;
  }
  const id = app.nextId++;
  slotMeta.set(id, { probe });
  if (dev) app.probes.push({ ...probe, startUtc: win.startUtc });
  app.worker.postMessage({ id, mode, startUtc: win.startUtc, samples, submode, probe: true }, [samples.buffer]); // probe：不寫回呼號雜湊表
}

// busy：JS8 佇列有工作時 worker 不解探測（不擠掉一般週期，D23），下一個 NOR 週期再試同一個 d
function onProbeDecoded(probe, data) {
  if (!app.running || data.error || data.busy || !data.results || data.mode !== app.mode) dtAdvisor.probeFailed(probe);
  else dtAdvisor.probeResult(probe, data.results.map((r) => r.timeSec));
  if (dev) app.probeResults.push({ ...probe, n: data.results?.length ?? 0, dts: data.results?.map((r) => r.timeSec) });
  drawDt();
}

function onDecoded({ data }) {
  const meta = slotMeta.get(data.id);
  slotMeta.delete(data.id);
  if (meta?.probe) return onProbeDecoded(meta.probe, data);
  if (!app.running) return; // 停止後才完成的解碼不再顯示，免得蓋掉「已停止」
  if (data.mode === 'JTTY') { // 串流模式：不進時間偏差、回報、通聯、卡片、地圖（D15、W1）
    if (jttyRx?.owns(data.id)) {
      if (Number.isFinite(data.ms)) app.decodeMs = data.ms;
      jttyRx.onResult(data);
    }
    return;
  }
  if (data.error) {
    setState(t('page.state.decode_error', { error: data.error }));
    return;
  }
  if (data.dropped) { // Worker 的 JS8 佇列滿了，丟掉最舊的（design D5）；組訊息器照樣推進一輪，逾時才不會被拉長
    app.js8Dropped = (app.js8Dropped ?? 0) + 1;
    setState(t('js8chat.dropped', { n: app.js8Dropped }));
    onJs8Decoded({ ...data, results: [], ms: 0 }, meta).catch(() => {});
    return;
  }
  if (data.mode !== app.mode) return; // 換模式之前排進 Worker 的舊工作：結果不進目前模式（JS8 在 onJs8Decoded 另有同樣的檢查）
  if (data.mode === 'JS8') {
    // 時間偏差統計（D22、D23）：worker 已把 Δt 換算成相對名目起點；模組自己只收 NOR／SLO，NOR 週期解完才可能送探測
    const m = meta ?? { rms: 1, generation: dtAdvisor.generation };
    const submode = data.submode ?? 0;
    dtAdvisor.addSlot({ mode: 'JS8', submode, startUtc: data.startUtc, dts: data.results.map((r) => r.timeSec), rms: m.rms, generation: m.generation });
    if (submode === JS8_SCAN_SUBMODE) sendProbe('JS8', data.ms);
    drawDt();
    onJs8Decoded(data, meta).catch((err) => setState(t('page.state.js8_failed', { error: err.message })));
    return;
  }
  for (const r of data.results) app.recentDt.push(r.timeSec);
  app.recentDt = app.recentDt.slice(-200);
  if (dev) app.results.push(data);
  // 時間偏差統計（只收 FT8／FT4，模組自己擋）；沒有 meta 的是開發掛鉤注入的結果，當作有聲音、目前世代
  const m = meta ?? { rms: 1, generation: dtAdvisor.generation };
  dtAdvisor.addSlot({ mode: data.mode, startUtc: data.startUtc, dts: data.results.map((r) => r.timeSec), rms: m.rms, generation: m.generation });
  sendProbe(data.mode, data.ms);
  drawDt();
  // 錄這個時槽時的頻率（切出時的快照，D12；CAT 連線時是電台實際頻率，D14）；沒有快照（開發掛鉤注入）用現在的
  const { band, dialHz } = meta?.freq ?? dialInfo(settingsUi.get().band, data.mode);
  const recordable = slotRecordable(meta); // 錄音期間換了頻率：只顯示，不回報、不記 SWL Log
  if (recordable) {
    swlLog?.record(data.results.map((r) => ({
      utc: data.startUtc, dialHz, band, mode: data.mode, snr: r.snr, dt: r.timeSec, audioHz: r.freqHz, text: r.text,
    })));
    reporter.add({ startUtc: data.startUtc, mode: data.mode, band, dialHz, results: data.results });
  }
  data.dialHz = dialHz; // 收到當時的撥號頻率：之後換模式／頻率，這些列仍顯示原本的（Codex 2026-10-09）
  qsoUi.onSlotDecoded(data); // 通聯流程：每個接收 slot（含 0 則）
  cards.onDecoded(data); // 呼叫清單與電台卡
  mapPanel?.onSlot(data); // 地圖：最近聽到的電台
  setState(recordable
    ? t('page.state.receiving', { mode: data.mode, utc: formatUtc(data.startUtc), n: data.results.length, ms: Math.round(data.ms) })
    : t('page.state.freq_changed', { mode: data.mode, utc: formatUtc(data.startUtc), n: data.results.length }));
  app.decodeMs = data.ms; // 手機工具列「解碼耗時」、欄名列「訊息(n/總數)」
  qsoUi.renderDelayWarning(); // 解碼時間變了：收訊延遲警告重算（D18）
  app.lastSlotRows = data.results.length;
  addRows(data, { full: true });
  spectrum?.onDecoded(data); // 瀑布圖標記訊息
  render();
}

// 自動偵測音訊來源與模式（D15）：選好就寫回設定；都沒解到就列出各輸入的音量
async function detect() {
  // 先拿到麥克風權限，才列得出裝置名稱
  const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
  probe.getTracks().forEach((t) => t.stop());
  const inputs = candidateInputs(await listInputs(navigator.mediaDevices));
  await refreshDevices();
  const show = (lines) => $('detect-result').replaceChildren(...lines.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
  if (inputs.length === 0) {
    markDeviceChosen(localStorage);
    show([t('page.detect.none')]);
    return;
  }
  show([]);
  const results = await runDetection({
    inputs,
    mediaDevices: navigator.mediaDevices,
    clockOffsetMs: clock.rxOffsetMs, // 偵測是接收：含收訊音訊延遲
    notice: $('tap-to-start'),
    onProgress: (text) => setState(t('page.state.detecting', { text })),
    align: dev && params.has('align'),
  });
  if (dev) app.detection = results;
  const best = pickBest(results);
  const lines = summarize(results);
  lines.push(best
    ? t('page.detect.chosen', { label: best.label, mode: best.mode, n: best.count })
    : t('page.detect.nothing'));
  show(lines);
  markDeviceChosen(localStorage); // 偵測跑完就算選過：都沒解到時不要每次開始都再卡 30 秒
  if (best) settingsUi.choose({ deviceId: best.deviceId, mode: best.mode });
}

async function start({ forceDetect = false } = {}) {
  if (app.running || app.starting) return; // 自動開始與手動按鈕不要同時開兩組音訊
  app.starting = true;
  saveAutoStart(localStorage, { stoppedByUser: false });
  $('start').disabled = true;
  $('detect').disabled = true; // 開始中按偵測會被上面的檢查吃掉，乾脆停用
  let stream = null;
  let ctx = null;
  try {
    // 第一次（還沒選過裝置）或使用者按了「自動偵測」：先偵測再開始（D15）
    if (forceDetect || needsDetection(localStorage, settingsUi.get().deviceId)) {
      try {
        await detect();
      } catch (err) {
        $('detect-result').replaceChildren(Object.assign(document.createElement('li'), { textContent: t('page.detect.failed', { error: err.message }) }));
      }
    }
    setState(t('page.state.getting_audio'));
    let stillOn;
    // 自動開始時裝置清單可能還沒列好（選單只有預設裝置），所以退回上次存的裝置；
    // 存的裝置已經拔掉（OverconstrainedError／NotFoundError）就改用預設裝置
    const deviceId = $('device').value || settingsUi.get().deviceId || undefined;
    try {
      ({ stream, stillOn } = await openInput(navigator.mediaDevices, deviceId));
    } catch (err) {
      if (!deviceId || !['OverconstrainedError', 'NotFoundError'].includes(err?.name)) throw err;
      ({ stream, stillOn } = await openInput(navigator.mediaDevices, undefined));
    }
    app.processingWarning = processingWarning(stillOn);
    jttyDiag.setEnv({ processingStillOn: stillOn ?? [] });
    await refreshDevices(); // 授權後才拿得到裝置名稱

    ctx = new AudioContext();
    await ensureRunning(ctx, { notice: $('tap-to-start') }); // 自動播放被擋時提示點一下（D17）
    await ctx.audioWorklet.addModule(new URL('../worklet/capture.mjs', import.meta.url));
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'ft8tw-capture', { numberOfOutputs: 1 });
    const mute = ctx.createGain();
    mute.gain.value = 0; // 接到 destination 確保節點被排程，但不出聲
    source.connect(node).connect(mute).connect(ctx.destination);
    // 保持喚醒（2026-10-07 實測）：輸出完全靜音時，Chrome 會把背景分頁的 AudioContext 降速（每秒少跑約 0.3 秒、麥克風樣本遺失，
    // 時槽一直「音訊不完整」被略過——例如前景開 WebSDR、網頁放背景）。接一個聽不到的直流（0.001，約 -60 dBFS；喇叭與電台音訊
    // 輸入都有隔直流，不會出聲也不會觸發 VOX）讓它算「有在出聲」，實測降速消失
    const keepAwake = ctx.createConstantSource();
    keepAwake.offset.value = 0.001;
    keepAwake.connect(ctx.destination);
    keepAwake.start();

    app.worker ??= Object.assign(new Worker(new URL('../worker/decoder-worker.mjs', import.meta.url), { type: 'module' }), {
      onmessage: onDecoded,
      onerror: (e) => setState(t('page.state.decoder_failed', { error: e.message ?? t('page.state.unknown_error') })),
    });
    // 切窗器：JS8 依「發射速度＋同時解碼其他速度」每個速度一個，共用同一個樣本緩衝（add-web-js8-chat D4、D6）
    app.js8Dropped = 0;
    const cutter = new MultiCutter({ buffer: new SampleBuffer() });
    cutter.setCutters(buildCutters(app.mode, cutter.buffer));

    let contextClock = new ContextClock();
    let prevContextTime = null;
    // 音訊串流中斷（worklet 重新起算、AudioContext 暫停／恢復）：時間換算重來、清空切段緩衝，
    // 寧可少解一個 slot，也不要把中斷前後的音訊拼在一起（ContextClock 取最小值，偏移變大時要一個視窗才跟上）。
    // 分頁回到前景本身不是中斷，不清（2026-10-09 實測：有保持喚醒時背景期間音訊塊連續、最大間隔 < 200 ms；
    // 回前景就清會丟掉還沒切的音訊，JTTY 串流收到一半的訊息因此缺 frame）。真的中斷由 isContinuation 與 statechange 抓
    const resetTiming = (reason) => {
      if (jttyRx) jttyDiag.event('reset', { reason });
      contextClock = new ContextClock();
      prevContextTime = null;
      cutter.buffer.clear();
    };
    ctx.addEventListener('statechange', () => {
      if (jttyRx) jttyDiag.event('audioState', { state: ctx.state });
      resetTiming('statechange');
    });
    let appliedOffset = clock.rxOffsetMs;
    node.port.onmessage = ({ data }) => {
      if (!isContinuation(prevContextTime, data.contextTime)) resetTiming('discontinuity');
      prevContextTime = data.contextTime;
      // 時鐘差重新量測後（每 10 分鐘、或第一次量測晚於開始接收），已收的樣本改用新的時鐘差，
      // 否則時間戳記跳一下就被當成掉音而清空緩衝、漏掉正在收的 slot
      // 時間偏移、收訊音訊延遲改了也一樣（不必重新開始接收）
      if (clock.rxOffsetMs !== appliedOffset) {
        const delta = clock.rxOffsetMs - appliedOffset;
        cutter.buffer.shift(delta);
        appliedOffset = clock.rxOffsetMs;
        jttyRx?.shift(delta); // JTTY：視窗接續、解碼中與接收中的訊息一起改時間（重新對齊會丟視窗、拆散收到一半的訊息）
      }
      let utc = contextTimeToUtc(ctx, contextClock, data.contextTime);
      if (dev) {
        const end = cutter.buffer.endUtc;
        if (end !== null && Math.abs(utc - end) > 20) {
          const ts = ctx.getOutputTimestamp();
          app.timing.push({ at: Math.round(performance.now()), gap: Math.round(utc - end), ctxTime: data.contextTime,
            ctxNow: ctx.currentTime, raw: ts.performanceTime - ts.contextTime * 1000, smooth: contextClock.offset });
        }
      }
      if (dev && params.has('align') && app.alignShiftMs === 0) {
        // 本機測試：假音訊檔從 slot 邊界錄起，把第一個樣本對齊到下一個 slot 邊界。
        // ?align=60：對齊到 60 秒邊界（JS8 多速度測試：4／6／10／15／30 秒的 slot 都從檔案開頭對齊）
        const period = params.get('align') === '60' ? 60_000 : (SLOT_MS[app.mode] ?? 15_000); // JTTY 不是時槽模式：對齊到 15 秒（否則 NaN 讓時間戳記全壞）
        app.alignShiftMs = Math.floor(utc / period) * period + period - utc;
        utc += app.alignShiftMs;
        redrawProgress(); // 跑馬條改用對齊後的時間
      }
      spectrum?.push(data.samples, utc, app.mode, slotMsNow()); // 頻譜：只複製樣本，看不到時直接略過（D21）
      if (jttyRx) { // 收訊診斷：接不上的音訊塊會讓 SampleBuffer 清空（gap）
        const end = cutter.buffer.endUtc;
        if (end !== null && Math.abs(utc - end) > cutter.buffer.gapToleranceMs) jttyDiag.event('gap', { utc: end, ms: Math.round(utc - end) });
      }
      cutter.feed(data.samples, utc);
      jttyRx?.poll(); // JTTY：緩衝湊滿 4 s 視窗就送解碼
    };

    app.running = { ctx, stream, node, cutter };
    syncScreenKeeper();
    txUi.refreshDevices().catch(() => {}); // 取得麥克風權限後才列得出輸出裝置名稱
    if (app.mode === 'JS8') ensureJs8Tables();
    syncJttyRx();
    startProgress();
    $('stop').disabled = false;
    setState(t(waitingStateKey(app.mode), { mode: app.mode, rate: ctx.sampleRate }));
    syncAdvisor();
    render();
  } catch (err) {
    // 中途失敗要放掉麥克風與 AudioContext，否則麥克風一直開著、每次重試再多開一個
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close().catch(() => {});
    $('tap-to-start').hidden = true;
    setState(t('page.state.cannot_start', { error: err.message }));
    $('start').disabled = false;
  } finally {
    app.starting = false;
    $('detect').disabled = false;
  }
}

async function stop({ byUser = true } = {}) {
  const r = app.running;
  if (!r) return;
  if (byUser) saveAutoStart(localStorage, { stoppedByUser: true }); // 使用者自己停的：下次開網頁不自動開始（D17）
  $('tap-to-start').hidden = true;
  app.running = null;
  syncScreenKeeper();
  resetJs8();
  syncJttyRx();
  r.node.port.onmessage = null;
  redrawProgress(); // 立刻隱藏跑馬條
  r.stream.getTracks().forEach((t) => t.stop());
  await r.ctx.close();
  app.alignShiftMs = 0;
  $('start').disabled = false;
  $('stop').disabled = true;
  setState(t('page.state.stopped'));
  syncAdvisor();
}

// 依模式（JS8 另依通訊畫面的速度設定）建切窗器；onSlot 把樣本交給 Worker（JS8 帶 submode）
// 目前模式的 slot 長度（JS8 依通訊畫面的發射速度）：跑馬條、週期、頻譜時槽線、地圖時效用（code review 2026-10-07）
function slotMsNow(mode = app.mode) {
  return mode === 'JS8' ? js8PeriodMs(js8chat?.prefs().submode ?? 0) : SLOT_MS[mode];
}

// existing：目前的切窗器；仍啟用的（同模式、同速度）沿用原物件，進行中的 slot 不會被跳過（code review 2026-10-07）
function buildCutters(mode, buffer, existing = []) {
  const reuse = (submode) => existing.find((c) => c.mode === mode && (mode !== 'JS8' || c.submode === submode));
  const onSlot = ({ mode: m, startUtc, samples, submode }) => {
    const id = app.nextId++;
    // 頻率快照（D12）：錄音期間 [起點−提前量, ＋擷取長度) 的頻率與世代；JS8 世代也在切出時取（解碼完成時才取會用到換頻率後的世代）
    noteFreq();
    const cap = captureWindow(m, submode);
    const from = startUtc - cap.leadMs;
    const snap = freqTimeline.slot(from, from + cap.durationMs);
    slotMeta.set(id, {
      ...(m !== 'FT2' && { rms: rmsOf(samples) }), // 時間偏差統計（樣本轉移前算 RMS；FT2 不偵測）
      generation: dtAdvisor.generation,
      freq: snap.freq ?? dialInfo(settingsUi.get().band, m), freqGen: snap.freqGen, freqChanged: snap.freqChanged,
      js8Gen: js8Generation,
    });
    app.worker.postMessage({ id, mode: m, startUtc, samples, submode }, [samples.buffer]);
  };
  const onSkip = (skip) => {
    if (dev) app.skips.push(skip);
    setState(t('page.state.slot_incomplete', { utc: formatUtc(skip.startUtc) }));
  };
  if (!isSlotMode(mode)) return []; // JTTY：串流模式，不建 SlotCutter（StreamCutter 見 syncJttyRx，D15）
  if (mode !== 'JS8') return [reuse() ?? new SlotCutter({ mode, buffer, onSlot, onSkip })];
  const p = js8chat?.prefs() ?? { submode: 0, multiSpeed: false };
  return enabledRxSubmodes(p.submode, p.multiSpeed).map((submode) => reuse(submode) ?? new SlotCutter({ mode, submode, buffer, onSlot, onSkip }));
}

// 不再解的速度：組訊息器裡它的未完成訊息不會再有 processCycle 推進逾時，空跑 STALL_SLOTS 輪讓它們以不完整送出
function drainJs8Submode(submode) {
  if (!js8Assembler) return;
  const messages = [];
  for (let i = 0; i < STALL_SLOTS; i++) messages.push(...js8Assembler.processCycle([], submode).messages);
  if (!messages.length) return;
  const now = epochNow() + clock.offsetMs;
  const { logRecords } = js8CycleOutputs({ frames: [], messages }, { startUtc: now });
  const { band, dialHz } = dialInfo(settingsUi.get().band, 'JS8');
  if (!js8TablesFailed) swlLog?.record(logRecords.map((r) => ({ ...r, dialHz, band, mode: 'JS8' })));
  js8chat?.onCycle({ messages, pending: [], submode }).catch(() => {});
}

// 通訊畫面改了發射速度或「同時解碼其他速度」：重建 JS8 切窗器（緩衝保留，正在收的音訊不丟）
document.addEventListener('ft8tw:js8rx', () => {
  if (app.mode !== 'JS8' || !app.running) return;
  const mc = app.running.cutter;
  const before = mc.cutters.map((c) => c.submode);
  mc.setCutters(buildCutters('JS8', mc.buffer, mc.cutters));
  const now = new Set(mc.cutters.map((c) => c.submode));
  for (const s of before) if (!now.has(s)) drainJs8Submode(s);
  redrawProgress();
});

function setMode(mode) {
  app.mode = mode;
  app.recentDt = [];
  resetJs8(); // 換模式（通常也換頻率）：進行中的 JS8 訊息作廢
  if (mode === 'JS8') ensureJs8Tables(); // 先在背景載入字表
  app.js8Dropped = 0;
  app.running?.cutter.setCutters(buildCutters(mode, app.running.cutter.buffer, app.running.cutter.cutters));
  syncJttyRx();
  if (app.running) {
    redrawProgress();
    // 狀態列跟著換：不然要等新模式第一次解碼才會更新，期間一直顯示舊模式（Codex 介面測試 2026-10-09）
    setState(t(waitingStateKey(mode), { mode, rate: app.running.ctx.sampleRate }));
  }
  filterDecodesByMode();
  cards?.setMode(); // 呼叫清單、電台卡只列新模式（Codex 2026-10-09）
  document.dispatchEvent(new CustomEvent('ft8tw:mode', { detail: mode })); // 版面（JS8 通訊畫面）跟著換
}

$('start').addEventListener('click', () => start());
$('detect').addEventListener('click', async () => {
  // 接收中按「自動偵測」：先停（不算使用者停止），偵測完再開始
  if (app.running) await stop({ byUser: false });
  start({ forceDetect: true });
});
$('stop').addEventListener('click', () => stop());
// 接收中換音訊來源：立即用新裝置重新收音（使用者 2026-10-09：原本要重新載入才會換）
const inputSwitch = createInputSwitcher({ isRunning: () => Boolean(app.running), stop: () => stop({ byUser: false }), start: () => start() });
$('device').addEventListener('change', () => {
  markDeviceChosen(localStorage); // 手動選了（含預設裝置）就不再自動偵測
  syncAdvisor(); // 換音訊輸入：清空時間偏差統計
  inputSwitch.changed().catch((err) => setState(t('page.state.cannot_start', { error: err.message })));
});
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);

// SWL Log 開不起來也不影響解碼（spec）；開好之前解出的不會記到
let swlLog = null;
initSwlLogUi({ indexedDB: globalThis.indexedDB, getMyGrid: () => settingsUi.get().grid, storage: localStorage, storageManager: navigator.storage })
  .then((l) => { swlLog = l; if (dev) app.swlLog = l; })
  .catch((err) => setState(t('page.state.swl_unavailable', { error: err.message })));

if (dev) {
  window.__ft8tw = app;
  app.onDecoded = onDecoded; // tools/ui-modefilter-check.mjs：模擬換模式後才回來的解碼結果
  app.dtAdvisor = dtAdvisor; // tools/ui-dtadvisor-check.mjs
  app.freqTimeline = freqTimeline; // tools/ui-freqlist-check.mjs：時槽中途換頻率
  app.clock = clock;
  app.configUi = configUi;
  // 收訊延遲只用在接收（D14）：同一個 epoch 下發射排程、跑馬條、時鐘顯示的值（tools/ui-dtadvisor-check.mjs 比對延遲前後）
  app.timingAt = (epoch, mode = 'FT8') => ({
    txUtc: txClock(epoch), rxUtc: epoch + clock.rxOffsetMs,
    nextTx: nextTxSlot({ nowUtc: txClock(epoch), mode, parity: 0 }),
    bar: progressBars(txUtcAt(epoch), mode, SLOT_MS[mode], configUi.get().rxAudioDelayMs),
    clockText: clockSummary(clock.state),
  });
  app.probes = [];
  app.probeResults = [];
  app.reporter = reporter;
  app.i18n = { locale, missingKeys }; // 多語系檢查（tools/ui-i18n-check.mjs）
}
// 解碼週期跑馬條：一秒跳一次（同 FT8TW）。每次用校正後的 UTC 重算（與切 slot 同一個時間）、
// 排到下一個整秒或 slot 邊界，不累加所以不漂移；停止接收就不再排下一次（手機省電）
let progressTimer = null;
function startProgress() {
  if (progressTimer === null) drawProgress();
}
// 立刻依現況重畫（切換模式、停止、對齊時間改變、分頁回到前景）
function redrawProgress() {
  clearTimeout(progressTimer);
  drawProgress();
}
// 背景分頁的 setTimeout 會被節流（Chrome 最長一分鐘一次），回到前景時立刻更新
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && app.running) redrawProgress();
  if (jttyRx) jttyDiag.event('visibility', { state: document.visibilityState }); // JTTY 收訊診斷
});
// 橘色跑馬條＝真實時鐘（發射時間，clock.offsetMs）；收訊音訊延遲 ≠ 0 時下面多一條青色＝接收切 slot 的時間（clock.rxOffsetMs，D20）
const txUtcAt = (epoch) => epoch + clock.offsetMs + app.alignShiftMs;
function drawBar(el, tick, label) {
  el.firstElementChild.style.transform = `scaleX(${tick.width})`;
  el.setAttribute('aria-valuenow', String(Math.round(tick.width * 100)));
  el.setAttribute('aria-valuetext', t('page.slot_valuetext', { mode: app.mode, s: tick.second, p: tick.period }));
  el.setAttribute('aria-label', label);
  el.title = label;
}
function drawProgress() {
  progressTimer = null;
  const utc = txUtcAt(epochNow());
  const rxDelay = configUi.get().rxAudioDelayMs;
  const bars = app.running ? progressBars(utc, app.mode, slotMsNow(), rxDelay) : { main: null, rx: null };
  $('slot-progress').hidden = bars.main === null;
  $('rx-slot-progress').hidden = !bars.rx;
  document.body.classList.toggle('rx-delayed', Boolean(bars.rx));
  $('slot-tick').hidden = bars.main === null;
  if (bars.main === null) return;
  drawBar($('slot-progress'), bars.main, bars.rx ? t('dtadvisor.txBar') : t('page.slot_progress'));
  if (bars.rx) drawBar($('rx-slot-progress'), bars.rx, t('dtadvisor.rxBar', { delay: formatOffset(rxDelay) }));
  $('slot-second').textContent = `${bars.main.second}/${bars.main.period}`;
  progressTimer = setTimeout(drawProgress, bars.nextMs + 5); // 多等 5 ms，確定跨過整秒
}

// 發射（add-web-transmit T1）：時間與收訊同一個校正後 UTC；utc → performance 時刻交給 AudioContext 排程
let qsoUi = null; // 通聯區塊在發射區塊之後建立；發射狀態變化時才會用到
const txFloat = initFloat($('tx-banner'), localStorage);
const txUi = initTxUi({
  getSettings: () => settingsUi.get(),
  getJs8Submode: () => js8chat?.prefs().submode ?? 0,
  getJs8ForceUtx: () => Boolean(js8chat?.prefs().forceUtx),
  utcNow: () => txClock(),
  utcToPerf: (utc) => utc - clock.offsetMs - performance.timeOrigin,
  storage: localStorage,
  mediaDevices: navigator.mediaDevices,
  onActiveChange: (active) => {
    qsoUi?.onTxActiveChange(active);
    js8chat?.onTxActiveChange(active); // 排隊的下一則
  },
  onSent: (st) => {
    cards?.onSent(st);
    mapPanel?.noteTx(st.slotStart); // 地圖：我方→對方航線上的光點
    // 我方發射的訊息也列進解碼清單（同 FT8TW MainViewModel 把發射訊息加進解碼列表），靠右顯示
    if (st.text && cards && st.mode !== 'JS8') addRows({ results: [{ text: st.text, snr: 0, freqHz: st.audioHz, timeSec: 0 }], startUtc: st.slotStart, mode: st.mode, own: true });
  },
  onTransmitting: (on) => on && txFloat.place(), // 發射訊息浮動視窗出現時放到記住的位置（預設中央）
  ptt: rigUi.ptt, // CAT／RTS／DTR：PTT 開→延遲→音訊→PTT 關（add-web-rig-control D12）
  getDialHz: (s) => dialInfo(s.band, s.mode).dialHz, // 發射防護（WSPR 子頻段）用電台實際頻率
  onOutputInterrupted: (reason) => jtty?.stopTx(reason), // JTTY 共用同一個輸出
});
// 電台自動設定精靈（add-rig-autosetup）：按住發射套用與測試音相同的發射防護
const rigWizard = initRigWizard({
  rigUi,
  blockReason: () => testToneBlockReason({
    settings: settingsUi.get(), txActive: document.body.classList.contains('tx-armed'), now: Date.now(),
    dialHz: dialInfo(settingsUi.get().band, settingsUi.get().mode).dialHz,
  }),
});
if (dev) {
  app.tx = txUi.controller;
  app.rig = rigUi.rig;
}

js8chat = initJs8Chat({
  storeReady: openJs8Chat({ indexedDB: globalThis.indexedDB }),
  getSettings: () => settingsUi.get(),
  utcNow: () => txClock(),
  isRunning: () => Boolean(app.running),
  tx: txUi,
  storage: localStorage,
  version: WEB_VERSION,
  relay: relayBase(location),
  notify: setState,
  getDialHz: (s) => dialInfo(s.band, 'JS8').dialHz, // iGate 的頻率用電台實際頻率（S 表 review B3）
});
// JTTY 通訊畫面（add-web-jtty D9～D12）：對話另存 ft8tw-jttychat；隨時發射共用發射區塊的輸出、PTT 與防護
jtty = initJttyChat({
  storeReady: openJs8Chat({ indexedDB: globalThis.indexedDB, dbName: JTTY_DB }),
  getSettings: () => settingsUi.get(),
  getDialHz: (s) => dialInfo(s.band, 'JTTY').dialHz,
  utcNow: () => txClock(),
  utcToPerf: (utc) => utc - clock.offsetMs - performance.timeOrigin,
  tx: txUi,
  ptt: rigUi.ptt,
  storage: localStorage,
  notify: setState,
  isRunning: () => Boolean(app.running), // 空對話區雷達的說明
  frameCounter: createFrameCounter({ load: loadJttyCodec }),
});
// JTTY 收訊診斷（控制分頁）：複製的資料附網頁版本
jttyDiagPanel = initJttyDiagPanel({ diag: jttyDiag, t, notify: setState, extra: () => ({ app: WEB_VERSION }) });
syncJs8Dial();
document.addEventListener('ft8tw:mode', syncJs8Dial);
if (dev) {
  app.jttyDiag = jttyDiag;
  app.jttyDiagPanel = jttyDiagPanel;
  app.js8chat = js8chat;
  app.jtty = jtty;
  // 瀏覽器檢查：不經 Worker 直接餵 frame（接收中走接收器；沒在接收時用一個不切窗的接收器，同樣經組合器）
  let devRx = null;
  app.jttyInject = (frames, upToUtc = null) => {
    devRx ??= new JttyReceiver({ buffer: new SampleBuffer(), post: () => {}, nextWorkerId: () => 0, onMessage: onJttyMessage, onFrames: onJttyFrames, utxReady: jttyUtxReady, diag: jttyDiag, loadCodec: loadJttyCodec });
    (jttyRx ?? devRx).inject(frames, upToUtc);
  };
}

// 頻譜／瀑布圖（add-web-transmit D21）：點一下設定發射聲音頻率（寫入 #tx-freq，沿用上面的保存）
const spectrum = initSpectrumPanel({ storage: localStorage, getMyCall: () => settingsUi.get().callsign });
if (dev) {
  app.spectrum = spectrum?.waterfall;
  if (params.get('spectrum') === '0') $('spectrum-panel').hidden = true; // 效能比較：關閉頻譜時的解碼耗時
}
// JTTY 字幕區（使用者 2026-10-09）：瀑布圖下方每台一條跑馬燈，取代瀑布圖上隨瀑布下捲的 JTTY 標籤；setModeClasses 啟用／停用
jttyTicker = initJttyTicker({ waterfall: spectrum?.waterfall });
if (dev) app.jttyTicker = jttyTicker;
// 組合器的訊息更新：通訊畫面泡泡＋字幕區（函式宣告會提升，上面的接收器先用到）
function onJttyMessage(snap) {
  jttyDiag.message(snap);
  jtty?.onRx(snap);
  jttyTicker?.onMessage(snap);
}

// 通聯（add-web-transmit T2）：QSO 記錄另存 IndexedDB；解碼列雙擊／長按呼叫
const qsoLogReady = openQsoLog({ indexedDB: globalThis.indexedDB });
const rowCall = initRowCall($('decodes'), { getData: (tr) => rowData.get(tr), onCall: (row) => qsoUi.callRow(row) });
qsoUi = initQsoUi({
  tx: txUi,
  getSettings: () => settingsUi.get(),
  utcNow: () => txClock(),
  qsoLog: { add: async (q) => { const r = await (await qsoLogReady).add(q); refreshQsoList(); cards?.refreshWorked(); return r; } }, // 寫入後刷新「已通聯」
  getSelectedRow: () => rowCall.selected(),
  readPrefs: () => configUi.get(),
  savePrefs: (patch) => configUi.update(patch), // 經設置頁同步（直接寫 storage 會被舊值蓋掉）
  getDialHz: (s) => dialInfo(s.band, s.mode).dialHz, // 通聯紀錄記電台實際頻率（使用者 2026-10-09）；不在業餘波段時退回標準頻率
  getDecodeMs: () => app.decodeMs, // 收訊延遲警告（D18）：等待時間要扣掉解碼時間
});
cards = initCards({
  decodes: $('decodes'), getRowData: (tr) => rowData.get(tr), getSettings: () => settingsUi.get(), getConfig: () => configUi.get(),
  getTarget: () => qsoUi.session()?.target?.call ?? null, callRow: (row) => qsoUi.callRow(row), qsoLog: qsoLogReady,
  storage: localStorage, utcNow: () => txClock(),
  getDialHz: (s) => dialInfo(s.band, s.mode).dialHz, // 卡片頻率與摘要列一致
  getMode: () => app.mode,
  onDecodeFilter: () => filterDecodesByMode(), // 解碼清單的篩選改變或隨時間過期
  isRunning: () => Boolean(app.running), // 空清單雷達：「按開始接收」或「等待訊號中」
});
// 右鍵（手機長按）選單（使用者 2026-10-06，同 FT8TW 長按選單）：解碼清單、呼叫清單、電台卡
initContextMenu({
  roots: [$('decodes'), $('call-list'), $('station-view')],
  resolve: (target) => {
    const tr = target?.closest?.('tr');
    if (tr && $('decodes').contains(tr)) return rowData.get(tr) ?? null;
    return cards.rowFor(target);
  },
  items: (row) => menuItems(row.text, {
    myCall: settingsUi.get().callsign,
    where: (call) => cards.countryOf(call), // 依目前語系的國名
    syncFrequency: Boolean(configUi.get().synFrequency),
  }),
  onAction: (item, row) => {
    const mode = row.mode ?? settingsUi.get().mode;
    switch (item.id) {
      case 'callFrom':
        qsoUi.callRow(row); // 叫我的訊息會接著回下一步（forReplyTo）
        break;
      case 'callTo':
        // 呼叫接收方（FT8TW case 1）：接收方在發送方的下一個 slot（相反時序）發射；從第 1 步（網格）開始叫
        qsoUi.callRow({ text: `CQ ${item.call}`, snr: row.snr, freqHz: row.freqHz, startUtc: row.startUtc + SLOT_MS[mode], mode });
        break;
      case 'followTo':
      case 'followFrom': {
        const cur = configUi.get().followCallsigns ?? [];
        if (!cur.includes(item.call)) configUi.update({ followCallsigns: [...cur, item.call] });
        setState(t('page.state.follow_added', { call: item.call }));
        break;
      }
      case 'qrzTo':
      case 'qrzFrom':
        window.open(`https://www.qrz.com/db/${encodeURIComponent(item.call)}`, '_blank', 'noopener');
        break;
      case 'logTo':
      case 'logFrom':
        qsoFilter = item.call;
        listTabs.select('log');
        bottomTabs.select('log');
        refreshQsoList().catch(() => {});
        break;
      default:
    }
  },
});

// 狀態列（同 FT8TW 頁首）：週期 發射/目前、UTC 每秒更新；最右邊發射／停止鍵
function drawStatusStrip() {
  const utc = epochNow() + clock.offsetMs;
  const tx = txUi.controller;
  const line = statusLine(utc, settingsUi.get().mode, tx.active ? tx.getParams().parity : null, slotMsNow(settingsUi.get().mode));
  const active = tx.active || Boolean(jtty?.busy()); // JTTY 隨時發射
  $('strip-cycle').textContent = line.cycle;
  $('strip-utc').textContent = line.utc;
  $('strip-tx').setAttribute('aria-pressed', String(active));
  $('strip-tx-icon').textContent = active ? '🔊' : '🔇';
  $('strip-tx-label').textContent = active ? t('common.stop') : t('page.strip.tx');
  phone?.update(line); // 手機每頁工具列
  setTimeout(drawStatusStrip, 1000 - (utc % 1000) + 5);
}
drawStatusStrip();
$('strip-tx').addEventListener('click', () => {
  if (txUi.controller.active) return txUi.controller.stop();
  if (jtty?.busy()) return jtty.controller.stop();
  // 沒在發射：FT8／FT4／FT2 走通聯流程呼叫 CQ；JS8 送發射區塊的訊息；JTTY 送通訊畫面輸入框的訊息
  if (settingsUi.get().mode === 'JTTY') return jtty?.sendInput();
  if (settingsUi.get().mode === 'JS8') $('tx-start').click();
  else $('qso-cq').click();
});
// 通聯記錄分頁（簡易清單）與手機底部分頁
let qsoFilter = null; // 右鍵「查日誌」：只顯示這個呼號
// 這個清單是簡易版（完整記錄頁規劃在 T5，見 js/qso/logview.mjs 開頭註解，尚未做），一次把
// 全部記錄變成 DOM 節點會在筆數大時（例如匯入整個歷史 log）讓分頁沒有回應，所以只顯示最近
// QSO_LIST_CAP 筆；完整資料仍然都在 IndexedDB 裡，匯入／筆數統計都是看全部，只有畫面顯示受限。
const QSO_LIST_CAP = 20;
async function refreshQsoList() {
  const all = await (await qsoLogReady).list();
  const list = qsoFilter ? all.filter((q) => q.call === qsoFilter) : all;
  $('qso-filter-clear').hidden = !qsoFilter;
  renderQsoList($('qso-list'), list.slice(0, QSO_LIST_CAP));
  $('qso-count').textContent = !list.length ? ''
    : list.length > QSO_LIST_CAP ? t('page.log.count_capped', { n: QSO_LIST_CAP, total: list.length })
    : qsoFilter ? t('page.log.count_filtered', { call: qsoFilter, n: list.length })
    : t('page.log.count', { n: list.length });
  $('qso-empty').hidden = list.length > 0;
}
refreshQsoList().catch(() => {});
// ADIF 匯入（通聯記錄分頁）：讀 Android FT8TW／QRZ 等 logger 匯出的 .adi，批次寫進同一個 IndexedDB
$('qso-import').addEventListener('click', () => $('qso-import-file').click());
$('qso-import-file').addEventListener('change', async () => {
  const [file] = $('qso-import-file').files;
  $('qso-import-file').value = ''; // 清掉選取，讓使用者可以重選同一個檔案
  if (!file) return;
  $('qso-import-msg').textContent = t('page.log.importing');
  try {
    const text = await file.text();
    const log = await qsoLogReady;
    // 每 20 筆才更新一次畫面：單筆更新 DOM 對幾千筆的匯入沒必要，但要頻繁到使用者看得出「還在動」
    const { total, added, duplicate, invalid } = await importAdif(text, log, (done, writing) => {
      if (done % 20 === 0 || done === writing) $('qso-import-msg').textContent = t('page.log.importing_progress', { done, total: writing });
    });
    refreshQsoList();
    cards?.refreshWorked();
    $('qso-import-msg').textContent = t('page.log.import_done', { total, added, duplicate, invalid });
  } catch (err) {
    $('qso-import-msg').textContent = t('page.log.import_failed', { error: err.message });
  }
});
// 隱藏已通聯過的站台（使用者 2026-10-19，Control 分頁）：解碼清單直接拿掉那些列，不是只加刪除線
$('cfg-hide-worked-decodes').checked = Boolean(configUi.get().hideWorkedDecodes);
$('cfg-hide-worked-decodes').addEventListener('change', () => {
  configUi.update({ hideWorkedDecodes: $('cfg-hide-worked-decodes').checked });
  filterDecodesByMode();
});
// JS8 模式（add-web-js8-chat D1）：右欄／手機整頁換成 JS8 通訊畫面，分頁各記各的，離開 JS8 還原
const initialMode = settingsUi.get().mode;
// 狀態列的模式下拉：切換＝點設置頁的模式選項（同一條路徑：存設定、換切窗、版面、停發射）
$('mode-select').value = initialMode;
$('mode-select').addEventListener('change', () => {
  const radio = document.querySelector(`input[name=mode][value="${$('mode-select').value}"]`);
  if (!radio) return;
  radio.checked = true;
  radio.dispatchEvent(new Event('change'));
});
// 聊天模式的版面：mode-js8／mode-jtty 各自的通訊畫面，mode-chat 是兩者共用的規則（add-web-jtty D10）
function setModeClasses(mode) {
  document.body.classList.toggle('mode-js8', mode === 'JS8');
  document.body.classList.toggle('mode-jtty', mode === 'JTTY');
  document.body.classList.toggle('mode-chat', mode === 'JS8' || mode === 'JTTY');
  spectrum?.waterfall.setChannel(mode === 'JTTY' ? JTTY_CHANNEL_HZ : null); // 瀑布圖 JTTY 通道標示（D12）
  jttyTicker?.setActive(mode === 'JTTY'); // JTTY 字幕區
  syncTxFreqRange(mode);
}
// 發射頻率上限依模式（Wave E）：JTTY 通道 127 Hz 往上佔，上限 2873 Hz；離開 JTTY 恢復 3000。
// 輸入框的 max 也是瀑布圖點選的上限（spectrum/panel.mjs 依 max 夾值）；目前的值超過就夾回並觸發 change（存檔、畫三角形）
function syncTxFreqRange(mode) {
  const input = $('tx-freq');
  input.max = String(txAudioMaxHz(mode));
  const v = clampTxAudioHz(input.value, mode);
  if (v !== null && String(v) !== input.value) {
    input.value = String(v);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}
// 直接輸入超出範圍的值：夾回該模式的範圍（瀑布圖點選已在 panel.mjs 夾過）
$('tx-freq').addEventListener('change', () => syncTxFreqRange(settingsUi.get().mode));
setModeClasses(initialMode);
bottomTabs = initTabs({ nav: $('tabbar'), storage: localStorage, mode: initialMode, onChange: (id) => {
  phone?.onTab(id, bottomTabs?.mode());
  if (id === 'log') refreshQsoList().catch(() => {});
} });
// 手機版面比照 S20 App（web-phone-app-layout）：工具列、浮動按鈕、地圖全頁、設置分頁
phone = initPhoneUi({
  tabs: () => bottomTabs,
  getState: () => {
    const s = settingsUi.get();
    const q = qsoUi.session();
    return { mode: s.mode, grid: s.grid, recentDt: app.recentDt, decodeMs: app.decodeMs, lastSlotRows: app.lastSlotRows,
      running: Boolean(app.running), txActive: txUi.controller.active, target: q?.active ? q.target?.call : null, audioHz: $('tx-freq')?.value };
  },
  setMode: (mode) => { // 同狀態列的模式下拉
    $('mode-select').value = mode;
    $('mode-select').dispatchEvent(new Event('change'));
  },
});
phone.onTab(bottomTabs.current(), bottomTabs.mode());
const listTabs = initListTabs({ container: $('list-tabs'), storage: localStorage, mode: initialMode, onChange: (id) => { if (id === 'log') refreshQsoList().catch(() => {}); } });
document.addEventListener('ft8tw:mode', (e) => {
  setModeClasses(e.detail);
  bottomTabs.setMode(e.detail);
  listTabs.setMode(e.detail);
});
$('qso-filter-clear').addEventListener('click', () => {
  qsoFilter = null;
  refreshQsoList().catch(() => {});
});

// 解碼清單的刪除鍵（同 FT8TW 解碼頁左上角）：清掉畫面上的清單，不影響 SWL Log 與回報
$('decodes-clear').addEventListener('click', clearDecodes);

$('call-list-clear').addEventListener('click', () => cards?.clearCallList());

// 地圖（web/js/map/）：每個 FT8／FT4／FT2 slot 的電台、我的網格、目前通聯對象；點標點＝在解碼清單選取該台最新一則
// 電台卡下方的通聯進度 Dashboard（使用者 2026-10-07，參考 S20）：通聯區塊更新目標／順序時跟著更新
const qsoDash = initQsoDashboard({
  getState: () => {
    const q = qsoUi.session();
    return { target: q?.target?.call ?? null, order: q?.order ?? null, active: Boolean(q?.active) };
  },
});
new MutationObserver(() => qsoDash.update()).observe($('qso-target'), { childList: true, characterData: true, subtree: true });
new MutationObserver(() => qsoDash.update()).observe($('qso-order'), { childList: true, attributes: true, subtree: true });
setInterval(() => qsoDash.update(), 1000); // 發射開關等沒有改到 DOM 的變化

try {
  mapPanel = initMapPanel({
    now: () => epochNow() + clock.offsetMs,
    getMyCall: () => settingsUi.get().callsign,
    approxLocate: (call) => cards?.lookup(call) ?? null, // 沒網格的電台用國家中心點（概略，畫虛線）
    slotMs: () => slotMsNow(settingsUi.get().mode) ?? SLOT_MS.FT8,
    storage: localStorage,
    locale,
    t,
    tileSource: resolveTileSource(configUi.get()), // 線上地圖來源（設置 › 顯示與佈景，add-map-tile-source）
    onPick: (call) => {
      const tr = [...$('decodes').rows].find((row) => parseMessage(rowData.get(row)?.text ?? '')?.sender === call);
      if (!tr) return;
      tr.click(); // 選取（呼叫區塊的「呼叫選取的電台」即可呼叫）
      tr.scrollIntoView({ block: 'nearest' });
    },
  });
  mapPanel.setMe(settingsUi.get().grid);
  // 清單左鍵選取的電台在地圖上特別顯眼（add-map-overlays E）：解碼清單、呼叫清單、電台卡
  for (const root of [$('decodes'), $('call-list'), $('station-view')]) {
    root?.addEventListener('click', (e) => mapPanel.selectRow(root.id === 'decodes' ? rowData.get(e.target.closest?.('tr')) : cards?.rowFor(e.target)));
  }
  // 地圖只畫右邊目前所選清單（解碼／呼叫／電台卡）裡的電台（使用者 2026-10-07）；其他分頁時用解碼清單。每秒對一次
  const mapRows = () => {
    const tab = document.querySelector('#list-tabs [aria-selected="true"]')?.dataset.tab ?? 'decode';
    if (tab === 'call') return [...$('call-list').rows].map((tr) => cards?.rowFor(tr));
    if (tab === 'station') return [...document.querySelectorAll('#station-view .st-card')].map((c) => cards?.rowFor(c));
    return [...$('decodes').rows].filter((tr) => !tr.hidden).map((tr) => rowData.get(tr)); // 只畫目前模式的列（其他模式的列藏著）
  };
  setInterval(() => {
    if (document.hidden || !$('map-canvas').parentElement.clientWidth) return; // 背景分頁、手機其他分頁（地圖 0×0）時不算；3D 時 2D canvas 隱藏，看外框
    // JS8 模式：只畫目前對話紀錄裡的 JS8 電台（使用者 2026-10-07），不混入先前的 FT8 解碼
    if (settingsUi.get().mode === 'JS8' && js8chat) mapPanel.setJs8(js8chat.visible());
    else mapPanel.setRows(mapRows());
  }, 1000);
  // 目前對象：通聯區塊更新「目標」欄位時跟著更新
  const syncTarget = () => {
    const s = qsoUi.session();
    mapPanel.setTarget(s?.active && s.target && s.target.call !== 'CQ' ? s.target.call : null);
  };
  new MutationObserver(syncTarget).observe($('qso-target'), { childList: true, characterData: true, subtree: true });
  syncTarget();
} catch (err) {
  setState(t('page.state.map_unavailable', { error: err.message })); // 地圖壞掉不影響解碼
}

if (dev) {
  app.cards = cards;
  app.map = mapPanel;
  app.qso = qsoUi;
  app.qsoLog = qsoLogReady;
}

// 左欄頻譜／地圖：拖曳分隔線調整高度、收折（使用者 2026-10-07）；左右欄之間的直分隔線調整寬度（使用者 2026-10-10）
initSideLayout({
  storage: localStorage, side: document.querySelector('.side'), spectrum: $('spectrum-panel'), map: $('map-panel'),
  splitter: $('side-split'), spectrumToggle: $('spectrum-toggle'), mapToggle: $('map-toggle'),
  main: document.querySelector('main.layout'), colSplitter: $('col-split'),
});

// 放回暫存的解碼（切換語言、重新整理前的內容）：只重建畫面，不重送回報、不重寫 SWL Log、不觸發通聯流程
for (const s of feedCache.restore()) {
  if (s.full) {
    cards?.onDecoded(s);
    mapPanel?.onSlot(s);
  }
  addRows(s, { replay: true });
  app.lastSlotRows = s.results.length;
}

// 可以重新載入的時機（強制更新、別的分頁切換設定組共用，review S1）：沒有發射（含排隊、準備中、JS8 排隊的下一則、測試音、精靈按住發射）、
// 沒有通聯、PTT 沒開也沒卡住、不在切換設定組
function safeToReload() {
  try {
    if (txUi.controller.active || $('tx-start').disabled || js8chat?.hasQueued() || jtty?.busy()) return false;
    if ($('cfg-test-tone').disabled || rigWizard?.holding()) return false;
    if (qsoUi.session()?.active) return false;
    if (rigUi.rig.pttOnNow || rigUi.rig.pttStuck || rigUi.rig.readStuck()) return false;
    return !configUi.profileBusy();
  } catch {
    return false; // 還在初始化
  }
}
const RESUME_RX_KEY = 'ft8tw.update.resumeRx'; // 強制更新前正在接收：重新載入後接著接收（review S6）
const forcedReload = () => {
  try { if (app.running) sessionStorage.setItem(RESUME_RX_KEY, '1'); } catch { /* 無痕 */ }
  location.reload();
};
// 新版提示與最低版本強制更新（add-version-tracking）
updater = createUpdater({
  currentBuild: BUILD_NUMBER,
  url: new URL('version.json', location.href).href, // 同網域的靜態檔（部署時產生）
  isSafe: safeToReload,
  reload: forcedReload,
  render: initUpdateBanner({ el: $('update-banner'), t, reload: () => location.reload(), isSafe: safeToReload, isStuck: () => Boolean(rigUi.rig.pttStuck || rigUi.rig.readStuck()) }),
  storage: (() => { try { return sessionStorage; } catch { return null; } })(),
});
updater.start();
updater.setMinBuild(relayMinBuild);
if (dev) app.updater = updater;

// 時間偏差提醒（add-dt-offset-advisor）：套用＝經設定介面改收訊音訊延遲（下一段音訊就改標已收的樣本，不必重新開始接收；不動發射時間）；忽略＝30 分鐘不提醒
{
  const mainEl = document.querySelector('main'); // 套用／忽略後橫幅隱藏：焦點移到主內容（tabindex=-1）
  const renderDt = initDtBanner({
    el: $('dt-banner'), text: $('dt-banner-text'), apply: $('dt-apply'), ignore: $('dt-ignore'), focusTarget: mainEl,
    onApply: (advice) => configUi.update({ rxAudioDelayMs: advice.suggestedMs }), // onChange → 時鐘的收訊延遲、清空統計（不動發射時間）
    onIgnore: () => {
      dtAdvisor.snooze(epochNow() + clock.offsetMs);
      drawDt();
    },
  });
  // 時鐘從未校準或伺服器未同步：不建議收訊延遲，改提示先確認時鐘（D17）
  drawDt = () => renderDt(dtAdvisor.evaluate({
    currentDelayMs: configUi.get().rxAudioDelayMs, now: epochNow() + clock.offsetMs,
    clockSynced: clock.state.everSynced && clock.state.serverSynced !== false,
  }), { locked: configUi.locked() });
  // 「取消偏差調整」（D21）：桌機在時槽秒數旁、手機在頂列上方的細列；確認後收訊延遲歸 0（隨目前設定組）、統計清空
  const renderCancel = initRxDelayCancel({
    roots: ['rxdelay', 'p-rxdelay'].map((p) => ({ ctl: $(`${p}-ctl`), button: $(`${p}-cancel`), confirm: $(`${p}-confirm`),
      msg: $(`${p}-confirm-msg`), yes: $(`${p}-yes`), no: $(`${p}-no`), label: $(`${p}-label`) })),
    onConfirm: () => configUi.update({ rxAudioDelayMs: 0 }),
    focusTarget: mainEl,
  });
  drawRxDelay = () => {
    renderCancel(configUi.get().rxAudioDelayMs, { locked: configUi.locked() });
    if (app.running) redrawProgress(); // 青色跑馬條出現／消失
  };
  dtReady = true;
  syncAdvisor();
  drawRxDelay();
}

render();
hideSplash(); // 開場動畫（使用者 2026-10-09）：初始化完成，補滿能量條後淡出
refreshDevices().catch(() => {});
txUi.refreshDevices().catch(() => {});
clock.start();
// 開啟網頁自動開始接收（D17）
const autoStart = loadAutoStart(localStorage);
$('autostart').checked = autoStart.enabled;
$('autostart').addEventListener('change', () => saveAutoStart(localStorage, { enabled: $('autostart').checked }));
// 免責宣告（使用者 2026-10-08）：同意之前不自動開始接收（對話框蓋住全頁，其他操作也點不到）
requireDisclaimer({ storage: localStorage, dialog: $('disclaimer'), button: $('disclaimer-agree') }).then(() => {
  let resume = false;
  try {
    resume = sessionStorage.getItem(RESUME_RX_KEY) === '1';
    sessionStorage.removeItem(RESUME_RX_KEY);
  } catch { /* 無痕 */ }
  if (resume || shouldAutoStart(autoStart) || (dev && params.has('autostart'))) start();
});
