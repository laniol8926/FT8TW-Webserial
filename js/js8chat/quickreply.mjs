// 長按 JS8 泡泡的回覆選項（design D14；移植 FT8TW Js8QuickReply.build）。純函式，不碰 DOM。
//
// 判斷依據是解碼當下記下的 isHeartbeat／isCq／directedCmd，不從 text 反推（自由文字裡也可能有 CQ、HB 字樣）。
// 舊紀錄沒有這些欄位時只會退回通用選項（呼叫他、SNR、73），不會給錯。
// 前兩項固定「呼叫他」、回 SNR（每種訊息位置都一樣，靠肌肉記憶按）；之後才是依型態最貼切的句子。
// 選項只填入輸入框、不直接發射（由呼叫端負責）。

// directed 指令值（對照 web/js/js8/varicode.mjs DIRECTED_CMDS）
const CMD = Object.freeze({
  SNR_QUERY: 0, HEARING_QUERY: 3, GRID_QUERY: 4, STATUS_QUERY: 6, INFO_QUERY: 16, HW_CPY_QUERY: 19,
  QSL_QUERY: 22, SNR_REPORT: 25, HEARTBEAT_SNR: 29, AGN_QUERY: 30,
});

const blank = (s) => s == null || String(s).trim() === '';
const up = (s) => String(s).trim().toUpperCase();

/**
 * SNR 依 %+03d 格式化，先夾在 -30~+30（JS8 的 SNR 欄位只編得下 -30~+31，超出會被 Varicode 數值正則截半）。
 * 非數字視為 0（同 Java int 預設值）。
 * @param {number} snr
 * @returns {string} 例如 "-08"、"+12"、"+00"
 */
export function formatSnr(snr) {
  const n = Number(snr);
  const v = Math.max(-30, Math.min(30, Number.isFinite(n) ? Math.round(n) : 0));
  return (v < 0 ? '-' : '+') + String(Math.abs(v)).padStart(2, '0');
}

/**
 * 依訊息型別產生回覆選項。
 *
 * @param {object} msg 收到的訊息：Js8MessageAssembler 的欄位（callsignFrom、snr、isCq、isHeartbeat、directedCmd），
 *   或對話紀錄（from、dir）。`outgoing === true` 或 `dir === 'tx'` 視為我方送出。
 * @param {object} me 本機資料
 * @param {string} [me.myCall] 我的呼號（自己訊號的回授不給選項）
 * @param {string} [me.myGrid] 我的網格（回 GRID 只取前 4 碼，同 App）
 * @param {string} [me.infoText] 設定好的 INFO 內容
 * @param {string} [me.statusText] 設定好的 STATUS 內容
 * @param {string[]} [me.hearing] 最近聽到的台（HEARING? 用；呼叫端已限筆數）
 * @param {string} [me.lastTxText] 上一則我方送出的內容（AGN? 用）
 * @returns {{ id: string, text: string, call: boolean }[]} call=true 是「呼叫他」（只填呼號＋空白讓人續打）；
 *   我方送出、群組（@…）、解不出呼號（<…>）、自己訊號回授時回空陣列
 */
export function replyOptions(msg, me) {
  const options = [];
  if (msg == null || me == null || msg.outgoing === true || msg.dir === 'tx') return options;
  const from = up(msg.callsignFrom ?? msg.from ?? '');
  if (from === '' || from.startsWith('@') || from.includes('<')) return options;
  if (!blank(me.myCall) && from === up(me.myCall)) return options;

  const add = (id, text) => {
    if (!options.some((o) => o.text === text)) options.push({ id, text, call: false });
  };
  options.push({ id: 'call', text: `${from} `, call: true });
  const snr = formatSnr(msg.snr);
  add('snr', `${from} SNR ${snr}`);

  if (msg.isHeartbeat) {
    add('heartbeatSnr', `${from} HEARTBEAT SNR ${snr}`);
  } else if (!msg.isCq) {
    switch (msg.directedCmd) {
      case CMD.GRID_QUERY:
        if (!blank(me.myGrid)) add('grid', `${from} GRID ${up(me.myGrid).slice(0, 4)}`);
        break;
      case CMD.INFO_QUERY:
        if (!blank(me.infoText)) add('info', `${from} INFO ${up(me.infoText)}`);
        break;
      case CMD.STATUS_QUERY:
        if (!blank(me.statusText)) add('status', `${from} STATUS ${up(me.statusText)}`);
        break;
      case CMD.HEARING_QUERY: {
        const calls = (me.hearing ?? []).filter((c) => !blank(c)).map(up).filter((c) => c !== from);
        if (calls.length) add('hearing', `${from} HEARING ${calls.join(' ')}`);
        break;
      }
      case CMD.AGN_QUERY:
        if (!blank(me.lastTxText)) add('agn', `${from} ${up(me.lastTxText)}`);
        break;
      case CMD.HW_CPY_QUERY:
        add('fb', `${from} FB`);
        break;
      case CMD.QSL_QUERY:
        add('qsl', `${from} QSL`);
        add('rr', `${from} RR`);
        break;
      case CMD.SNR_REPORT:
      case CMD.HEARTBEAT_SNR:
        add('rr', `${from} RR`);
        add('73', `${from} 73`);
        break;
      case CMD.SNR_QUERY:
        break; // SNR 已是固定的第二項
      default:
        // RR／QSL／ACK／73／SK、自由文字、其他指令，以及沒有型態欄位的舊紀錄
        add('73', `${from} 73`);
        break;
    }
  }
  return options;
}
