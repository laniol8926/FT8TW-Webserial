// 「取消偏差調整」按鈕（add-dt-offset-advisor D21）：收訊音訊延遲 ≠ 0 時顯示（桌機在右側狀態列的時槽秒數旁，手機在紫色頂列上方的細列）。
// 按下先在原地展開確認列（不用瀏覽器 confirm()），按「歸零」才回呼 onConfirm（主程式經 configUi.update 把延遲設 0）。
// roots：每個位置一組 { ctl, button, confirm, msg, yes, no, label? }；render(rxDelayMs, { locked })。
import { formatOffset } from './format.mjs';
import { t } from './i18n/index.mjs';

export function initRxDelayCancel({ roots, onConfirm, focusTarget = null }) {
  let delayMs = 0;
  let locked = false;
  const close = (r) => {
    r.confirm.hidden = true;
    r.button.hidden = false;
  };
  for (const r of roots) {
    r.button.addEventListener('click', () => {
      if (!delayMs || locked) return;
      r.msg.textContent = t('dtadvisor.cancelConfirm', { delay: formatOffset(delayMs) });
      r.button.hidden = true;
      r.confirm.hidden = false;
      r.yes.focus();
    });
    r.no.addEventListener('click', () => {
      close(r);
      r.button.focus();
    });
    r.confirm.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      close(r);
      r.button.focus();
    });
    r.yes.addEventListener('click', () => {
      if (!delayMs || locked || r.confirm.hidden) return;
      close(r);
      onConfirm();
      focusTarget?.focus(); // 按鈕隨即隱藏：焦點移到主內容
    });
  }
  return (ms, { locked: lock = false } = {}) => {
    const changed = ms !== delayMs || lock !== locked;
    delayMs = ms || 0;
    locked = lock;
    const delay = formatOffset(delayMs);
    for (const r of roots) {
      r.ctl.hidden = !delayMs || locked;
      if (changed) close(r); // 延遲變了或鎖住：收起確認列（確認的是舊值）
      r.button.title = t('dtadvisor.cancelTitle', { delay });
      if (r.label) r.label.textContent = t('dtadvisor.current', { delay });
    }
  };
}
