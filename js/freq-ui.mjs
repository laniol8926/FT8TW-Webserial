// 頻率下拉與頻率表編輯框的 DOM（add-web-frequency-list）：摘要列 #freq-select、手機紫色頂列 .pbar-freqsel、設置 › 載波頻段 #band
// 都是同一份選項（目前模式的頻率表，依波段分組、常用在前加 ★），選了就 settingsUi.setDial()；編輯框改頻率表走 settingsUi.setTable()。
// 規則在 freqlist.mjs（有單元測試）；這裡以 tools/ui-freqlist-check.mjs 驗證。
import { t } from './i18n/index.mjs';
import { formatMHz, groupTable, optionText, removeEntry, setMarked, upsertEntry, validateEntry } from './freqlist.mjs';
import { bandOf } from './bands.mjs';

const $ = (id) => document.getElementById(id);

function buildOptions(select, list) {
  select.replaceChildren(...groupTable(list).map(({ band, items }) => {
    const g = document.createElement('optgroup');
    g.label = band;
    g.append(...items.map((e) => new Option(optionText(e), String(e.hz))));
    return g;
  }));
}

// confirm：恢復預設前確認（測試可換掉）
export function initFreqUi({ settingsUi, confirm = (msg) => globalThis.confirm(msg) }) {
  const selects = () => [$('freq-select'), $('band'), ...document.querySelectorAll('.pbar-freqsel')].filter(Boolean);
  let builtKey = '';

  // 設定變了（選頻率、換模式、頻率表改了、設定組）：選項有變才重建，再選到目前的頻率
  function sync(s = settingsUi.get()) {
    const list = settingsUi.table(s.mode);
    const key = `${s.mode}|${JSON.stringify(list)}`;
    for (const sel of selects()) {
      if (key !== builtKey || !sel.options.length) buildOptions(sel, list);
      sel.value = String(s.dialHz);
      sel.title = t('freq.select_title');
    }
    builtKey = key;
    $('dial').textContent = t('freq.hint', { mode: s.mode });
    if ($('freqtable-dialog').open) renderList();
  }
  for (const sel of selects()) sel.addEventListener('change', () => settingsUi.setDial(Number(sel.value)));

  // ── 頻率表編輯框 ──
  const dialog = $('freqtable-dialog');
  let mode = 'FT8';
  let editing = null; // 修改中的那一筆 hz；null＝新增

  function setEditing(hz) {
    editing = hz;
    const e = hz === null ? null : settingsUi.table(mode).find((x) => x.hz === hz);
    $('freqtable-mhz').value = e ? formatMHz(e.hz) : '';
    $('freqtable-marked').checked = Boolean(e?.marked);
    $('freqtable-save').textContent = t(e ? 'freq.save' : 'freq.add');
    $('freqtable-cancel').hidden = !e;
    say('');
  }

  // 表單下方的訊息：錯誤紅字、成功一般字
  function say(text, error = false) {
    $('freqtable-error').textContent = text;
    $('freqtable-error').classList.toggle('error', error);
  }

  function button(label, aria, onClick, disabled = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderList() {
    const list = settingsUi.table(mode);
    const items = [];
    for (const { band, items: group } of groupTable(list)) {
      const head = document.createElement('li');
      head.className = 'freqtable-band';
      head.textContent = band;
      items.push(head);
      for (const e of group) {
        const mhz = `${formatMHz(e.hz)} MHz`;
        const li = document.createElement('li');
        li.className = 'freqtable-row';
        li.dataset.hz = String(e.hz);
        const name = document.createElement('span');
        name.className = 'freqtable-freq';
        name.textContent = mhz;
        const mark = document.createElement('label');
        mark.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = e.marked;
        box.setAttribute('aria-label', t('freq.markedOf', { freq: mhz }));
        box.addEventListener('change', () => settingsUi.setTable(mode, setMarked(settingsUi.table(mode), e.hz, box.checked)));
        mark.append(box, ' ★');
        li.append(name, mark,
          button(t('freq.edit'), t('freq.editOf', { freq: mhz }), () => {
            setEditing(e.hz);
            $('freqtable-mhz').focus();
          }),
          button(t('freq.delete'), t('freq.deleteOf', { freq: mhz }), () => {
            if (editing === e.hz) setEditing(null);
            settingsUi.setTable(mode, removeEntry(settingsUi.table(mode), e.hz));
          }, list.length <= 1));
        items.push(li);
      }
    }
    $('freqtable-list').replaceChildren(...items);
  }

  function selectMode(m) {
    mode = m;
    $('freqtable-mode').value = m;
    setEditing(null);
    renderList();
  }

  $('freqtable-open').addEventListener('click', () => {
    selectMode(settingsUi.get().mode);
    dialog.showModal();
    $('freqtable-mhz').focus();
  });
  $('freqtable-mode').addEventListener('change', () => selectMode($('freqtable-mode').value));
  $('freqtable-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const list = settingsUi.table(mode);
    const v = validateEntry(list, $('freqtable-mhz').value, editing);
    if (!v.ok) {
      say(t(`freq.error.${v.error}`), true);
      return;
    }
    settingsUi.setTable(mode, upsertEntry(list, { hz: v.hz, marked: $('freqtable-marked').checked }, editing), { replacing: editing, hz: v.hz });
    setEditing(null);
    say(t('freq.saved', { freq: `${bandOf(v.hz)} ${formatMHz(v.hz)} MHz` }));
  });
  $('freqtable-cancel').addEventListener('click', () => setEditing(null));
  $('freqtable-reset').addEventListener('click', () => {
    if (!confirm(t('freq.resetConfirm', { mode }))) return;
    setEditing(null);
    settingsUi.setTable(mode, null);
  });
  $('freqtable-close').addEventListener('click', () => dialog.close());

  sync();
  return { sync };
}
