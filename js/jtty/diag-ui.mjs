// JTTY 收訊診斷的畫面（控制分頁 #jtty-diag，使用者 2026-10-10）：只負責 DOM，規則與統計在 diag.mjs（純函式，webtest 覆蓋），
// 以真瀏覽器檢查（tools/ui-jtty-check.mjs）驗證。有新資料時節流重畫（1 s），區塊看不到時不畫、等出現再畫。
import { summarize, serializeSnapshot, frameDots } from './diag.mjs';
import { formatUtcTenths } from '../format.mjs';

const THROTTLE_MS = 1000;
const TEXT_MAX = 40;

const range = (a, b) => (a === null ? '—' : a === b ? String(a) : `${a}～${b}`);

// diag：JttyDiag；t：翻譯；notify：狀態列；extra()：複製時附加的欄位（版本）；clipboard()：navigator.clipboard（檢查可換替身）
export function initJttyDiagPanel({ diag, t, notify = () => {}, extra = () => ({}), clipboard = () => navigator.clipboard }) {
  const $ = (id) => document.getElementById(id);
  const root = $('jtty-diag');
  if (!root) return { refresh() {}, schedule() {} };
  const causesEl = $('jtty-diag-causes');
  const statsEl = $('jtty-diag-stats');
  const msgsEl = $('jtty-diag-msgs');
  let timer = null;
  let dirty = true;

  const visible = () => root.offsetParent !== null && root.getClientRects().length > 0;
  const li = (text, cls = '') => {
    const el = document.createElement('li');
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };

  function refresh() {
    timer = null;
    if (!visible()) {
      dirty = true;
      return;
    }
    dirty = false;
    const { messages, stats, causes } = summarize(diag.snapshot());
    causesEl.replaceChildren(...causes.map((c) => li(t(`jtty.diag.rule.${c.key}`, c.params), `cause-${c.key}`)));
    statsEl.textContent = t('jtty.diag.stats', {
      windows: stats.windows, avg: stats.rttAvg ?? '—', max: stats.rttMax ?? '—', dropped: stats.dropped, skipped: stats.skipped,
      hidden: stats.hiddenPct, gaps: stats.gaps, rms: range(stats.rmsMin, stats.rmsMax),
    });
    if (!messages.length) {
      msgsEl.replaceChildren(li(t('jtty.diag.no_messages'), 'hint'));
      return;
    }
    msgsEl.replaceChildren(...messages.map((m) => {
      const el = document.createElement('li');
      el.className = `diag-msg end-${m.end}${m.missing ? ' has-gap' : ''}`;
      const head = document.createElement('div');
      const text = m.text.length > TEXT_MAX ? `${m.text.slice(0, TEXT_MAX)}…` : m.text;
      head.textContent = `${Number.isFinite(m.t0) ? formatUtcTenths(m.t0) : '—'}  ${m.freqHz ?? '—'} Hz  ${text}`;
      const dots = document.createElement('div');
      dots.className = 'diag-dots';
      dots.textContent = frameDots(m);
      const detail = document.createElement('div');
      detail.className = 'hint';
      const gaps = m.gaps.length ? m.gaps.map((g) => t('jtty.diag.gap', { after: g.after + 1, missing: g.missing })).join('、') : t('jtty.diag.no_gap');
      detail.textContent = t('jtty.diag.msg', { n: m.frames.length, gaps, snr: range(m.snrMin, m.snrMax), end: t(`jtty.diag.end.${m.end}`) })
        + (m.driftHz > 3 ? `；${t('jtty.diag.drift', { hz: m.driftHz })}` : '')
        + (m.repaired ? `；${t('jtty.repaired', { n: m.repaired })}` : '');
      el.append(head, dots, detail);
      return el;
    }));
  }

  function schedule() {
    if (timer === null) timer = setTimeout(refresh, THROTTLE_MS);
  }

  // 切到控制分頁（或捲到這裡）時，有沒畫的資料就畫
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && dirty) refresh();
    }).observe(root);
  }

  $('jtty-diag-copy').addEventListener('click', async () => {
    try {
      await clipboard().writeText(serializeSnapshot(diag.snapshot(), extra()));
      notify(t('jtty.diag.copied'));
    } catch {
      notify(t('jtty.diag.copy_failed'));
    }
  });

  refresh();
  return { refresh, schedule };
}
