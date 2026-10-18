// 電台卡下方的通聯進度 Dashboard 畫面（使用者 2026-10-07，參考 S20）。狀態判斷在 callpanel.mjs（有單元測試）。
// getState()：{ target（呼號或 null）, order（1–6）, active（發射開著）}，通聯狀態一變就呼叫 update()
import { CallPanelModel } from './callpanel.mjs';
import { t } from '../i18n/index.mjs';

const LABELS = ['dash.grid', 'dash.report', 'dash.rReport', 'dash.rr73', 'dash.73'];
const MARKS = { done: '✓', current: '●', todo: '○' };

export function initQsoDashboard({ getState, doc = document }) {
  const box = doc.getElementById('qso-dash');
  if (!box) return { update() {} };
  const model = new CallPanelModel();
  const stages = doc.getElementById('qso-dash-stages');
  let last = '';
  function update() {
    const { target = null, order = null, active = false } = getState() ?? {};
    model.update(target, order, active);
    const key = JSON.stringify([model.mode, model.callsign, model.lastOrder]);
    if (key === last) return;
    last = key;
    const idle = model.mode === 'stopped' && model.callsign === null;
    box.hidden = idle;
    if (idle) return;
    doc.getElementById('qso-dash-call').textContent = model.callsign ?? '';
    doc.getElementById('qso-dash-state').textContent =
      model.mode === 'cq' ? t('dash.cq') : model.mode === 'completed' ? t('dash.completed') : model.mode === 'stopped' ? t('dash.stopped') : '';
    // CQ 中沒有對象：不顯示階段列（同 FT8TW）
    stages.hidden = model.mode === 'cq';
    stages.replaceChildren(...model.steps().map((step, i) => {
      const li = doc.createElement('li');
      li.className = step;
      li.append(Object.assign(doc.createElement('span'), { className: 'mark', textContent: MARKS[step] }), t(LABELS[i]));
      li.setAttribute('aria-label', t('dash.stepAria', { stage: t(LABELS[i]), state: t(`dash.${step}`) }));
      return li;
    }));
  }
  update();
  return { update };
}
