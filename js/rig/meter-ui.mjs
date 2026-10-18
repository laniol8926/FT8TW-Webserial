// 主畫面電台資訊組的 DOM（add-rig-meters M1～M3）：電腦版摘要列 #rig-meters、手機紫色頂列 .pbar-rig 各一份。
// 子元素只建一次，之後只改有變的文字／屬性（不每秒重建）。規則在 meter-view.mjs（有單元測試）；這裡以 tools/ui-rigmeter-check.mjs 驗證。
import { t } from '../i18n/index.mjs';

function build(root) {
  const mk = (cls) => {
    const el = document.createElement('span');
    el.className = cls;
    return el;
  };
  const parts = { dot: mk('rm-dot'), model: mk('rm-model'), freq: mk('rm-freq'), s: mk('rm-s'), swr: mk('rm-swr') };
  parts.dot.setAttribute('role', 'img');
  parts.model.setAttribute('translate', 'no');
  root.replaceChildren(...Object.values(parts));
  return parts;
}

const setText = (el, text) => {
  el.hidden = !text;
  if (el.textContent !== (text ?? '')) el.textContent = text ?? '';
};
const setAttr = (el, name, value) => {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};

export function createMeterUi(roots) {
  const items = [...roots].filter(Boolean).map((root) => ({ root, parts: build(root) }));
  return {
    // view：meterView() 的結果；null＝整組隱藏
    render(view) {
      for (const { root, parts } of items) {
        root.hidden = !view;
        if (!view) continue;
        const state = view.connected ? t('rig.meters.connected') : t('rig.meters.disconnected');
        root.classList.toggle('rm-on', view.connected);
        parts.dot.hidden = !view.dot; // VOX 沒有狀態點
        setAttr(parts.dot, 'aria-label', state);
        setAttr(parts.dot, 'title', view.model ? `${view.model} · ${state}` : state);
        setText(parts.model, view.model);
        // 只有電台被調離選的頻率時才有（add-web-frequency-list）：標「電台」與說明
        setText(parts.freq, view.freq && t('rig.meters.moved', { freq: view.freq }));
        parts.freq.classList.toggle('rm-moved', Boolean(view.freq));
        setAttr(parts.freq, 'title', t('rig.meters.freqMoved'));
        setText(parts.s, view.s);
        setAttr(parts.s, 'title', view.uncalibrated ? t('rig.meters.uncalibrated') : t('rig.meters.smeter'));
        setText(parts.swr, view.swr);
        parts.swr.classList.toggle('rm-high', view.swrHigh);
      }
    },
  };
}
