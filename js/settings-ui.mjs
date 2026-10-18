// 設定畫面（tasks 4.3）：呼號、網格（含「用目前位置」）、模式、各模式選的撥號頻率。改了就驗證並存到 localStorage。
// 頻率（add-web-frequency-list）：頻率表（全域 ft8tw.bands）也在這裡讀寫，選的頻率一定在目前模式的清單裡（D5）；
// 頻率下拉與編輯框的 DOM 在 freq-ui.mjs，經 setDial()、setTable() 改設定。
import { t } from './i18n/index.mjs';
import { locateGrid } from './geolocate.mjs';
import { loadSettings, saveSettings, validateSettings, withDial } from './settings.mjs';
import { BANDS_KEY, FREQ_MODES, applyTableEdit, loadTables, pickForMode, remapSelected, resolveSelected, tableFor } from './freqlist.mjs';

const $ = (id) => document.getElementById(id);

// onChange(settings)：設定有效變更後呼叫；回傳 get() 取目前設定。win：監聽 storage 事件（別的分頁改了頻率表）
export function initSettingsUi({ storage, geolocation, onChange = () => {}, win = globalThis }) {
  let tables = loadTables(storage);
  let current = loadSettings(storage);
  // 選的頻率不在本機的頻率表（別的設定組選的、表被改過）：退回同波段常用（D5）
  const resolved = resolveSelected(tableFor(tables, current.mode), current.dialHz, current.mode);
  if (resolved !== current.dialHz) {
    current = withDial({ ...current, freqByMode: { ...current.freqByMode, [current.mode]: resolved } });
    saveSettings(storage, current);
  }

  $('callsign').value = current.callsign;
  $('grid').value = current.grid;
  for (const radio of document.querySelectorAll('input[name=mode]')) radio.checked = radio.value === current.mode;

  function commit(next) {
    current = withDial(next);
    saveSettings(storage, current);
    onChange(current);
  }

  // 每個（目前或選過的）模式的選擇都要在它的清單裡（D5）
  function resolveAll(freqByMode) {
    const out = { ...freqByMode };
    for (const m of FREQ_MODES) {
      if (m === current.mode || out[m]) out[m] = resolveSelected(tableFor(tables, m), out[m], m);
    }
    return out;
  }

  // 別的分頁改了頻率表（ft8tw.bands 全域共用）：重新讀、選擇不在清單就退回，選單跟著重建（code review 2026-10-09）
  win.addEventListener?.('storage', (e) => {
    if (e.key !== BANDS_KEY && e.key !== null) return; // null：別的分頁 localStorage.clear()
    tables = loadTables(storage);
    const freqByMode = resolveAll(current.freqByMode);
    if (FREQ_MODES.some((m) => freqByMode[m] !== current.freqByMode[m])) commit({ ...current, freqByMode });
    else onChange(current);
  });

  // 換模式：帶入該模式上次選的頻率，沒有就目前波段的常用（D4）
  function withMode(mode) {
    if (mode === current.mode) return current;
    const hz = pickForMode(current.freqByMode, mode, tableFor(tables, mode), current.dialHz);
    return { ...current, mode, freqByMode: { ...current.freqByMode, [mode]: hz } };
  }

  function onIdentityInput() {
    const { errors, value } = validateSettings({ callsign: $('callsign').value, grid: $('grid').value });
    for (const field of ['callsign', 'grid']) {
      $(`${field}-error`).textContent = errors[field] ?? '';
      $(field).setAttribute('aria-invalid', errors[field] ? 'true' : 'false');
    }
    // 逐欄儲存：一欄有錯時，另一欄合格的修改照樣保存（有錯的那欄維持上次的有效值）
    const valid = Object.fromEntries(['callsign', 'grid'].filter((f) => !errors[f]).map((f) => [f, value[f]]));
    if (Object.entries(valid).some(([f, v]) => current[f] !== v)) commit({ ...current, ...valid });
  }

  // 輸入時只標錯，離開欄位才把正規化後的值寫回（避免打字時游標亂跳）
  for (const field of ['callsign', 'grid']) {
    $(field).addEventListener('input', onIdentityInput);
    $(field).addEventListener('change', () => {
      const { errors, value } = validateSettings({ callsign: $('callsign').value, grid: $('grid').value });
      if (!errors[field]) $(field).value = value[field];
    });
  }

  $('device').addEventListener('change', () => commit({ ...current, deviceId: $('device').value }));
  for (const radio of document.querySelectorAll('input[name=mode]')) {
    radio.addEventListener('change', () => commit(withMode(radio.value)));
  }

  // 只在按下時才定位（D13：開網頁不詢問位置權限）
  $('locate').addEventListener('click', async () => {
    $('locate').disabled = true;
    $('locate-msg').textContent = t('page.settings.locating');
    try {
      const { grid } = await locateGrid(geolocation, { permissions: navigator.permissions, isSecureContext: window.isSecureContext });
      $('grid').value = grid;
      onIdentityInput();
      $('locate-msg').textContent = t('page.settings.located', { grid });
    } catch (err) {
      $('locate-msg').textContent = err.message;
    } finally {
      $('locate').disabled = false;
    }
  });

  return {
    get: () => current,
    // 自動偵測選好裝置與模式後寫回設定與畫面（tasks 4.4）
    choose({ deviceId, mode }) {
      if (deviceId !== undefined) $('device').value = deviceId;
      if (mode) for (const radio of document.querySelectorAll('input[name=mode]')) radio.checked = radio.value === mode;
      commit({ ...(mode ? withMode(mode) : current), ...(deviceId !== undefined && { deviceId }) });
    },
    // 目前模式的頻率表（mode 省略＝目前模式）
    table: (mode = current.mode) => tableFor(tables, mode),
    // 頻率下拉選了頻率（必須在目前模式的清單裡）
    setDial(hz) {
      if (hz === current.dialHz || !tableFor(tables, current.mode).some((e) => e.hz === hz)) return;
      commit({ ...current, freqByMode: { ...current.freqByMode, [current.mode]: hz } });
    },
    // 頻率表編輯：list＝該模式的完整清單；null＝恢復預設。選的頻率被刪掉就退回同波段常用（D5）；
    // edit：{ replacing, hz }＝修改了哪一筆，改的正是選中的就跟著選新值（code review 2026-10-09）。
    // 存檔前重新讀 storage（別的分頁改了其他模式不被蓋掉）
    setTable(mode, list, edit = null) {
      tables = applyTableEdit(storage, mode, list);
      const remapped = list && edit ? remapSelected(current.freqByMode, mode, edit.replacing, edit.hz) : current.freqByMode;
      commit({ ...current, freqByMode: resolveAll(remapped) });
    },
  };
}
