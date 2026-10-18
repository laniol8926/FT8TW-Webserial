// 主畫面電台資訊組的顯示規則（add-rig-meters design M3）：純邏輯，時間由呼叫者傳入；DOM 在 meter-ui.mjs。
// 頻率（CAT 讀回的實際頻率與選的頻率不同時才顯示，add-web-frequency-list）、型號（有選才顯示）、
// 狀態點（CAT／RTS／DTR：綠＝已連線、灰＝未連線；VOX 沒有）、S 表（接收中、10 s 內的讀數）、SWR（發射中；放開後保留 10 s；≥3.0 紅底）。
// VOX 讀不到 S 表與 SWR：不顯示（不放「—」，design M3）。
import { SWR_LIMIT } from './rig.mjs';
import { formatRigHz } from './prefs.mjs';

export const METER_HOLD_MS = 10_000;

export class MeterState {
  constructor() {
    this.connected = false;
    this.sm = null; // { s, calibrated, at }
    this.swr = null; // { value, at }
    this.ptt = false;
    this.pttOffAt = null;
  }

  // 控制器事件（main.mjs onRigEvent 轉來）；回傳顯示是否可能改變
  event(type, d = {}, now = Date.now()) {
    if (type === 'state') {
      this.connected = d.state === 'connected';
      if (!this.connected) Object.assign(this, { sm: null, ptt: false, swr: null, pttOffAt: null }); // 重連後不顯示上一次的 SWR（review C5）
    } else if (type === 'smeter') this.sm = { s: d.s, calibrated: d.calibrated !== false, at: now };
    else if (type === 'swr') this.swr = { value: d.swr, at: now };
    else if (type === 'ptt') {
      this.ptt = Boolean(d.on);
      if (this.ptt) this.swr = null; // 這次發射的讀數才算
      else this.pttOffAt = now;
    } else return false;
    return true;
  }
}

// 頻率（add-web-frequency-list）：選的撥號頻率已在摘要列的頻率下拉裡，電台組只在 CAT 10 s 內讀回的實際頻率與它**不同**時
// （電台被手動調走）才顯示實際頻率；相同、還沒讀到、VOX 都不顯示。回報、SWL Log 仍以實際頻率優先（dialInfo，D14）。
// rigHz：rig.actualHz()（沒有回 null）；selectedHz：目前選的撥號頻率（selectedDial）
export function displayFreq(rigHz, selectedHz) {
  return rigHz && rigHz !== selectedHz ? { hz: rigHz, fromRig: true } : null;
}

// info：{ controlMode, model, freq（displayFreq 的結果）}。回傳 null＝整組不顯示（還沒初始化）
export function meterView(state, { controlMode, model = '', freq = null } = {}, now = Date.now()) {
  if (!controlMode) return null;
  const vox = controlMode === 'vox';
  const connected = !vox && state.connected;
  const fresh = (x) => x && now - x.at <= METER_HOLD_MS;
  const s = connected && !state.ptt && fresh(state.sm) ? `${state.sm.calibrated ? '' : '≈'}${state.sm.s}` : null;
  let swr = null;
  if (connected && state.swr && Number.isFinite(state.swr.value) && (state.ptt || (state.pttOffAt !== null && now - state.pttOffAt <= METER_HOLD_MS))) swr = state.swr.value;
  return {
    vox,
    dot: !vox, // VOX 沒有連線狀態點
    connected,
    model: model || null,
    freq: freq?.hz ? formatRigHz(freq.hz) : null,
    freqFromRig: Boolean(freq?.fromRig),
    s,
    uncalibrated: Boolean(s && !state.sm.calibrated),
    swr: swr === null ? null : `SWR ${(Math.floor(swr * 10 + 1e-9) / 10).toFixed(1)}`, // 無條件捨去：2.95 不會顯示成 3.0 卻沒紅底
    swrHigh: swr !== null && swr >= SWR_LIMIT,
  };
}
