// JTTY 發射防護（add-web-jtty jtty-chat「隨時發射」、design D9）：沿用 tx/guard.mjs 的呼號允許清單與 15 分鐘監督。
// 監督的起點（Wave B 約定由 Wave D 決定）：第一則開始發射時起算；最後一次發射結束後閒置 60 s 歸零。
import { txBlockReason, txAudioMaxHz, txChannelHz } from '../tx/guard.mjs';

export const IDLE_RESET_MS = 60_000;
const ACTIVE = new Set(['encoding', 'transmitting']);

export class JttySupervisor {
  constructor({ idleResetMs = IDLE_RESET_MS } = {}) {
    this.idleResetMs = idleResetMs;
    this.startedAt = null;
    this.lastActiveAt = null;
    this.busy = false;
  }

  // JttyTxController 的 onState
  note(state, now) {
    if (ACTIVE.has(state)) {
      this.busy = true;
      if (state === 'transmitting') this.startedAt ??= now;
    } else if (state !== 'queued') {
      this.busy = false;
      this.lastActiveAt = now;
    }
  }

  // 監督的起點（null＝還沒開始或已閒置歸零）
  startFor(now) {
    if (!this.busy && this.lastActiveAt !== null && now - this.lastActiveAt >= this.idleResetMs) {
      this.startedAt = null;
      this.lastActiveAt = null;
    }
    return this.startedAt;
  }
}

// JttyTxController 的 guard({ text, now })：getParams() → { callsign, dialHz, audioHz, supervisionMs }；
// ptt：選了 CAT／RTS／DTR 但電台沒連上時不發（不默默改成 VOX，同 tx/ui.mjs begin）
export function createJttyGuard({ getParams, supervisor, ptt = null, notConnectedText = 'rig not connected' }) {
  return ({ now }) => {
    if (ptt?.active?.() && !ptt.ready?.()) return notConnectedText;
    const p = getParams();
    // 通道 127 Hz 從發射頻率往上：上限 2873 Hz（不論畫面有沒有夾到，發射前都再擋一次）
    return txBlockReason({ ...p, audioMaxHz: txAudioMaxHz('JTTY'), bandwidthHz: txChannelHz('JTTY'), startedAt: supervisor.startFor(now), now });
  };
}
