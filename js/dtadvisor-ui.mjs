// 時間偏差提醒橫幅（add-dt-offset-advisor D11、D19）：#dt-banner，與 #update-banner 分開、可同時出現。
// render(advice, { locked })：advice 為 null 或 locked（設定組切換中、另一個分頁換了設定組）時隱藏並停用按鈕；
// 否則顯示建議文字與「套用」「忽略」（時鐘未校準的提示只有「忽略」）。按鈕回呼拿到目前顯示的建議。
// 無障礙：文字在獨立的 role=status（#dt-banner-text），按鈕不在 live region 裡；橫幅出現時先清空、延後再填文字，
// 同樣文字再出現也會重念；套用／忽略後橫幅隱藏，焦點移到 focusTarget（主內容），不掉到 body。
import { adviceText } from './dtadvisor.mjs';

export function initDtBanner({ el, text, apply, ignore, onApply, onIgnore, focusTarget = null, defer = (fn) => setTimeout(fn, 150) }) {
  let current = null;
  let shown = false;
  let token = 0; // 延後填字時確認還是同一次顯示
  const act = (fn) => () => {
    if (!current || apply.disabled) return;
    fn(current);
    focusTarget?.focus();
  };
  apply.addEventListener('click', () => { if (current?.kind !== 'unsynced') act(onApply)(); });
  ignore.addEventListener('click', act(onIgnore));
  return (advice, { locked = false } = {}) => {
    current = locked ? null : advice;
    apply.disabled = locked;
    ignore.disabled = locked;
    el.hidden = !current;
    if (!current) {
      shown = false;
      token += 1;
      text.textContent = '';
      return;
    }
    apply.hidden = current.kind === 'unsynced'; // 時鐘未校準：沒有可套用的
    const s = adviceText(current);
    if (!shown) {
      shown = true;
      const my = ++token;
      text.textContent = '';
      defer(() => { if (my === token) text.textContent = s; });
    } else if (text.textContent !== s) {
      token += 1;
      text.textContent = s; // 顯示中文字變了：直接換（live region 會念新的）；沒變不重設、不重念
    }
  };
}
