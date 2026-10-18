// JTTY 送出的訊息與發射控制器佇列的對照（add-web-jtty jtty-chat「巨集 1～8」、W3）：
// JttyTxController 的佇列只有文字，這裡依同樣順序記下每則的序號計畫與泡泡，發射結束時決定序號與泡泡狀態。
// 序號：正常發完才套用「發射完成後加 1」（F3）；用差值套用，排隊中按過 F6（已先加）不會被蓋掉。

const TERMINAL = new Set(['done', 'aborted', 'error', 'rejected']);

export class JttySendQueue {
  constructor() {
    this.entries = []; // { text, plan?, rec? }，第一筆是正在處理（或下一個要處理）的
  }

  get length() {
    return this.entries.length;
  }

  head() {
    return this.entries[0] ?? null;
  }

  push(entry) {
    this.entries.push(entry);
    return entry;
  }

  clear() {
    this.entries = [];
  }

  // 控制器的 onState(state, detail)；ctl：{ busy, queued }。結束狀態回 { entry, outcome, serialDelta }，其他回 null。
  // 之後把清單修剪成控制器還留著的數量（stop()／PTT 失敗會清空整個佇列）
  settle(state, ctl) {
    if (!TERMINAL.has(state)) return null;
    const entry = this.entries.shift() ?? null;
    const plan = entry?.plan;
    const serialDelta = state === 'done' && plan ? plan.serialAfterDone - plan.serialNow : 0;
    const keep = ctl.queued + (ctl.busy ? 1 : 0);
    const dropped = this.entries.length > keep ? this.entries.splice(keep) : [];
    return { entry, outcome: state, serialDelta, dropped };
  }
}

export function isTerminal(state) {
  return TERMINAL.has(state);
}
