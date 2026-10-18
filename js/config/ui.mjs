// 設定頁（左上角抽屜＝FT8TW「設置」）的畫面串接：主選單 ↔ 區段、i 說明、ft8tw.config 項目、主頁摘要列、測試音。
// 依賴 DOM，以真瀏覽器檢查（tools/ui-config-check.mjs）驗證；邏輯在 model／sections／help／testtone，皆有單元測試。
// 呼號、網格、波段、模式、音訊輸入由 settings-ui.mjs 串接；發射頻率、輸出裝置、音量由 tx/ui.mjs 串接（element id 不變）。
import { CONFIG_DEFAULTS, FINISH_RETRY_OPTIONS, FONT_SIZES, TIME_OFFSET_OPTIONS, RX_DELAY_OPTIONS, NO_REPLY_OPTIONS, QSO_FILTER_OPTIONS, SUPERVISION_OPTIONS,
  loadConfig, normalizeModifier, parseCallList, saveConfig, updateConfig } from './model.mjs';
import { pageTitle } from './sections.mjs';
import { helpParagraphs, helpText } from './help.mjs';
import { playTestTone, testToneBlockReason } from './testtone.mjs';
import { TxOutput } from '../tx/output.mjs';
import { SCHEME_LABELS } from '../qso/autofollow.mjs';
import { renderSummary } from '../layout.mjs';
import { APP_VERSION, BUILD_TIME } from '../version.mjs';
import { displayVersion, formatOffset } from '../format.mjs';
import { t, locale, languagePref, setLanguage } from '../i18n/index.mjs';
import { WEB_VERSION } from '../config.mjs';
import { webIssueUrl } from '../issue.mjs';
import { CHANGELOG, releaseItems, releaseLabel } from '../changelog.mjs';
import { rigErrorText } from '../rig/errors.mjs';
import { createProfile, displayName, errorKey, loadProfiles, nameError, renameProfile, requestDelete, requestSwitch } from './profiles.mjs';
import { profileBoot } from './boot.mjs';
import { validateTileAttribution, validateTileTemplate } from '../map/tilesource.mjs';

const $ = (id) => document.getElementById(id);

// 不合法值提示用的項目名稱（字典 config.label.<欄位>）
const label = (key) => t(`config.label.${key}`);

// storage：localStorage；menu：layout.mjs initMenu 的回傳（open／close）；getSettings：settings-ui 的目前設定（測試音防護用）；
// onChange(config)：ft8tw.config 有變更時呼叫
// getPtt()：電台控制的 PTT 介面（測試音也鍵 PTT，add-web-rig-control D20）；getDialHz(settings)：撥號頻率（CAT 時是電台實際頻率）
// beforeProfileSwitch()：切換設定組前停止發射、斷開電台；不能切換時回傳原因文字（add-web-profiles P4）；reload()：重新載入頁面
export function initConfigUi({ storage, menu, getSettings, onChange = () => {}, getPtt = () => null, getDialHz = null,
  beforeProfileSwitch = async () => null, reload = () => location.reload(), canReload = () => true, onLockChange = () => {} }) {
  const loaded = loadConfig(storage);
  let config = loaded.config;
  // 不合法的值已退回預設：提示一次並寫回乾淨的設定（spec「不合法值 SHALL 退回預設並提示」）
  if (loaded.invalid.length) {
    $('cfg-invalid').textContent = t('config.invalid', { n: loaded.invalid.length, items: loaded.invalid.map(label).join(t('config.listSep')) });
    $('cfg-invalid').hidden = false;
  }
  if (loaded.invalid.length || (loaded.from !== null && loaded.from !== 1)) saveConfig(storage, config);

  // ── 主選單 ↔ 區段 ──
  let current = null;
  function show(page, { focus = true } = {}) {
    const title = pageTitle(page);
    if (title === null) return;
    current = page;
    $('menu-title').textContent = title;
    $('cfg-home').hidden = page !== null;
    for (const el of document.querySelectorAll('#menu .cfg-page[data-page]')) el.hidden = el.dataset.page !== page;
    $('menu').scrollTop = 0;
    if (!focus) return;
    if (page === null) document.querySelector(`#cfg-home [data-page="${CSS.escape(String(previous))}"]`)?.focus();
    else $(`cfg-page-${page}`).querySelector('.cfg-back').focus();
  }
  let previous = null;
  for (const btn of document.querySelectorAll('#cfg-home [data-page]')) {
    btn.addEventListener('click', () => {
      previous = btn.dataset.page;
      show(btn.dataset.page);
    });
  }
  for (const btn of document.querySelectorAll('#menu .cfg-back')) btn.addEventListener('click', () => show(null));
  // 漢堡鈕打開時回到主選單（initMenu 自己會把焦點移到關閉鈕）
  $('menu-toggle').addEventListener('click', () => {
    if (!$('menu').hidden) show(null, { focus: false });
  });

  // ── i 說明：在卡片下方展開 FT8TW 的說明文字（不用 dialog：Esc 會連抽屜一起關）──
  let helpSeq = 0;
  for (const btn of document.querySelectorAll('#menu .info[data-help]')) {
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => {
      const card = btn.closest('.cfg-card, .cfg-profile');
      let box = card.querySelector(':scope > .cfg-help');
      if (!box) {
        box = Object.assign(document.createElement('div'), { className: 'cfg-help', id: `cfg-help-${++helpSeq}` });
        for (const para of helpParagraphs(helpText(btn.dataset.help))) {
          const p = document.createElement('p');
          for (const part of para) {
            p.append(part.href
              ? Object.assign(document.createElement('a'), { href: part.href, textContent: part.href, target: '_blank', rel: 'noopener' })
              : part.text);
          }
          box.append(p);
        }
        box.hidden = true;
        card.append(box);
        btn.setAttribute('aria-controls', box.id);
      }
      box.hidden = !box.hidden;
      btn.setAttribute('aria-expanded', String(!box.hidden));
    });
  }

  // ── 下拉選項 ──
  const fill = (id, options) => $(id).replaceChildren(...options.map(([v, t]) => new Option(t, String(v))));
  fill('cfg-cq-order', SCHEME_LABELS.map((t, i) => [i, t]));
  fill('cfg-qso-filter', QSO_FILTER_OPTIONS);
  fill('cfg-supervision', SUPERVISION_OPTIONS.map((m) => [m, m === 0 ? t('config.ignore') : t('config.minutes', { n: m })]));
  fill('cfg-no-reply', NO_REPLY_OPTIONS.map((n) => [n, n === 0 ? t('config.ignore') : t('config.times', { n })]));
  fill('cfg-finish-retry', FINISH_RETRY_OPTIONS.map((n) => [n, n === 0 ? t('config.off') : t('config.times', { n })]));
  fill('cfg-time-offset', TIME_OFFSET_OPTIONS.map((ms) => [ms, formatOffset(ms)]));
  fill('cfg-rx-delay', RX_DELAY_OPTIONS.map((ms) => [ms, formatOffset(ms)]));
  fill('cfg-font-size', FONT_SIZES.map((px) => [px, px === CONFIG_DEFAULTS.fontSize ? t('config.fontDefault', { px }) : String(px)]));

  // ── ft8tw.config 的項目：data-cfg="key" ──
  function apply() {
    const root = document.documentElement;
    if (config.theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = config.theme;
    root.style.setProperty('--feed-font', `${config.fontSize}px`);
  }
  function render() {
    for (const el of document.querySelectorAll('#menu [data-cfg]')) {
      const v = config[el.dataset.cfg];
      if (el.type === 'checkbox') el.checked = v;
      else if (el.type === 'radio') el.checked = el.value === String(v);
      else if (Array.isArray(v)) el.value = v.join(', ');
      else el.value = String(v);
    }
    $('cfg-follow-list').replaceChildren(...config.followCallsigns.map((call) => {
      const li = document.createElement('li');
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'chip-del', textContent: '✕' });
      del.setAttribute('aria-label', t('config.unfollow', { call }));
      del.addEventListener('click', () => commit({ followCallsigns: config.followCallsigns.filter((c) => c !== call) }));
      li.append(call, del);
      return li;
    }));
  }
  function commit(patch) {
    config = updateConfig(storage, patch);
    render();
    apply();
    onChange(config);
  }
  for (const el of document.querySelectorAll('#menu [data-cfg]')) {
    const key = el.dataset.cfg;
    if (key === 'cqModifier') continue; // 下面單獨處理：打字時只標錯
    el.addEventListener('change', () => {
      const def = CONFIG_DEFAULTS[key];
      const value = el.type === 'checkbox' ? el.checked : typeof def === 'number' ? Number(el.value) : el.value;
      commit({ [key]: value });
    });
  }
  // CQ 對象：輸入時驗證並標錯，合格才存；離開欄位時寫回正規化後的值
  const modifier = $('cfg-cq-modifier');
  modifier.addEventListener('input', () => {
    const v = normalizeModifier(modifier.value);
    $('cq-modifier-error').textContent = v === null ? t('config.cqModifierError') : '';
    modifier.setAttribute('aria-invalid', String(v === null));
    if (v !== null && v !== config.cqModifier) commit({ cqModifier: v });
  });
  modifier.addEventListener('change', () => {
    if (normalizeModifier(modifier.value) !== null) modifier.value = config.cqModifier;
  });
  // 關注呼號：新增鈕或 Enter
  const addFollow = () => {
    const calls = parseCallList($('cfg-follow-input').value);
    if (calls.length === 0) return;
    commit({ followCallsigns: [...config.followCallsigns, ...calls] });
    $('cfg-follow-input').value = '';
  };
  $('cfg-follow-add').addEventListener('click', addFollow);
  $('cfg-follow-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addFollow();
  });

  // ── 測試音（W2）：先過發射防護，再兩段式確認（測試音會經 VOX 讓電台發射）──
  const toneMsg = (text, isError = false) => {
    $('cfg-tone-msg').textContent = text;
    $('cfg-tone-msg').className = isError ? 'hint error' : 'hint';
  };
  // 發射中（含等待下一個 slot）：tx/ui.mjs 在 body 加上 tx-armed
  const blockReason = () => testToneBlockReason({
    settings: getSettings(), txActive: document.body.classList.contains('tx-armed'), now: Date.now(),
    ...(getDialHz && { dialHz: getDialHz(getSettings()) }),
  });
  const hideConfirm = () => { $('cfg-tone-confirm').hidden = true; };
  let toneOutput = null; // 播放中的測試音輸出（換頻率時停止，code review 2026-10-09）
  let toneStopped = null; // 被停止的原因（i18n 鍵）
  $('cfg-test-tone').addEventListener('click', () => {
    const reason = blockReason();
    if (reason) {
      hideConfirm();
      toneMsg(reason, true);
      return;
    }
    toneMsg('');
    $('cfg-tone-confirm').hidden = false;
    $('cfg-tone-go').focus();
  });
  $('cfg-tone-cancel').addEventListener('click', () => {
    hideConfirm();
    $('cfg-test-tone').focus();
  });
  $('cfg-tone-go').addEventListener('click', async () => {
    hideConfirm();
    const reason = blockReason(); // 確認期間設定可能被改過，再檢查一次
    if (reason) return toneMsg(reason, true);
    $('cfg-test-tone').disabled = true;
    toneMsg(t('config.tonePlaying'));
    try {
      const sinkId = $('tx-device').value;
      toneStopped = null;
      toneOutput = new TxOutput();
      const { sinkApplied } = await playTestTone({ output: toneOutput, sinkId, gain: Number($('tx-gain').value), ptt: getPtt(), stopped: () => toneStopped !== null });
      if (toneStopped) toneMsg(t(toneStopped), true);
      else toneMsg(sinkId && !sinkApplied ? t('config.toneDoneDefault') : t('config.toneDone'));
    } catch (err) {
      toneMsg(t('config.toneFailed', { error: rigErrorText(err) }), true); // 電台錯誤依 code 翻譯（安全審查 #9）
    } finally {
      toneOutput = null;
      $('cfg-test-tone').disabled = false;
      $('cfg-test-tone').focus();
    }
  });

  // ── 設定組（add-web-profiles）：＋ 複製目前那組並切過去、✎ 改名、✕ 刪除；切換＝記下 pending＋重新載入，新頁面開頭才寫入（P3）──
  const profileMsg = (text, isError = false) => {
    $('cfg-profile-msg').textContent = text;
    $('cfg-profile-msg').className = isError ? 'hint error' : 'hint';
  };
  const bar = ['cfg-profile', 'cfg-profile-add', 'cfg-profile-rename', 'cfg-profile-delete'];
  // 設定組列停用（切換中、另一個分頁換了設定組）：同時通知主程式（時間偏差橫幅、取消偏差調整鈕跟著停用，add-dt-offset-advisor D19）
  const setBarDisabled = (on) => {
    for (const id of bar) $(id).disabled = on;
    onLockChange();
  };
  const loadedActive = loadProfiles(storage).active; // 這個頁面載入時的設定組：別的分頁切換了就不能再動作（review #1）
  let editing = null; // 'add'｜'rename'
  let busy = false;
  let returnFocus = null;
  function renderProfiles() {
    const st = loadProfiles(storage);
    $('cfg-profile').replaceChildren(...st.list.map((p) => new Option(displayName(p), String(p.id))));
    $('cfg-profile').value = String(loadedActive);
    // 只剩一組：✕ 仍可按，按了說明「至少需保留一組」（spec）
    $('cfg-profile-delete').setAttribute('aria-disabled', String(st.list.length <= 1));
    return st;
  }
  const hideProfileForms = ({ focus = true } = {}) => {
    editing = null;
    for (const id of ['cfg-profile-edit', 'cfg-profile-del', 'cfg-profile-switch']) $(id).hidden = true;
    $('cfg-profile-name').removeAttribute('aria-invalid');
    if (focus && returnFocus) returnFocus.focus();
    returnFocus = null;
  };
  // 另一個分頁切換了設定組：這頁的記憶體還是舊設定組的值，任何存檔都會串組 → 停用並在安全時重新載入（review #1）
  const staleTab = () => {
    const st = loadProfiles(storage);
    return st.active !== loadedActive || Boolean(st.pending); // pending：別的分頁要切換、正在重新載入
  };
  let staleTimer = null;
  function onStale() {
    if (staleTimer) return;
    hideProfileForms({ focus: false });
    setBarDisabled(true);
    profileMsg(t('config.profileOtherTab'), true);
    const tryReload = () => {
      if (!canReload()) return; // 與強制更新共用的「安全時機」（main.mjs safeToReload，review S1）
      clearInterval(staleTimer);
      reload();
    };
    staleTimer = setInterval(tryReload, 1000);
    onLockChange();
    tryReload();
  }
  window.addEventListener('storage', (e) => {
    if (e.key === 'ft8tw.profiles' && staleTab()) onStale();
  });
  // 切換類動作：先過 beforeProfileSwitch（發射中、測試音、PTT 關沒確定送出就不做），做完重新載入。fn 回傳 false＝不必重新載入
  async function profileAction(fn) {
    if (busy) return false;
    if (staleTab()) return onStale(), false;
    if ($('cfg-test-tone').disabled) { // 測試音播放中（review #6）
      renderProfiles();
      profileMsg(t('config.profileBusyTx'), true);
      return false;
    }
    busy = true;
    setBarDisabled(true);
    try {
      const reason = await beforeProfileSwitch();
      if (reason) {
        renderProfiles();
        profileMsg(reason, true);
        return false;
      }
      let needReload = true;
      try {
        needReload = fn() !== false;
      } catch (err) {
        renderProfiles();
        profileMsg(`${t(errorKey(err))} ${t('config.profileRigOff')}`, true); // 電台已斷開（review D）
        return false;
      }
      if (!needReload) {
        renderProfiles();
        return true;
      }
      profileMsg(t('config.profileSwitching'));
      reload();
      return true;
    } finally {
      busy = false;
      setBarDisabled(false);
    }
  }
  // 選單：選了先確認再切換（鍵盤上下鍵不會直接重新載入，review E）
  $('cfg-profile').addEventListener('change', () => {
    const id = Number($('cfg-profile').value);
    hideProfileForms({ focus: false });
    if (id === loadedActive) return;
    const st = loadProfiles(storage);
    const p = st.list.find((x) => x.id === id);
    if (!p) return renderProfiles();
    $('cfg-profile-switch-msg').textContent = t('config.profileSwitchConfirm', { name: displayName(p) });
    $('cfg-profile-switch').hidden = false;
    $('cfg-profile-switch').dataset.to = String(id);
    returnFocus = $('cfg-profile');
    $('cfg-profile-switch-go').focus();
  });
  $('cfg-profile-switch-go').addEventListener('click', () => {
    const to = Number($('cfg-profile-switch').dataset.to);
    hideProfileForms({ focus: false });
    profileAction(() => requestSwitch(storage, to));
  });
  $('cfg-profile-switch-cancel').addEventListener('click', () => { hideProfileForms(); renderProfiles(); });
  const openEdit = (mode) => {
    hideProfileForms({ focus: false });
    if (staleTab()) return onStale();
    editing = mode;
    returnFocus = $(mode === 'add' ? 'cfg-profile-add' : 'cfg-profile-rename');
    const st = loadProfiles(storage);
    $('cfg-profile-edit-title').textContent = t(mode === 'add' ? 'config.profileAddTitle' : 'config.profileRenameTitle');
    $('cfg-profile-name').value = mode === 'rename' ? displayName(st.list.find((p) => p.id === st.active)) : '';
    $('cfg-profile-edit').hidden = false;
    profileMsg('');
    $('cfg-profile-name').focus();
  };
  $('cfg-profile-add').addEventListener('click', () => openEdit('add'));
  $('cfg-profile-rename').addEventListener('click', () => openEdit('rename'));
  $('cfg-profile-cancel').addEventListener('click', () => { hideProfileForms(); profileMsg(''); });
  const submitEdit = async () => {
    if (staleTab()) return onStale();
    const name = $('cfg-profile-name').value;
    const st = loadProfiles(storage);
    const err = nameError(st, name, editing === 'rename' ? st.active : null);
    if (err) {
      $('cfg-profile-name').setAttribute('aria-invalid', 'true');
      return profileMsg(t(`config.profileErr.${err}`), true);
    }
    if (editing === 'rename') {
      try {
        renameProfile(storage, st.active, name);
      } catch (e) {
        return profileMsg(t(errorKey(e)), true);
      }
      hideProfileForms();
      renderProfiles();
      profileMsg('');
      return;
    }
    hideProfileForms({ focus: false });
    await profileAction(() => { createProfile(storage, name); });
  };
  $('cfg-profile-ok').addEventListener('click', submitEdit);
  $('cfg-profile-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) submitEdit(); // 中文輸入法選字的 Enter 不送出（review #9）
  });
  // 表單裡按 Escape 只關表單，不關整個抽屜（review F）
  for (const id of ['cfg-profile-edit', 'cfg-profile-del', 'cfg-profile-switch']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      hideProfileForms();
      renderProfiles();
    });
  }
  $('cfg-profile-delete').addEventListener('click', () => {
    hideProfileForms({ focus: false });
    if (staleTab()) return onStale();
    const st = loadProfiles(storage);
    if (st.list.length <= 1) return profileMsg(t('config.profileErr.last'), true);
    returnFocus = $('cfg-profile-delete');
    $('cfg-profile-del-msg').textContent = t('config.profileDeleteConfirm', { name: displayName(st.list.find((p) => p.id === st.active)) });
    $('cfg-profile-del').hidden = false;
    $('cfg-profile-del-go').focus();
  });
  $('cfg-profile-del-cancel').addEventListener('click', () => hideProfileForms());
  $('cfg-profile-del-go').addEventListener('click', () => {
    hideProfileForms({ focus: false });
    profileAction(() => requestDelete(storage, loadedActive));
  });
  // 紫色條紋：隨設定組的欄位（P9；範圍見 profiles.mjs WHOLE_KEYS／SCOPED_CONFIG）
  for (const [sel, scope] of [
    ['#callsign', '.cfg-line'], ['#grid', '.cfg-line'], ['#band', '.cfg-line'], ['input[name="mode"]', '.cfg-line'], ['#rig-card', null],
    ['#device', '.cfg-line'], ['#tx-freq', '.cfg-line'], ['#tx-device', '.cfg-line'], ['#tx-gain', '.cfg-card'], ['#cfg-cq-order', '.cfg-line'],
    ['#cfg-supervision', '.cfg-line'], ['#cfg-no-reply', '.cfg-line'], ['#cfg-finish-retry', '.cfg-line'], ['#cfg-psk-spots', '.cfg-line'],
    ['#cfg-rx-delay', '.cfg-line'], // 收訊音訊延遲（add-dt-offset-advisor D15）
  ]) {
    const el = document.querySelector(sel);
    (scope ? el?.closest(scope) ?? el?.closest('fieldset') : el)?.classList.add('profile-scoped');
  }
  renderProfiles();
  // 開頁時完成切換失敗（boot.mjs，例如儲存空間不足）：提示
  if (profileBoot?.error) profileMsg(t('config.profileErr.save'), true);

  // ── 線上地圖來源（add-map-tile-source S10）：內建來源點了就存；自訂要有合法網址（已存的或按「套用」驗證通過）才切過去 ──
  const tileRadios = [...document.querySelectorAll('#cfg-tile-card input[name="cfg-tile-source"]')];
  const tileUrl = $('cfg-tile-url');
  const tileAttr = $('cfg-tile-attribution');
  let tilePending = false; // 選了「自訂」但還沒有合法網址：地圖仍用原本的來源
  const tileMsg = (text) => { $('cfg-tile-msg').textContent = text; };
  const markTile = (input, errorId, key) => {
    $(errorId).textContent = key ? t(key) : '';
    input.setAttribute('aria-invalid', String(Boolean(key)));
  };
  const urlErrKey = (v) => { const e = validateTileTemplate(v); return e ? `config.tileErr.${e}` : null; };
  const attrErrKey = (v) => { const e = validateTileAttribution(v); return e ? `config.tileErr.attr${e[0].toUpperCase()}${e.slice(1)}` : null; };
  function renderTile() {
    const shown = tilePending ? 'custom' : config.mapTileSource;
    for (const r of tileRadios) r.checked = r.value === shown;
    $('cfg-tile-custom').hidden = shown !== 'custom';
  }
  tileUrl.value = config.mapTileUrl;
  tileAttr.value = config.mapTileAttribution;
  // 已存「自訂」但網址是空的（不合法被退回）：地圖用 EOX 2025，這裡提示要填
  if (config.mapTileSource === 'custom' && !config.mapTileUrl) tileMsg(t('config.tileNeedUrl'));
  for (const r of tileRadios) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      if (r.value !== 'custom') {
        tilePending = false;
        tileMsg('');
        commit({ mapTileSource: r.value });
      } else if (config.mapTileUrl && validateTileTemplate(config.mapTileUrl) === null) {
        tilePending = false;
        commit({ mapTileSource: 'custom' });
        tileMsg(t('config.tileApplied'));
      } else {
        tilePending = true;
        tileMsg(t('config.tileNeedUrl'));
      }
      renderTile();
      if (tilePending) tileUrl.focus();
    });
  }
  // 打字時只標錯（空的不標，按「套用」才提示要填）
  tileUrl.addEventListener('input', () => markTile(tileUrl, 'cfg-tile-url-error', tileUrl.value === '' ? null : urlErrKey(tileUrl.value)));
  tileAttr.addEventListener('input', () => markTile(tileAttr, 'cfg-tile-attribution-error', attrErrKey(tileAttr.value)));
  $('cfg-tile-apply').addEventListener('click', () => {
    const urlKey = urlErrKey(tileUrl.value);
    const attrKey = attrErrKey(tileAttr.value);
    markTile(tileUrl, 'cfg-tile-url-error', urlKey);
    markTile(tileAttr, 'cfg-tile-attribution-error', attrKey);
    if (urlKey || attrKey) {
      tileMsg('');
      (urlKey ? tileUrl : tileAttr).focus();
      return;
    }
    tilePending = false;
    commit({ mapTileSource: 'custom', mapTileUrl: tileUrl.value, mapTileAttribution: tileAttr.value.trim() });
    tileAttr.value = config.mapTileAttribution;
    renderTile();
    tileMsg(t('config.tileApplied'));
  });
  renderTile();

  // ── 關於 ──
  $('cfg-version').textContent = t('config.version', { version: displayVersion(APP_VERSION), built: BUILD_TIME });

  // ── 更新歷程（使用者 2026-10-09）：另開一頁；關於頁一行連結過去。新的在上面，最新一筆預設展開 ──
  $('cfg-about-issues').href = webIssueUrl(WEB_VERSION); // 網頁版 issue 範本、預填版本號（使用者 2026-10-09）
  $('cfg-changelog-current').textContent = t('config.changelogCurrent', { version: WEB_VERSION });
  const changelogLink = $('cfg-about-changelog');
  changelogLink.textContent = t('config.changelogLink', { version: WEB_VERSION });
  changelogLink.addEventListener('click', () => {
    previous = 'changelog'; // 返回主選單時焦點落在「更新歷程」
    show('changelog');
  });
  const changelogList = $('cfg-changelog');
  CHANGELOG.forEach((entry, i) => {
    const details = document.createElement('details');
    details.open = i === 0;
    const summary = document.createElement('summary');
    summary.textContent = releaseLabel(entry) ?? t('config.changelogUpcoming');
    if (entry.date) {
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = entry.date;
      summary.append(date);
    }
    // 版號可選取複製（使用者 2026-10-09）：拖曳選取版號放開時不要切換展開／收合
    summary.addEventListener('click', (e) => {
      const sel = getSelection();
      if (sel && !sel.isCollapsed && summary.contains(sel.anchorNode)) e.preventDefault();
    });
    const ul = document.createElement('ul');
    for (const text of releaseItems(entry, locale)) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.append(li);
    }
    details.append(summary, ul);
    changelogList.append(details);
  });
  // 全部展開／全部收合（使用者 2026-10-09）
  const setAllChangelog = (open) => { for (const d of changelogList.querySelectorAll('details')) d.open = open; };
  $('cfg-changelog-expand').addEventListener('click', () => setAllChangelog(true));
  $('cfg-changelog-collapse').addEventListener('click', () => setAllChangelog(false));

  // ── 語言（使用者 2026-10-07）：存在 ft8tw.config 的 language，改了就存設定並重新載入頁面（i18n setLanguage）──
  // 不走 data-cfg／commit：語系要在所有模組載入之前決定，重新載入最單純可靠
  const language = $('cfg-language');
  language.value = languagePref;
  language.addEventListener('change', () => setLanguage(language.value));
  // 抽屜標題右邊的快速切換（同一個設定）
  const quick = $('menu-language');
  if (quick) {
    quick.value = languagePref;
    quick.addEventListener('change', () => setLanguage(quick.value));
  }

  // ── 主頁摘要列：點了開抽屜到「基本資訊」──
  $('settings-bar')?.addEventListener('click', () => open('basic')); // 摘要列已移到頁首（2026-10-06），保留相容
  function open(page = null) {
    menu.open();
    previous = page;
    show(page);
  }

  render();
  apply();
  return {
    get: () => config,
    // 其他區塊（底部「自動」勾選、右鍵「關注」）改設定一律走這裡：同步更新記憶體中的設定與畫面，
    // 直接寫 localStorage 會在下次設置頁存檔時被舊值蓋掉
    update: (patch) => commit(patch),
    spotsEnabled: () => config.pskSpots,
    // 換頻率、換模式：停止播放中的測試音（停止音訊後 playTestTone 照常送 PTT 關、關閉輸出）
    stopTestTone() {
      if (!toneOutput) return false;
      toneStopped = 'config.toneStoppedFreq';
      toneOutput.stop?.();
      return true;
    },
    open,
    profileBusy: () => busy, // 設定組切換第一段進行中（強制更新要等，review S2）
    locked: () => busy || staleTimer !== null, // 切換中或另一個分頁換了設定組：不可改設定
    updateSummary(settings) {
      renderSummary($('settings-summary'), settings);
    },
  };
}
