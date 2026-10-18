// 電台自動設定精靈的流程與建議（add-rig-autosetup A2、A12、A15）：純邏輯，畫面在 wizard-ui.mjs。
import { MODELS } from './models.mjs';
import { YAESU5_MODELS } from './probe-ids.mjs';

// y5：「是不是舊款 Yaesu」的回答 'yes'｜'no'｜'unsure'｜null（還沒回答，沒有預設值）
// 探測方式：'scan'（CAT 且明確回答「不是」）｜'yaesu5'（舊款 Yaesu，不送任何位元組）｜'manual'（RTS／DTR 開埠會鍵 PTT（A2）；
// 不確定是不是舊款 Yaesu：鮑率不同時探測的亂碼可能湊出 5-byte 指令（review #1））｜null（VOX）
export function probeMode({ mode, y5 }) {
  if (mode === 'vox') return null;
  if (y5 === 'yes') return 'yaesu5';
  return mode === 'cat' && y5 === 'no' ? 'scan' : 'manual';
}

// 第一步可以往下：VOX 不碰序列埠；其他控制方式一定要回答舊款 Yaesu
export function safetyReady({ mode, y5 }) {
  return mode === 'vox' || ['yes', 'no', 'unsure'].includes(y5);
}

export function wizardSteps({ mode, y5 }) {
  return probeMode({ mode, y5 }) ? ['safety', 'port', 'probe', 'input', 'output', 'tx'] : ['safety', 'input', 'output', 'tx'];
}

// 機型選單的選項；探測結果的建議值排第一
export function modelChoices(pm, result) {
  if (pm === 'yaesu5') return [...YAESU5_MODELS];
  if (pm === 'manual') return MODELS.map((m) => m.name);
  if (!result?.candidates?.length) return [];
  const s = result.suggested;
  return s ? [s, ...result.candidates.filter((n) => n !== s)] : [...result.candidates];
}

// judgeLevel（audio-level.mjs）的結果 → 說明文字的 key
export const rxAdvice = (judge) => `rig.wiz.rx.${judge}`;

// 發射中最新讀數 { alc（alcLevel 的結果）, power } → 建議文字的 key（A15）
export function txAdvice({ alc, power } = {}) {
  if (alc === 'high') return 'rig.wiz.tx.alcHigh';
  if (alc === 'low') return 'rig.wiz.tx.alcLow';
  if (alc === 'ok') return 'rig.wiz.tx.alcOk';
  if (alc === 'none') return 'rig.wiz.tx.alcNone';
  // QMX PC 原始值（0.1 W）≤1 算沒有功率，同 App QrpQmxRig 的門檻
  if (power !== undefined) return power > 1 ? 'rig.wiz.tx.powerOk' : 'rig.wiz.tx.noPower';
  return 'rig.wiz.tx.noMeter';
}
