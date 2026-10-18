// JTTY 通訊畫面的接線（add-web-jtty jtty-chat、design D9～D12）：收到的訊息 → 泡泡、巨集按鈕 1～8／輸入框 → 隨時發射。
// 規則都在純函式模組（fkeys／text5／chatmodel／sendqueue／supervisor／keys），這裡只負責 DOM 與把各部分接起來；
// 以真瀏覽器檢查（tools/ui-jtty-check.mjs）驗證。泡泡與儲存重用 js8chat 的 store／chatview／model。
import { t } from '../i18n/index.mjs';
import { createChatView } from '../js8chat/chatview.mjs';
import { MAX_MESSAGES } from '../js8chat/store.mjs';
import { planSend, loadMacros, saveMacros, resetDefaults, callFromMessage, adjustSerial, clampSerial, SERIAL_MIN, SERIAL_MAX, DEFAULT_MACROS } from './fkeys.mjs';
import { normalize, unsupportedChars } from './text5.mjs';
import { JttyTxController } from './tx.mjs';
import { JttySupervisor, createJttyGuard } from './supervisor.mjs';
import { createFrameCounter } from './framecount.mjs';
import { JttySendQueue, isTerminal } from './sendqueue.mjs';
import { jttyKeyAction } from './keys.mjs';
import { loadFields, saveFields, normalizeCall, rxRecord, txRecord, finishTx, sendButtonKey, loadConversation, createWarnState, txErrorText, loadJttyPrefs, saveJttyPrefs, clampRestFrames } from './chatmodel.mjs';
import { FRAME_SEC } from './txplan.mjs';
import { charCount } from './split.mjs';
import { normalizeFecSetting } from './fec.mjs';
import { SenderMemory, resolveSender } from './sender.mjs';
import { jttyStations, filterJttyStation, stationLabel, isFreqKey } from './stations.mjs';
import { loadConfig, supervisionMs } from '../config/model.mjs';
import { formatUtc } from '../format.mjs';
import { fullText } from '../js8chat/model.mjs';

/**
 * storeReady：openJs8Chat({ dbName: 'ft8tw-jttychat' }) 的 Promise；getSettings()：{ callsign, ... }；getDialHz(settings)：撥號頻率；
 * utcNow()：校正後 UTC；utcToPerf(utc)：performance 時刻；tx：initTxUi 的回傳（encode、output、ensureOutput）；
 * ptt：電台控制的 PTT 介面（null＝VOX）；notify(text)：主畫面狀態列
 */
// isRunning()：接收中（空對話區雷達的說明）
export function initJttyChat({ storeReady, getSettings, getDialHz, utcNow, utcToPerf, tx, ptt = null, storage, notify = () => {}, frameCounter = createFrameCounter(),
  isRunning = () => false }) {
  const $ = (id) => document.getElementById(id);
  const input = $('jtty-text');
  const sendBtn = $('jtty-send');
  const warnEl = $('jtty-warn');
  const warnState = createWarnState((text) => { warnEl.textContent = text; });
  let macros = loadMacros(storage);
  const fields = loadFields(storage);
  const prefs = loadJttyPrefs(storage); // 強化編碼、附帶我的呼號、選台（add-jtty-utx）
  const savePrefs = () => saveJttyPrefs(storage, prefs);
  const senders = new SenderMemory(); // 發話者的頻率記憶（U9）
  let store = null;
  let saved = []; // 已定稿（store.list，最多 500）
  const live = new Map(); // 接收中的泡泡 id → 紀錄
  const queue = new JttySendQueue();
  const supervisor = new JttySupervisor();
  let seq = 0;
  let encodeOverride = null; // 本機開發掛鉤（瀏覽器檢查注入假編碼）
  let outputOverride = null; // 本機開發掛鉤（假輸出）

  let resting = null; // 分則休息中（U12）：{ id（等著發的那則泡泡）, untilUtc, part, sec }
  // 分則的泡泡標「i/n」；休息中那則標「休息中，x 秒後送第 i/n 則」
  const partLabel = (m) => {
    if (!m.part) return '';
    if (resting && m.id === resting.id) return t('jtty.resting', { sec: resting.sec, i: m.part.i, n: m.part.n });
    return t('jtty.part', { i: m.part.i, n: m.part.n });
  };
  const timeOpts = () => ({ local: false, abortedLabel: t('jtty.aborted'), cancelledLabel: t('jtty.cancelled'), utxLabel: t('jtty.utx_label'), showTo: true, partLabel,
    repairedLabel: (n) => t('jtty.repaired', { n }) });
  const view = createChatView({
    list: $('jtty-list'),
    timeOpts,
    // 右鍵（手機長按）：複製內容、複製完整內容、刪除（同 JS8 通訊畫面；接收中、發射佇列中的不給刪除）
    menuItems: (m) => [
      { label: t('jtty.copy'), run: () => copy(m.text ?? '') },
      { label: t('jtty.copy_full'), run: () => copy(fullText(m, timeOpts())) },
      ...(saved.some((x) => x.id === m.id) ? [{ label: t('jtty.delete'), run: () => removeMessage(m) }] : []),
    ],
    onMenu: (item, m) => item.run(m),
    emptyInfo: () => ({ running: isRunning(), station: prefs.station }),
  });
  // 刪除一則（使用者 2026-10-09：JTTY 點選訊息少了刪除）
  async function removeMessage(m) {
    if (!store || !window.confirm(t('jtty.delete_confirm'))) return;
    await store.remove(m.id);
    saved = saved.filter((x) => x.id !== m.id);
    refresh();
  }
  // 刪除所有 JTTY 訊息（使用者 2026-10-09：控制分頁加一個刪除全部；JS8 的對話不受影響）
  $('jtty-clear-all').addEventListener('click', async () => {
    if (!store || !window.confirm(t('jtty.clear_all_confirm'))) return;
    await store.clearAll();
    saved = [];
    live.clear(); // 接收中的泡泡也清掉（之後收到後續 frame 會重新出現）；發射佇列中的不動
    prefs.station = null;
    savePrefs();
    refresh();
    notify(t('jtty.cleared'));
  });
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      notify(t('jtty.copied'));
    } catch {
      notify(t('jtty.copy_failed'));
    }
  }

  // ── 輸入列上方三欄：對方、排隊、序號 ──
  const hisEl = $('jtty-his');
  const queuedEl = $('jtty-queued');
  const serialEl = $('jtty-serial');
  serialEl.min = String(SERIAL_MIN);
  serialEl.max = String(SERIAL_MAX);
  function showFields() {
    hisEl.value = fields.his;
    queuedEl.value = fields.queued;
    serialEl.value = String(fields.serial);
    refreshFkeys();
  }
  function saveAll() {
    saveFields(storage, fields);
    refreshFkeys();
  }
  for (const [el, key] of [[hisEl, 'his'], [queuedEl, 'queued']]) {
    el.addEventListener('input', () => {
      fields[key] = normalizeCall(el.value);
      saveAll();
    });
    el.addEventListener('change', () => { el.value = fields[key]; });
  }
  serialEl.addEventListener('change', () => {
    fields.serial = clampSerial(serialEl.value);
    serialEl.value = String(fields.serial);
    saveAll();
  });
  function setSerial(n) {
    fields.serial = clampSerial(n);
    serialEl.value = String(fields.serial);
    saveAll();
  }
  $('jtty-serial-dec').addEventListener('click', () => setSerial(adjustSerial(fields.serial, -1)));
  $('jtty-serial-inc').addEventListener('click', () => setSerial(adjustSerial(fields.serial, 1)));

  // ── 對話 ──
  function allMessages() {
    return [...saved, ...live.values(), ...queue.entries.map((e) => e.rec)].sort((a, b) => a.utc - b.utc);
  }
  // ── 電台篩選（U11，同 JS8 D12）：全部電台＋收過的各台；選台只顯示該台相關的訊息，呼號帶入對方欄 ──
  const stationSel = $('jtty-station');
  let stationSig = ''; // 選項沒變就不重建（手機展開下拉時重建會把它關掉）
  function refreshStations(all) {
    // 對話紀錄載入後，選的台已沒有任何訊息（被清掉）就回全部
    if (store && prefs.station && filterJttyStation(all, prefs.station).length === 0) {
      prefs.station = null;
      savePrefs();
    }
    const list = jttyStations(all, { myCall: getSettings().callsign });
    const opts = [new Option(t('jtty.station_all'), ''), ...list.map((s) => new Option(stationLabel(s, { meLabel: t('jtty.station_me') }), s.key))];
    if (prefs.station && !list.some((s) => s.key === prefs.station)) opts.push(new Option(prefs.station, prefs.station));
    const sig = opts.map((o) => `${o.value}|${o.textContent}`).join('\n');
    if (sig !== stationSig) {
      stationSig = sig;
      stationSel.replaceChildren(...opts);
    }
    stationSel.value = prefs.station ?? '';
  }
  stationSel.addEventListener('change', () => {
    prefs.station = stationSel.value || null;
    savePrefs();
    if (prefs.station && !isFreqKey(prefs.station)) {
      fields.his = normalizeCall(prefs.station);
      showFields();
      saveFields(storage, fields);
    }
    refresh();
  });

  function refresh() {
    const all = allMessages();
    refreshStations(all);
    view.render(filterJttyStation(all, prefs.station).slice(-MAX_MESSAGES), Date.now());
  }
  function appendSaved(rec) {
    // 糾錯修復（add-jtty-fec）：同一則（同 id）已定稿過（先以「…」結束、校驗 frame 到了才補齊）就原地取代
    const at = saved.findIndex((x) => x.id === rec.id);
    if (at >= 0) {
      saved[at] = rec;
      store?.update(rec.id, rec).then((ok) => (ok ? null : store.add(rec))).catch((err) => notify(t('jtty.store_failed', { error: err.message })));
      return;
    }
    saved.push(rec);
    saved.sort((a, b) => a.utc - b.utc);
    if (saved.length > MAX_MESSAGES) saved = saved.slice(-MAX_MESSAGES);
    store?.add(rec).catch((err) => notify(t('jtty.store_failed', { error: err.message })));
  }
  storeReady.then(async (s) => {
    store = s;
    saved = await loadConversation(s, { storage }); // 保留期限沿用 SWL Log 的設定（比照 JS8）：開啟時清一次
    refresh();
  }).catch((err) => notify(t('jtty.store_failed', { error: err.message })));
  setInterval(() => {
    view.tick(Date.now()); // 接收中、發射中泡泡的跑點
    tickResting();
  }, 400);

  // 點收到的訊息：第一個不是我的呼號的合法呼號填入對方呼號欄
  $('jtty-list').addEventListener('click', (e) => {
    const li = e.target.closest?.('.js8c-msg.rx');
    if (!li) return;
    const m = view.messages().find((x) => String(x.id) === li.dataset.id);
    const me = normalizeCall(getSettings().callsign);
    // 知道發話者（發話者 frame 或內容辨識）就用它，否則取內容裡第一個不是我的呼號
    const c = m && (m.from && m.from !== me ? m.from : callFromMessage(m.text, me));
    if (!c) return;
    fields.his = c;
    showFields();
    saveFields(storage, fields);
    warn('');
    notify(t('jtty.his_set', { call: c }));
  });

  // ── 發射 ──
  const audioHz = () => Number($('tx-freq').value);
  $('tx-freq').addEventListener('change', () => warnState.refresh()); // 頻率改回範圍內：提示即時清掉
  const output = {
    play: (samples, opts) => (outputOverride ?? tx.output).play(samples, opts),
    stop: () => (outputOverride ?? tx.output).stop(),
  };
  const guard = createJttyGuard({
    getParams: () => {
      const s = getSettings();
      return { callsign: s.callsign, dialHz: getDialHz(s), audioHz: audioHz(), supervisionMs: supervisionMs(loadConfig(storage).config) };
    },
    supervisor, ptt, notConnectedText: t('rig.notConnectedTx'),
  });
  const ctl = new JttyTxController({
    // frames：原始酬載序列（發話者 frame、強化編碼，add-jtty-utx）；沒有時照文字打包（編碼器在主執行緒載不起來的退路）
    encode: (text, frames) => {
      if (encodeOverride) return encodeOverride(text, audioHz(), frames);
      return frames ? tx.encode({ jttyFrames: frames }, { mode: 'JTTY', freqHz: audioHz() }) : tx.encode(text, { mode: 'JTTY', freqHz: audioHz() });
    },
    output, ptt, guard, now: utcNow, utcToPerf,
    onState: (state, detail) => onTxState(state, detail),
  });

  // recheck()：條件解除就回 null（呼號改了、欄位填了、頻率改了時即時清掉提示，不必等下一次送出）
  function warn(text, recheck = null) {
    warnState.set(text, recheck);
  }
  const reasonText = (r) => ({ queueFull: t('jtty.queue_full'), empty: t('jtty.err.empty') }[r] ?? r);

  // 分則還沒開始發就被停止（休息中、排在後面）的那幾則標「已取消」；其餘照舊（已中斷）
  const outcomeOf = (entry, outcome) => (entry.part && !entry.started && (outcome === 'aborted' || outcome === 'dropped') ? 'cancelled' : outcome);
  // 休息倒數：每秒更新狀態列與休息中那則泡泡
  function tickResting() {
    if (!resting) return;
    const sec = Math.max(0, Math.ceil((resting.untilUtc - utcNow()) / 1000));
    if (sec === resting.sec) return;
    resting.sec = sec;
    notify(t('jtty.resting', { sec, i: resting.part.i, n: resting.part.n }));
    refresh();
  }

  function onTxState(state, detail) {
    supervisor.note(state, utcNow());
    document.body.classList.toggle('tx-armed', ctl.busy);
    if (state === 'transmitting') document.body.classList.add('tx-on');
    else if (isTerminal(state) || state === 'resting') document.body.classList.remove('tx-on'); // queued（發射中排下一則）不動
    if (state !== 'queued') resting = null;
    if (state === 'transmitting') {
      const head = queue.head();
      const startUtc = detail.startUtc ?? head?.rec.utc;
      if (head) {
        head.started = true;
        head.rec = { ...head.rec, utc: startUtc };
        // 後面排著的（分則的下一則等）時間推到這則之後，泡泡順序才不會倒過來
        let prev = startUtc;
        for (const e of queue.entries.slice(1)) {
          if (e.rec.utc <= prev) e.rec = { ...e.rec, utc: prev + 1 };
          prev = e.rec.utc;
        }
      }
      const time = formatUtc(detail.startUtc ?? utcNow());
      notify(detail.part ? t('jtty.transmitting_part', { text: detail.text, time, i: detail.part.i, n: detail.part.n }) : t('jtty.transmitting', { text: detail.text, time }));
    }
    if (state === 'resting' && detail.part) {
      resting = { id: queue.head()?.rec.id, untilUtc: detail.untilUtc, part: detail.part, sec: null };
      tickResting();
    }
    const r = queue.settle(state, ctl);
    if (r) {
      if (r.serialDelta) setSerial(fields.serial + r.serialDelta);
      if (r.entry) appendSaved(finishTx(r.entry.rec, outcomeOf(r.entry, r.outcome)));
      for (const d of r.dropped) appendSaved(finishTx(d.rec, outcomeOf(d, 'dropped')));
      if (state === 'done' && !ctl.busy && ctl.queued === 0) notify(t('jtty.sent'));
      else if (state === 'aborted') notify(t('jtty.stopped'));
      else if (state === 'error' || state === 'rejected') {
        const error = txErrorText(detail.error, t);
        warn(t('jtty.tx_failed', { error }));
        notify(t('jtty.tx_failed', { error }));
      }
    }
    syncSendButton();
    refresh();
  }

  // 送出一則：規劃（強化編碼、發話者 frame、16 frame 上限，txplan.mjs）→ 開輸出 → 交給控制器。回 true＝已開始或已排隊。
  // 超過 16 frame 自動分則（U12，split.mjs）：每則各自規劃、依序發射、每則之間休息 prefs.restFrames 個 frame（PTT 放開）
  // macroPlan：巨集（一律照 JTTY 原樣、不走 UTX、不分則：太長照舊拒送）
  // 糾錯 frame（add-jtty-fec）：每則各自加（≥3 個資料 frame 才加），不算進 16 frame 上限
  const planOpts = (isMacro) => ({ utxOn: prefs.utx, isMacro, myCall: getSettings().callsign, attachCall: prefs.attachCall, fec: prefs.fec });
  const unsupportedText = (chars, canUtx) => t(canUtx && !prefs.utx ? 'jtty.unsupported_utx' : 'jtty.unsupported', { chars: chars.join(' ') });
  const restMs = () => Math.round(prefs.restFrames * FRAME_SEC * 1000);
  async function sendText(raw, macroPlan = null) {
    const sp = await frameCounter.split(raw, planOpts(Boolean(macroPlan)));
    let parts; // [{ text, frames?, utx }]
    if (sp === null) {
      let text;
      // 編碼器在主執行緒載不起來：照文字送（沒有發話者 frame、不能強化），發射時的編碼仍會檢查長度
      text = normalize(raw).trim();
      const bad = unsupportedChars(text);
      if (!text) {
        warn(t('jtty.err.empty'));
        return false;
      }
      if (bad.length) {
        warn(unsupportedText([...new Set(bad.map((b) => b.char))], false));
        return false;
      }
      parts = [{ text, utx: false }];
    } else if (sp.error) {
      // 拒送（不清輸入框）：空的、表外字元、巨集太長
      const p = sp.plan ?? { error: sp.error };
      if (p.error === 'empty') warn(t('jtty.err.empty'));
      else if (p.error === 'unsupported') warn(unsupportedText(p.chars, p.canUtx));
      else warn(t('jtty.txerr.too-long'));
      return false;
    } else {
      parts = sp.parts.map(({ plan: p }) => ({ text: p.text, frames: p.frames, utx: p.utx }));
    }
    if (!outputOverride) {
      try {
        await tx.ensureOutput();
      } catch (err) {
        warn(t('tx.outputOpenFailed', { msg: err.message }));
        return false;
      }
    }
    const n = parts.length;
    const one = parts[0];
    const reason = n > 1 ? ctl.send({ parts: parts.map(({ text, frames }) => ({ text, frames })), restMs: restMs() })
      : ctl.send(one.frames ? { text: one.text, frames: one.frames } : one.text);
    if (reason) {
      // 防護的原因（允許清單、監督、頻率、電台沒連上）：條件變了就重新檢查
      const fromGuard = reason !== 'queueFull' && reason !== 'empty';
      warn(reasonText(reason), fromGuard ? () => guard({ text: one.text, now: utcNow() }) : null);
      return false;
    }
    warn('');
    const utc = utcNow();
    parts.forEach(({ text, utx }, k) => {
      const part = n > 1 ? { i: k + 1, n } : null;
      queue.push({ text, plan: macroPlan, part, rec: txRecord({ seq: ++seq, utc: utc + k, to: fields.his, text, utx, part }) });
    });
    syncSendButton();
    refresh();
    return true;
  }

  // ── 輸入框：不支援的字元即時標示（強化開啟時任何字元都可以）；送出前預覽 frame 數與秒數；Enter／送出鍵送出 ──
  const previewEl = $('jtty-preview');
  let previewTimer = null;
  let previewSeq = 0;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const mine = ++previewSeq;
      const value = input.value;
      const chars = charCount(value);
      // 字數先顯示（編碼器還沒載入時只有字數）；frame 數與分則等規劃完再補
      previewEl.textContent = chars ? t('jtty.preview_chars', { chars }) : '';
      if (!chars) return;
      const sp = await frameCounter.split(value, planOpts(false));
      if (mine !== previewSeq || !sp || sp.error) return; // 打字中又改了；載不起來、表外字元：只顯示字數
      // frame 數與秒數含糾錯 frame（add-jtty-fec）；分則與否只看資料 frame（16 上限）
      const frames = sp.parts.reduce((a, x) => a + (x.plan.totalFrames ?? x.plan.frameCount), 0);
      const parity = sp.parts.reduce((a, x) => a + (x.plan.parityCount ?? 0), 0);
      const k = sp.parts.length;
      const fec = parity ? '_fec' : '';
      if (k === 1) {
        const p = sp.parts[0].plan;
        previewEl.textContent = t(`${p.utx ? 'jtty.preview_utx' : 'jtty.preview'}${fec}`, { chars, frames, parity, sec: (frames * FRAME_SEC).toFixed(1) });
      } else {
        const rest = prefs.restFrames;
        previewEl.textContent = t(`jtty.preview_split${fec}`, { chars, frames, parity, k, rest, sec: Math.round((frames + (k - 1) * rest) * FRAME_SEC) });
      }
    }, 150);
  }
  function markInput() {
    const bad = prefs.utx ? [] : unsupportedChars(input.value);
    input.setAttribute('aria-invalid', String(bad.length > 0));
    input.classList.toggle('invalid', bad.length > 0);
    warn(bad.length ? unsupportedText([...new Set(bad.map((b) => b.char))], true) : '');
    syncSendButton();
    schedulePreview();
    return bad;
  }
  input.addEventListener('input', markInput);
  async function sendInput() {
    const bad = markInput();
    if (bad.length) { // 拒送：選取第一個不支援的字元
      input.focus();
      input.setSelectionRange(bad[0].index, bad[0].index + bad[0].char.length);
      return false;
    }
    const ok = await sendText(input.value);
    if (ok) {
      input.value = '';
      markInput();
    }
    return ok;
  }
  // 強化開關（U5、U7）：開啟時輸入框接受任何字元、保留大小寫（手機鍵盤不自動大寫）
  const utxEl = $('jtty-utx');
  const syncUtx = () => {
    utxEl.checked = prefs.utx;
    input.setAttribute('autocapitalize', prefs.utx ? 'sentences' : 'characters');
  };
  utxEl.addEventListener('change', () => {
    prefs.utx = utxEl.checked;
    savePrefs();
    syncUtx();
    markInput();
  });
  syncUtx();
  // 附帶我的呼號（U10，在巨集對話框）：改了立即生效
  const attachEl = $('jtty-attach-call');
  attachEl.checked = prefs.attachCall;
  attachEl.addEventListener('change', () => {
    prefs.attachCall = attachEl.checked;
    savePrefs();
    schedulePreview();
  });
  // 分則休息 frame 數（U12，在巨集對話框，1～16、預設 4）：改了立即生效（之後送出的長訊息）
  const restEl = $('jtty-rest');
  const restSecEl = $('jtty-rest-sec');
  const showRest = () => {
    restEl.value = String(prefs.restFrames);
    restSecEl.textContent = t('jtty.rest_sec', { sec: (prefs.restFrames * FRAME_SEC).toFixed(1) });
  };
  restEl.addEventListener('change', () => {
    prefs.restFrames = clampRestFrames(restEl.value);
    savePrefs();
    showRest();
    schedulePreview();
  });
  showRest();
  // 糾錯（add-jtty-fec E1，在巨集對話框：關／標準／加強，預設標準）：改了立即生效
  const fecEl = $('jtty-fec');
  fecEl.value = prefs.fec;
  fecEl.addEventListener('change', () => {
    prefs.fec = normalizeFecSetting(fecEl.value);
    fecEl.value = prefs.fec;
    savePrefs();
    schedulePreview();
  });
  function syncSendButton() {
    sendBtn.textContent = t(sendButtonKey(ctl.busy, input.value.trim() !== ''));
  }
  sendBtn.addEventListener('click', () => {
    if (ctl.busy && !input.value.trim()) ctl.stop();
    else sendInput();
  });

  // ── 巨集按鈕 1～8（只用按鈕，不設快速鍵；使用者 2026-10-09） ──
  const fkeyBox = $('jtty-fkeys');
  const fkeyBtns = DEFAULT_MACROS.map((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary jtty-fkey';
    b.dataset.fkey = String(i + 1);
    b.append(Object.assign(document.createElement('b'), { textContent: String(i + 1) }), Object.assign(document.createElement('span'), { className: 'jtty-fkey-text' }));
    b.addEventListener('click', () => fire(i + 1));
    return b;
  });
  fkeyBox.replaceChildren(...fkeyBtns);
  function refreshFkeys() {
    macros.forEach((m, i) => {
      fkeyBtns[i].querySelector('.jtty-fkey-text').textContent = m;
      const p = planSend(i + 1, { macros, myCall: getSettings().callsign, hisCall: fields.his, queued: fields.queued, serial: fields.serial });
      fkeyBtns[i].title = p.error ? t(`jtty.err.${p.error}`) : p.text;
    });
    warnState.refresh(); // 呼號、欄位改了：防護提示條件解除就清掉
  }
  async function fire(key) {
    const plan = () => planSend(key, { macros, myCall: getSettings().callsign, hisCall: fields.his, queued: fields.queued, serial: fields.serial });
    const p = plan();
    if (p.error) {
      warn(t(`jtty.err.${p.error}`), () => { const e = plan().error; return e ? t(`jtty.err.${e}`) : null; }); // 欄位填了就清掉
      return false;
    }
    const before = fields.serial;
    const ok = await sendText(p.text, p);
    if (ok && p.serialNow !== before) setSerial(fields.serial + (p.serialNow - before)); // F6：發射前先加（W3）
    return ok;
  }

  // ── 巨集編輯（可還原預設） ──
  const dialog = $('jtty-macro-dialog');
  const macroInputs = DEFAULT_MACROS.map((_, i) => {
    const label = document.createElement('label');
    label.className = 'field jtty-macro';
    const inp = Object.assign(document.createElement('input'), { type: 'text', autocomplete: 'off', spellcheck: false });
    inp.setAttribute('autocapitalize', 'characters');
    inp.dataset.fkey = String(i + 1);
    label.append(Object.assign(document.createElement('span'), { textContent: String(i + 1) }), inp);
    return { label, inp };
  });
  $('jtty-macro-fields').replaceChildren(...macroInputs.map((m) => m.label));
  const fillMacroInputs = (list) => list.forEach((m, i) => { macroInputs[i].inp.value = m; });
  $('jtty-macro-edit').addEventListener('click', () => {
    fillMacroInputs(macros);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
  $('jtty-macro-reset').addEventListener('click', () => {
    macros = resetDefaults(storage);
    fillMacroInputs(macros);
    refreshFkeys();
  });
  $('jtty-macro-cancel').addEventListener('click', () => dialog.close());
  $('jtty-macro-save').addEventListener('click', () => {
    const next = macroInputs.map((m) => m.inp.value.trim());
    if (saveMacros(storage, next)) macros = next;
    refreshFkeys();
    dialog.close();
  });

  // ── 鍵盤（D11）：Esc 停止、輸入框 Enter 送出（巨集只用按鈕） ──
  document.addEventListener('keydown', (e) => {
    const action = jttyKeyAction(e, {
      active: document.body.classList.contains('mode-jtty'),
      dialogOpen: Boolean(document.querySelector('dialog[open]')),
      busy: ctl.busy,
      inInput: e.target === input,
    });
    if (!action) return;
    e.preventDefault();
    if (action.stop) ctl.stop();
    else if (action.send) sendInput();
  }, { capture: true });
  // 關閉或重新整理分頁時立即停止
  window.addEventListener('pagehide', () => ctl.stop());

  showFields();
  syncSendButton();
  refresh();

  return {
    controller: ctl,
    busy: () => ctl.busy,
    hasQueued: () => ctl.queued > 0,
    // 組合器的訊息更新（接收中、完整、不完整）
    onRx(snap) {
      // 發話者：發話者 frame ＞ 內容 ＞ 頻率記憶（U9、U10）；接收中每次更新都重算，辨識出來就補上
      const roles = resolveSender({ text: snap.text, freqHz: snap.freqHz, utc: snap.t0, sender: snap.sender ?? null }, senders);
      const rec = rxRecord(snap, roles);
      if (rec.live) live.set(rec.id, rec);
      else {
        live.delete(rec.id);
        appendSaved(rec);
      }
      refresh();
    },
    // 換頻率、離開 JTTY、停止接收：接收中泡泡屬於舊的音訊
    resetLive() {
      live.clear();
      senders.clear(); // 頻率記憶屬於舊的頻率
      refresh();
    },
    // 防護事件（換模式／頻率、電台斷線、SWR 過高…）：停止發射並說明原因
    stopTx(reason) {
      if (!ctl.stop()) return false;
      if (reason) {
        warn(reason);
        notify(reason);
      }
      return true;
    },
    sendInput,
    fire,
    setStatus(text) {
      $('jtty-status').textContent = text;
    },
    setDial(text) {
      $('jtty-dial').textContent = text;
    },
    setDropped(n) {
      $('jtty-dropped').textContent = n > 0 ? t('jtty.dropped', { n }) : '';
    },
    refreshFkeys, // 呼號改了：F 鍵提示跟著更新
    // 本機開發掛鉤：注入假編碼（(text, freqHz) → Float32Array）、假輸出（{ play, stop }）
    dev: {
      setEncoder: (fn) => { encodeOverride = fn; },
      setOutput: (o) => { outputOverride = o; },
      fields: () => ({ ...fields }),
      macros: () => [...macros],
      prefs: () => ({ ...prefs }),
      messages: () => allMessages().map((m) => ({ ...m })),
    },
  };
}
