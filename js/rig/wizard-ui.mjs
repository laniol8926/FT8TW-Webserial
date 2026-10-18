// 電台自動設定精靈（add-rig-autosetup）：設置 › 電台與聲音 ›「自動設定精靈」。
// 步驟：安全問題 → 選埠 → 探測／選機型 → 音效輸入＋收訊電平 → 音效輸出 → 發射電平（按住發射）。
// 依賴 DOM、Web Serial、媒體裝置，以真瀏覽器檢查（tools/ui-rig-check.mjs）驗證；邏輯在 probe／wizard-model／audio-pair／audio-level／testtone，皆有單元測試。
// 輸入、輸出、發射電平改的是設定頁原本的控制項（#device、#tx-device、#tx-gain，送 change／input 事件），存檔沿用原本的程式。
import { describePort } from './serial.mjs';
import { formatRigHz } from './prefs.mjs';
import { portPickText, rigErrorText } from './errors.mjs';
import { probeResultPrefs } from './probe.mjs';
import { modelChoices, probeMode, rxAdvice, safetyReady, txAdvice, wizardSteps } from './wizard-model.mjs';
import { hasRigCodec, pairOutput } from '../audio-pair.mjs';
import { judgeLevel, levelOf } from '../audio-level.mjs';
import { AUDIO_CONSTRAINTS } from '../audio.mjs';
import { holdTestTone } from '../config/testtone.mjs';
import { TxOutput } from '../tx/output.mjs';
import { t } from '../i18n/index.mjs';

const $ = (id) => document.getElementById(id);
const LEVEL_MS = 200;

// rigUi：initRigUi 的回傳值；blockReason()：發射防護（同測試音），可以發射回 null
export function initRigWizard({ rigUi, mediaDevices = globalThis.navigator?.mediaDevices, blockReason = () => null }) {
  const api = rigUi.autosetup;
  const dialog = $('rig-wiz');
  if (!api.supported || !dialog) return null;

  const st = { mode: 'cat', y5: null, steps: [], index: 0, port: null, result: null, applied: false, abort: null, busy: false, hold: null, meter: {} };
  const msg = (id, text, isError = false) => {
    $(id).textContent = text;
    $(id).className = isError ? 'hint error' : 'hint';
  };
  const radio = (name) => dialog.querySelector(`input[name="${name}"]:checked`)?.value;
  const step = () => st.steps[st.index];
  const pm = () => probeMode(st);

  function render() {
    st.mode = radio('rig-wiz-mode') ?? 'cat';
    st.y5 = radio('rig-wiz-y5') ?? null; // 沒有預設值：使用者一定要回答（review #1）
    st.steps = wizardSteps(st);
    st.index = Math.min(st.index, st.steps.length - 1);
    $('rig-wiz-y5-set').hidden = st.mode === 'vox';
    const hint = st.mode === 'vox' ? '' : st.y5 === 'yes' ? 'rig.wiz.hint.y5' : st.mode !== 'cat' ? 'rig.wiz.hint.manual'
      : st.y5 === 'unsure' ? 'rig.wiz.hint.unsure' : st.y5 === null ? 'rig.wiz.hint.answerY5' : '';
    msg('rig-wiz-safety-hint', hint ? t(hint) : '');
    $('rig-wiz-steps').replaceChildren(...st.steps.map((s, i) => {
      const li = document.createElement('li');
      li.textContent = t(`rig.wiz.step.${s}`);
      if (i === st.index) li.setAttribute('aria-current', 'step');
      return li;
    }));
    for (const sec of dialog.querySelectorAll('section[data-step]')) sec.hidden = sec.dataset.step !== step();
    const last = st.index === st.steps.length - 1;
    $('rig-wiz-back').hidden = st.index === 0;
    $('rig-wiz-next').hidden = last;
    $('rig-wiz-skip').hidden = last || st.index === 0;
    $('rig-wiz-next').disabled = (step() === 'safety' && !safetyReady(st)) || (step() === 'port' && !st.port) || (step() === 'probe' && !st.applied) || st.busy;
    $('rig-wiz-back').disabled = st.busy; // 探測、套用進行中不能離開這一步（review #7）
    $('rig-wiz-skip').disabled = st.busy;
    // 最後一步：「完成」（使用者 2026-10-09），其他步驟「關閉」
    $('rig-wiz-close').textContent = t(last ? 'rig.wiz.finish' : 'rig.wiz.close');
    $('rig-wiz-close').className = last ? '' : 'secondary';
  }

  async function go(delta) {
    if (st.busy) return;
    // 離開第一步：精靈選的控制方式寫回設定（發射步驟的 PTT 用存檔的控制方式，review #5）
    if (step() === 'safety' && delta > 0) api.setControlMode(st.mode);
    await leave();
    st.index = Math.max(0, Math.min(st.steps.length - 1, st.index + delta));
    render();
    await enter();
  }

  async function enter() {
    if (step() === 'probe') enterProbe();
    if (step() === 'input') await enterInput();
    if (step() === 'output') await enterOutput();
    if (step() === 'tx') enterTx();
  }

  async function leave() {
    st.abort?.abort();
    stopLevel();
    releaseHold();
  }

  // ── 選埠（requestPort 必須在 click 裡）──
  async function choosePort(showAll) {
    try {
      st.port = await api.requestPort(showAll);
      st.result = null;
      st.applied = false;
      msg('rig-wiz-port-msg', t('rig.wiz.portChosen', { port: describePort(st.port) || t('rig.wiz.portUnknown') }));
    } catch (err) {
      const rigCodec = showAll && err?.code === 'cancelled' && hasRigCodec(await mediaDevices?.enumerateDevices?.().catch(() => []));
      msg('rig-wiz-port-msg', portPickText(err, { filtered: !showAll, rigCodec }), true);
    }
    render();
  }

  // ── 探測／選機型 ──
  function fillModels(names) {
    $('rig-wiz-model').replaceChildren(...names.map((n) => new Option(n, n)));
    $('rig-wiz-pick-line').hidden = names.length === 0;
    $('rig-wiz-apply').hidden = names.length === 0;
  }

  function enterProbe() {
    const scan = pm() === 'scan';
    $('rig-wiz-scan').hidden = !scan;
    msg('rig-wiz-apply-msg', '');
    if (scan) {
      fillModels(modelChoices('scan', st.result));
      // 進到這一步就自動開始偵測（使用者 2026-10-09：沒注意到「開始偵測」按鈕，以為沒有 QMX）
      if (!st.result && !st.abort && st.port) runProbe();
      else if (!st.result) msg('rig-wiz-probe-msg', '');
    } else {
      msg('rig-wiz-probe-msg', t(pm() === 'yaesu5' ? 'rig.wiz.pickY5' : 'rig.wiz.pickManual'));
      fillModels(modelChoices(pm(), null));
      const cur = api.prefs().model;
      if (cur && [...$('rig-wiz-model').options].some((o) => o.value === cur)) $('rig-wiz-model').value = cur;
    }
  }

  async function runProbe() {
    if (!st.port || pm() !== 'scan') return;
    st.abort = new AbortController();
    st.busy = true;
    $('rig-wiz-probe').disabled = true;
    $('rig-wiz-probe-cancel').hidden = false;
    fillModels([]);
    render();
    try {
      await api.release();
      const r = await api.probe(st.port, { signal: st.abort.signal, onProgress: ({ baud }) => msg('rig-wiz-probe-msg', t('rig.wiz.probing', { baud })) });
      st.result = r.found ? r : null;
      if (!r.found) {
        msg('rig-wiz-probe-msg', t('rig.wiz.notFound'), true);
      } else {
        const how = r.protocol === 'civ' ? `CI-V ${r.civ.toString(16).toUpperCase().padStart(2, '0')}` : r.id ? `ID ${r.id}` : 'ASCII';
        msg('rig-wiz-probe-msg', t(r.suggested ? 'rig.wiz.found' : 'rig.wiz.foundPick', { baud: r.baud, how }));
        fillModels(modelChoices('scan', r));
      }
    } catch (err) {
      msg('rig-wiz-probe-msg', err?.name === 'AbortError' ? t('rig.wiz.probeCancelled') : t('rig.wiz.probeFailed', { msg: rigErrorText(err) }), true);
    } finally {
      st.abort = null;
      st.busy = false;
      $('rig-wiz-probe').disabled = false;
      $('rig-wiz-probe-cancel').hidden = true;
      render();
    }
  }

  async function applyModel() {
    const name = $('rig-wiz-model').value;
    const result = st.result ?? (pm() === 'yaesu5' ? { protocol: 'yaesu5', vendor: 'yaesu' } : {});
    const next = probeResultPrefs(api.prefs(), result, name);
    if (!next || !st.port) return;
    $('rig-wiz-apply').disabled = true;
    st.busy = true;
    render();
    msg('rig-wiz-apply-msg', t('rig.status.connecting'));
    try {
      const hz = await api.apply({ ...next, controlMode: st.mode }, st.port);
      st.applied = true;
      msg('rig-wiz-apply-msg', hz ? t('rig.wiz.applied', { freq: formatRigHz(hz) }) : t('rig.wiz.appliedNoFreq'), !hz);
    } catch (err) {
      msg('rig-wiz-apply-msg', t('rig.status.error', { msg: rigErrorText(err) }), true);
    } finally {
      st.busy = false;
      $('rig-wiz-apply').disabled = false;
      render();
    }
  }

  // ── 音效輸入＋收訊電平（A12）──
  let level = null; // { stream, ctx, timer }
  let levelGen = 0; // 每次開始／停止都加一：await 期間被停掉的那一次要自己收掉（review #2）
  async function devices() {
    try {
      return (await mediaDevices?.enumerateDevices?.()) ?? [];
    } catch {
      return [];
    }
  }

  async function enterInput() {
    const sel = $('rig-wiz-input');
    sel.replaceChildren(...[...$('device').options].map((o) => new Option(o.textContent, o.value)));
    sel.value = $('device').value;
    await startLevel(sel.value);
  }

  function stopLevel() {
    levelGen += 1;
    if (!level) return;
    clearInterval(level.timer);
    level.stream.getTracks().forEach((tr) => tr.stop());
    level.ctx.close().catch(() => {});
    level = null;
  }

  async function startLevel(deviceId) {
    stopLevel();
    const gen = levelGen;
    msg('rig-wiz-rx-msg', '');
    try {
      const stream = await mediaDevices.getUserMedia(AUDIO_CONSTRAINTS(deviceId || undefined));
      if (gen !== levelGen || step() !== 'input' || !dialog.open) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        const lv = levelOf(buf);
        const db = Number.isFinite(lv.rmsDb) ? Math.max(-90, lv.rmsDb) : -90;
        $('rig-wiz-rx-meter').value = db;
        $('rig-wiz-rx-db').textContent = `${Math.round(db)} dBFS`;
        msg('rig-wiz-rx-msg', t(rxAdvice(judgeLevel(lv))), judgeLevel(lv) !== 'ok');
      }, LEVEL_MS);
      level = { stream, ctx, timer };
    } catch (err) {
      msg('rig-wiz-rx-msg', t('rig.wiz.rx.failed', { msg: err?.message ?? String(err) }), true);
    }
  }

  async function chooseInput() {
    const id = $('rig-wiz-input').value;
    $('device').value = id;
    $('device').dispatchEvent(new Event('change', { bubbles: true }));
    await startLevel(id);
  }

  // 「自動偵測」沿用主頁的偵測（約 30 秒，會開始接收）；#detect 停用期間就是偵測中
  async function detectInput() {
    stopLevel();
    $('rig-wiz-detect').disabled = true;
    msg('rig-wiz-rx-msg', t('rig.wiz.detecting'));
    $('detect').click();
    await new Promise((resolve) => {
      let seenBusy = false;
      const timer = setInterval(() => {
        if ($('detect').disabled) seenBusy = true;
        else if (seenBusy || !dialog.open) { clearInterval(timer); resolve(); }
      }, 300);
      setTimeout(() => { if (!seenBusy) { clearInterval(timer); resolve(); } }, 3000);
    });
    $('rig-wiz-detect').disabled = false;
    if (step() === 'input' && dialog.open) await enterInput();
  }

  // ── 音效輸出（A11）──
  async function enterOutput() {
    const list = await devices();
    const inputId = $('device').value || 'default';
    const input = list.find((d) => d.kind === 'audioinput' && d.deviceId === inputId) ?? null;
    const pair = pairOutput(input, list);
    const outs = list.filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const sel = $('rig-wiz-output');
    sel.replaceChildren(new Option(t('config.systemDefault'), ''), ...outs.map((d) => new Option(d.label || d.deviceId, d.deviceId)));
    // 只預選；按「下一步」或改選單才套用（略過這一步不改設定，review F）
    if (pair.deviceId) {
      sel.value = pair.deviceId;
      msg('rig-wiz-output-msg', t(pair.reason === 'group' ? 'rig.wiz.outGroup' : 'rig.wiz.outName', { label: pair.label }));
    } else {
      sel.value = $('tx-device').value;
      msg('rig-wiz-output-msg', t('rig.wiz.outPick'), true);
    }
    if (!('setSinkId' in AudioContext.prototype)) msg('rig-wiz-output-msg', t('tx.defaultOutputOnly'), true);
  }

  function applyOutput() {
    const id = $('rig-wiz-output').value;
    const target = $('tx-device');
    if (id && ![...target.options].some((o) => o.value === id)) target.append(new Option($('rig-wiz-output').selectedOptions[0].textContent, id));
    target.value = id;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── 發射電平：按住發射（A14、A15）──
  function enterTx() {
    $('rig-wiz-gain').value = $('tx-gain').value;
    $('rig-wiz-gain-value').textContent = `${Math.round(Number($('tx-gain').value) * 100)}%`;
    $('rig-wiz-hold').disabled = !$('rig-wiz-tx-ok').checked;
    msg('rig-wiz-tx-msg', '');
  }

  function showMeter() {
    const m = st.meter;
    $('rig-wiz-alc').textContent = m.alcRaw === undefined ? '—' : `${m.alcRaw}${m.alc ? ` (${t(`rig.wiz.alc.${m.alc}`)})` : ''}`;
    $('rig-wiz-power').textContent = m.power === undefined ? '—' : `${(m.power / 10).toFixed(1)} W`; // QMX PC：0.1 W（Hamlib ts480.c）
    $('rig-wiz-swr').textContent = m.swr === undefined ? '—' : m.swr.toFixed(1);
    if (st.hold) msg('rig-wiz-tx-msg', t(txAdvice(m)), m.alc === 'high' || m.power === 0);
  }
  rigUi.rig.on('meter', (d) => { if (st.hold) { Object.assign(st.meter, d); showMeter(); } });
  rigUi.rig.on('swr', (d) => { if (st.hold) { st.meter.swr = d.swr; showMeter(); } });

  function startHold() {
    if (st.hold || $('rig-wiz-hold').disabled) return;
    const reason = blockReason();
    if (reason) return msg('rig-wiz-tx-msg', reason, true);
    st.meter = {};
    showMeter();
    $('rig-wiz-hold').classList.add('holding');
    msg('rig-wiz-tx-msg', t('rig.wiz.txOn'));
    // 輸出被系統暫停或關閉（音效卡拔除、來電）：立刻放開（review A）
    const output = new TxOutput({ onInterrupted: () => releaseHold() });
    const h = holdTestTone({ output, sinkId: $('tx-device').value, gain: Number($('tx-gain').value), ptt: rigUi.ptt });
    st.hold = h;
    h.done.then(
      (r) => {
        if (r.reason === 'limit') msg('rig-wiz-tx-msg', t('rig.wiz.txLimit'), true);
        else if (st.meter.alcRaw === undefined && st.meter.power === undefined) msg('rig-wiz-tx-msg', t(txAdvice(st.meter)));
      },
      (err) => msg('rig-wiz-tx-msg', t('config.toneFailed', { error: rigErrorText(err) }), true),
    ).finally(() => {
      if (st.hold === h) st.hold = null;
      $('rig-wiz-hold').classList.remove('holding');
    });
  }

  function releaseHold() {
    st.hold?.release();
  }

  // ── 事件 ──
  $('rig-wiz-open').addEventListener('click', () => {
    st.index = 0;
    st.applied = false;
    st.result = null;
    // 控制方式從目前設定帶入；舊款 Yaesu 沒有預設值；安全確認每次重勾（review #5、#7）
    const cur = dialog.querySelector(`input[name="rig-wiz-mode"][value="${api.prefs().controlMode}"]`);
    if (cur) cur.checked = true;
    for (const r of dialog.querySelectorAll('input[name="rig-wiz-y5"]')) r.checked = false;
    $('rig-wiz-tx-ok').checked = false;
    render();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
  for (const el of dialog.querySelectorAll('input[name="rig-wiz-mode"], input[name="rig-wiz-y5"]')) {
    el.addEventListener('change', () => { st.applied = false; render(); });
  }
  $('rig-wiz-next').addEventListener('click', () => {
    if (step() === 'output') applyOutput();
    go(1);
  });
  $('rig-wiz-skip').addEventListener('click', () => go(1));
  $('rig-wiz-back').addEventListener('click', () => go(-1));
  $('rig-wiz-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { leave(); });
  $('rig-wiz-port').addEventListener('click', () => choosePort(false));
  $('rig-wiz-port-all').addEventListener('click', () => choosePort(true));
  $('rig-wiz-probe').addEventListener('click', runProbe);
  $('rig-wiz-probe-cancel').addEventListener('click', () => st.abort?.abort());
  $('rig-wiz-apply').addEventListener('click', applyModel);
  $('rig-wiz-input').addEventListener('change', chooseInput);
  $('rig-wiz-detect').addEventListener('click', detectInput);
  $('rig-wiz-output').addEventListener('change', () => { applyOutput(); msg('rig-wiz-output-msg', ''); });
  $('rig-wiz-tx-ok').addEventListener('change', () => { $('rig-wiz-hold').disabled = !$('rig-wiz-tx-ok').checked; if (!$('rig-wiz-tx-ok').checked) releaseHold(); });
  $('rig-wiz-gain').addEventListener('input', () => {
    const g = $('rig-wiz-gain').value;
    $('rig-wiz-gain-value').textContent = `${Math.round(Number(g) * 100)}%`;
    $('tx-gain').value = g;
    $('tx-gain').dispatchEvent(new Event('input', { bubbles: true }));
    st.hold?.setGain(Number(g));
  });
  const hold = $('rig-wiz-hold');
  hold.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try { hold.setPointerCapture?.(e.pointerId); } catch { /* 拿不到 capture 也照樣發射；放開靠 pointerup／blur */ }
    startHold();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) hold.addEventListener(type, releaseHold);
  hold.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startHold(); }
  });
  hold.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') releaseHold(); });
  hold.addEventListener('blur', releaseHold);
  hold.addEventListener('contextmenu', (e) => e.preventDefault()); // 手機長按不要跳選單
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseHold(); });
  // 控制器那邊結束發射（斷線、SWR 停發、看門狗、PTT 關可能沒送出）：音訊也要停（review B）
  for (const type of ['disconnecting', 'disconnect', 'swrStop', 'pttWatchdog', 'pttStuck']) rigUi.rig.on(type, releaseHold);
  rigUi.rig.on('ptt', (d) => { if (!d.on) releaseHold(); });

  return { open: () => $('rig-wiz-open').click(), holding: () => Boolean(st.hold), release: releaseHold }; // release：換頻率時放開（code review 2026-10-09）
}
