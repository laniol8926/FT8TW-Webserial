// 設置 › 電台與聲音 的電台控制區塊（add-web-rig-control 4.1）：控制方式、機型、序列埠參數、CI-V、PTT 延遲、選擇序列埠、連線、測試、狀態。
// 依賴 DOM 與 Web Serial，以真瀏覽器檢查（tools/ui-rig-check.mjs，注入假 navigator.serial）驗證；邏輯在 serial／rig／sets／prefs，皆有單元測試。
import { SerialLink, describePort, portInfo, sameInfo } from './serial.mjs';
import { RigController, pttAdapter } from './rig.mjs';
import { MODEL_GROUPS, findModel } from './models.mjs';
import { getSet } from './sets.mjs';
import { portPickText, rigError, rigErrorText } from './errors.mjs';
import { probeRig } from './probe.mjs';
import { hasRigCodec } from '../audio-pair.mjs';
import { SERIAL_FILTERS } from './probe-ids.mjs';
import { BAUD_RATES, PTT_DELAY_MAX_MS, connectParams, formatCiv, formatRigHz, groupLabel, loadRigPrefs, parseCiv, saveRigPrefs, withModel } from './prefs.mjs';
import { t } from '../i18n/index.mjs';

const $ = (id) => document.getElementById(id);

// getTargetHz()：目前頻段＋模式的標準撥號頻率（連上後設給電台）；onEvent(type, detail)：轉發控制器事件給主程式
export function initRigUi({ storage, serial = globalThis.navigator?.serial ?? null, getTargetHz = () => null, onEvent = () => {} }) {
  const supported = Boolean(serial?.getPorts);
  const link = new SerialLink({ serial: supported ? serial : null });
  const rig = new RigController({ link, storage });
  let prefs = loadRigPrefs(storage);
  let port = null; // 目前（或上次）用的 SerialPort
  let busy = false;
  let userDisconnected = false; // 使用者按了「中斷連線」：裝置重新插上時不自動連
  let probing = false; // 自動設定精靈探測中：不自動連線（會搶走探測開著的埠，review C）

  // 不支援 Web Serial：只留 VOX（D1）
  if (!supported) {
    for (const opt of [...$('rig-control').options]) if (opt.value !== 'vox') opt.remove();
  }
  const mode = () => (supported ? prefs.controlMode : 'vox');

  // ── 選單 ──
  const model = $('rig-model');
  model.replaceChildren(new Option(t('rig.modelNone'), ''), ...MODEL_GROUPS.map((g) => {
    const og = document.createElement('optgroup');
    og.label = groupLabel(g);
    og.append(...g.map((m) => new Option(m.name, m.name)));
    return og;
  }));
  $('rig-baud').replaceChildren(...BAUD_RATES.map((b) => new Option(String(b), String(b))));

  const status = (text, isError = false) => {
    $('rig-status').textContent = text;
    $('rig-status').className = isError ? 'hint error' : 'hint';
  };
  const fieldError = (text) => { $('rig-field-error').textContent = text; };

  function render() {
    $('rig-unsupported').hidden = supported;
    $('rig-wiz-line').hidden = !supported; // 自動設定精靈只在有 Web Serial 時（spec）
    $('rig-control').value = mode();
    $('rig-cat').hidden = mode() === 'vox';
    model.value = prefs.model;
    $('rig-baud').value = prefs.baud ? String(prefs.baud) : '';
    $('rig-databits').value = String(prefs.dataBits);
    $('rig-stopbits').value = String(prefs.stopBits);
    $('rig-parity').value = prefs.parity;
    if (document.activeElement !== $('rig-civ')) $('rig-civ').value = formatCiv(prefs.civ);
    if (document.activeElement !== $('rig-ptt-delay')) $('rig-ptt-delay').value = String(prefs.pttDelayMs);
    const set = getSet(findModel(prefs.model)?.set);
    $('rig-civ-line').hidden = set?.protocol !== 'civ';
    $('rig-noswr').hidden = !set || Boolean(set.swr);
    $('rig-connect').textContent = rig.connected ? t('rig.disconnect') : t('rig.connect');
    $('rig-test').disabled = !rig.connected || rig.pttOnNow; // 發射中不測試（truSDX 讀頻會送 ;RX;，安全審查 #8）
  }

  function renderStatus() {
    if (rig.state === 'connecting') return status(t('rig.status.connecting'));
    if (!rig.connected) return;
    const hz = rig.actualHz(60_000);
    const name = describePort(port);
    status(hz ? t('rig.status.freq', { port: name, freq: formatRigHz(hz) }) : t('rig.status.connected', { port: name }));
  }

  function save(next) {
    prefs = next;
    saveRigPrefs(storage, prefs);
    render();
    onEvent('prefs', {}); // 主畫面電台資訊組（控制方式、機型）重畫（add-rig-meters）
  }

  // ── 連線 ──
  async function connect(p) {
    const params = connectParams(prefs);
    if (!params) {
      status(t('rig.status.needModel'), true);
      return false;
    }
    if (!p) {
      status(t('rig.status.noPort'), true);
      return false;
    }
    busy = true;
    try {
      port = p;
      await rig.connect({ port: p, ...params, freqHz: getTargetHz() });
      userDisconnected = false;
      renderStatus();
      return true;
    } catch (err) {
      status(t('rig.status.error', { msg: rigErrorText(err) }), true);
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  // 使用者明確中斷（按鈕、改回 VOX）：force——PTT 關沒確定送出也關埠（先再試一次 PTT 關、拉低控制線，失敗留警告）
  async function disconnect() {
    await rig.disconnect({ force: true });
    status(t('rig.status.off'));
    render();
  }

  // 改設定、換埠的斷線：PTT 關沒確定送出時不關埠（丟 pttStuck），顯示原因
  async function softDisconnect() {
    try {
      await rig.disconnect();
      return true;
    } catch (err) {
      status(t('rig.status.error', { msg: rigErrorText(err) }), true);
      render();
      return false;
    }
  }

  // 已授權過的埠（不需要手勢）：開網頁、改設定、裝置重新插上時
  async function autoConnect() {
    if (probing || busy || rig.connected || mode() === 'vox' || !prefs.port || !connectParams(prefs)) return;
    try {
      const p = await link.findGranted(prefs.port);
      if (p) await connect(p);
    } catch {
      // 找不到授權過的埠：等使用者按「選擇序列埠」
    }
  }

  async function reconnect() {
    if (!rig.connected) return autoConnect();
    const p = port;
    if (await softDisconnect()) await connect(p);
  }

  // ── 事件 ──
  $('rig-control').addEventListener('change', async () => {
    save({ ...prefs, controlMode: $('rig-control').value });
    if (mode() === 'vox') await disconnect();
    else await reconnect();
  });
  model.addEventListener('change', async () => {
    save(withModel(prefs, model.value));
    await reconnect();
  });
  for (const [id, key] of [['rig-baud', 'baud'], ['rig-databits', 'dataBits'], ['rig-stopbits', 'stopBits']]) {
    $(id).addEventListener('change', async () => {
      save({ ...prefs, [key]: Number($(id).value) });
      await reconnect();
    });
  }
  $('rig-parity').addEventListener('change', async () => {
    save({ ...prefs, parity: $('rig-parity').value });
    await reconnect();
  });
  $('rig-civ').addEventListener('change', async () => {
    const v = parseCiv($('rig-civ').value);
    if (v === null) {
      fieldError(t('rig.civInvalid'));
      return;
    }
    fieldError('');
    save({ ...prefs, civ: v });
    $('rig-civ').value = formatCiv(v);
    await reconnect();
  });
  $('rig-ptt-delay').addEventListener('change', () => {
    const n = Number($('rig-ptt-delay').value);
    if (!Number.isInteger(n) || n < 0 || n > PTT_DELAY_MAX_MS) {
      fieldError(t('rig.pttDelayInvalid'));
      return;
    }
    fieldError('');
    save({ ...prefs, pttDelayMs: n });
  });

  // 選擇序列埠：requestPort 必須在使用者手勢裡呼叫
  $('rig-port').addEventListener('click', async () => {
    let p;
    try {
      p = await link.requestPort();
    } catch (err) {
      const rigCodec = err?.code === 'cancelled' && hasRigCodec(await navigator.mediaDevices?.enumerateDevices?.().catch(() => []));
      status(portPickText(err, { rigCodec }), true);
      return;
    }
    save({ ...prefs, port: portInfo(p) });
    if (rig.connected && !(await softDisconnect())) return;
    await connect(p);
  });
  $('rig-connect').addEventListener('click', async () => {
    if (rig.connected) {
      userDisconnected = true;
      await disconnect();
      return;
    }
    const p = port ?? (prefs.port ? await link.findGranted(prefs.port).catch(() => null) : null);
    await connect(p);
  });
  $('rig-test').addEventListener('click', async () => {
    $('rig-test').disabled = true;
    try {
      const hz = await rig.readFrequency();
      status(t('rig.testOk', { freq: formatRigHz(hz) }));
    } catch (err) {
      status(err.code === 'readTimeout' ? t('rig.testTimeout') : t('rig.testFailed', { msg: rigErrorText(err) }), true);
    } finally {
      $('rig-test').disabled = !rig.connected || rig.pttOnNow;
    }
  });

  for (const type of ['state', 'freq', 'swr', 'smeter', 'swrStop', 'ptt', 'warning', 'disconnect', 'disconnecting', 'error', 'pttWatchdog', 'pttStuck']) {
    rig.on(type, (d) => {
      if (type === 'freq') renderStatus();
      if (type === 'ptt') render();
      // PTT 關可能沒送出（安全審查 #1）：醒目警告（aria-live assertive），PTT 關成功才消失
      if (type === 'pttStuck') {
        $('rig-ptt-stuck').hidden = !d.stuck;
        $('rig-ptt-stuck').textContent = d.stuck ? t('rig.pttStuck') : '';
      }
      if (type === 'disconnect') {
        status(t('rig.status.lost'), true);
        render();
      }
      if (type === 'warning') {
        $('rig-warning').hidden = !d.code;
        $('rig-warning').textContent = d.code ? t(`rig.warn.${d.code}`) : '';
      }
      onEvent(type, d);
    });
  }
  if (supported) {
    link.onConnectEvent((p) => {
      if (!userDisconnected && !rig.connected && sameInfo(portInfo(p), prefs.port)) autoConnect();
    });
  }
  // 分頁關閉：不排隊立刻送 PTT 關（D13）
  const emergency = () => rig.emergencyPttOff();
  window.addEventListener('pagehide', emergency);
  window.addEventListener('beforeunload', emergency);

  render();
  status(t('rig.status.off'));
  if (supported && mode() !== 'vox') autoConnect();

  // 給 TxController／測試音的 PTT 介面（D12、D20，rig.mjs pttAdapter）
  const ptt = pttAdapter(rig, { mode, delayMs: () => prefs.pttDelayMs });

  return {
    rig,
    ptt,
    // 電台實際撥號頻率（10 s 內讀到的），沒有連線回 null
    actualHz: () => rig.actualHz(),
    // 主畫面電台資訊組（add-rig-meters）：控制方式（不支援 Web Serial 時一律 VOX）與機型名稱
    meterInfo: () => ({ controlMode: mode(), model: prefs.model }),
    // 換頻段／模式：連線中就設給電台（PTT 開著時控制器會延到 PTT 關後）
    tune(hz) {
      if (rig.connected && hz) rig.setBandAndMode(hz).catch(() => {});
    },
    // 切換設定組前斷開（add-web-profiles P4）：連線中先等開埠完成；PTT 關沒確定送出丟 pttStuck
    async releaseForSwitch() {
      for (let i = 0; i < 50 && (busy || rig.state === 'connecting'); i++) await new Promise((r) => setTimeout(r, 100));
      if (rig.connected || rig.state === 'connecting') await rig.disconnect();
      userDisconnected = true; // 重新載入前裝置事件不要再自動連
    },
    // 自動設定精靈（add-rig-autosetup，wizard-ui.mjs）用
    autosetup: {
      supported,
      prefs: () => prefs,
      // 必須在使用者手勢裡呼叫；showAll 為假時只列常見電台 USB 晶片（A8）
      requestPort: (showAll) => link.requestPort(showAll ? {} : { filters: [...SERIAL_FILTERS] }),
      // 精靈第一步選的控制方式：走設定頁原本的流程（存檔、VOX 斷線、其他重連）
      setControlMode(m) {
        if (m === prefs.controlMode) return;
        $('rig-control').value = m;
        $('rig-control').dispatchEvent(new Event('change'));
      },
      // 探測前先斷開（先發 disconnecting 停發射）；PTT 關沒確定送出時不開始（A9）。之後到 probe() 結束都不自動連線
      async release() {
        if (rig.pttStuck) throw rigError('pttStuck', 'PTT OFF not confirmed');
        probing = true;
        try {
          // 連線中：等開埠完成再斷，免得斷線時埠還沒開、之後又連上（review C）
          for (let i = 0; i < 50 && (busy || rig.state === 'connecting'); i++) await new Promise((r) => setTimeout(r, 100));
          if (rig.connected || rig.state === 'connecting') {
            if (!(await softDisconnect())) throw rigError('pttStuck', 'PTT OFF not confirmed');
          }
          status(t('rig.status.off'));
          render();
        } catch (err) {
          probing = false;
          throw err;
        }
      },
      async probe(p, opts) {
        probing = true;
        try {
          return await probeRig({ link, port: p, ...opts });
        } finally {
          probing = false;
        }
      },
      // 連線成功才存設定（含埠的 VID／PID），失敗回到原本的設定（review G）；回傳電台頻率（讀不到回 null）
      async apply(next, p) {
        if (rig.connected && !(await softDisconnect())) throw rigError('pttStuck', 'PTT OFF not confirmed');
        const prev = prefs;
        prefs = { ...next, port: portInfo(p) };
        if (!(await connect(p))) {
          prefs = prev;
          render();
          throw rigError('notConnected', $('rig-status').textContent);
        }
        save(prefs);
        try {
          return await rig.readFrequency();
        } catch {
          return null;
        }
      },
    },
  };
}
