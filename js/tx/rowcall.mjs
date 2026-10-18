// 從解碼清單呼叫（add-web-transmit D13）：雙擊一列就呼叫；單擊只選取（呼叫區塊另有「呼叫選取的電台」鍵）。
// 手機長按與右鍵改開選單（qso/contextmenu.mjs，使用者 2026-10-06，同 FT8TW 長按選單），不直接呼叫。列的資料由 getData(tr) 提供（{ text, snr, freqHz, timeSec, startUtc, mode }）。
export function initRowCall(tbody, { getData, onCall, onSelect = () => {} }) {
  let selected = null;

  const rowOf = (target) => {
    const tr = target?.closest?.('tr');
    return tr && tbody.contains(tr) && getData(tr) ? tr : null;
  };
  const select = (tr) => {
    selected?.classList.remove('selected');
    selected?.removeAttribute('aria-selected');
    selected = tr;
    tr.classList.add('selected');
    tr.setAttribute('aria-selected', 'true');
    onSelect(getData(tr));
  };

  tbody.addEventListener('click', (e) => {
    const tr = rowOf(e.target);
    if (tr && !getData(tr).own) select(tr); // 我方發射的列不選取（「呼叫選取的電台」不會變成呼叫自己）
  });
  tbody.addEventListener('dblclick', (e) => {
    const tr = rowOf(e.target);
    if (tr && !getData(tr).own) onCall(getData(tr)); // 我方發射的那列不呼叫（呼叫自己沒意義；右鍵選單仍可呼叫接收方）
  });
  return { selected: () => (selected ? getData(selected) : null) };
}
