// 電台卡下方的通聯進度 Dashboard（使用者 2026-10-07，參考 S20／FT8TW 呼叫面板階段列）。純邏輯，移植 FT8TW CallPanelModel。
// 輸入：目前對象呼號、目前要發第幾則（1 網格、2 報告、3 R報告、4 RR73、5 73、6 CQ）、發射是否開著。
// 「已完成」＝回到 CQ 之前已走到 RR73（4）以上；沒走到就回 CQ：發射開著＝放棄後繼續 CQ，發射關了＝停在哪一格（stopped）。

export const STAGE_COUNT = 5;
const ORDER_RR73 = 4;
const ORDER_CQ = 6;

export class CallPanelModel {
  constructor() {
    this.mode = 'cq'; // 'stages' | 'cq' | 'completed' | 'stopped'
    this.callsign = null;
    this.lastOrder = 0;
  }

  update(target, order, activated) {
    const hasTarget = typeof target === 'string' && target !== '' && target !== 'CQ';
    const o = order ?? 0;
    if (!hasTarget || o === ORDER_CQ) {
      if (this.mode === 'completed') return;
      if (this.callsign !== null && this.lastOrder >= ORDER_RR73) this.mode = 'completed';
      else if (!activated) this.mode = 'stopped';
      else {
        this.mode = 'cq';
        this.callsign = null;
        this.lastOrder = 0;
      }
      return;
    }
    const newSession = target !== this.callsign || this.mode === 'completed' || this.mode === 'cq' || (this.mode === 'stopped' && activated);
    if (newSession) {
      this.callsign = target;
      this.lastOrder = 0;
    }
    this.mode = activated ? 'stages' : 'stopped';
    if (o >= 1 && o <= STAGE_COUNT) this.lastOrder = o;
  }

  // 每一格：'done' | 'current' | 'todo'
  steps() {
    return Array.from({ length: STAGE_COUNT }, (_, k) => {
      const i = k + 1;
      if (i < this.lastOrder) return 'done';
      if (i === this.lastOrder) return this.mode === 'completed' ? 'done' : 'current';
      return 'todo';
    });
  }
}
