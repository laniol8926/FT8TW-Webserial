// 取得電台音訊（tasks 3.1）。echoCancellation／noiseSuppression／autoGainControl 對 FT8 是災難
// （同 FT8TW 不用 VOICE_COMMUNICATION 的理由），必須要求關閉，並以 getSettings() 確認瀏覽器真的關了。
import { t } from './i18n/index.mjs';

const PROCESSING = ['echoCancellation', 'noiseSuppression', 'autoGainControl'];

export function AUDIO_CONSTRAINTS(deviceId) {
  return {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  };
}

// 只回報明確為 true 的項目；瀏覽器沒回報的項目不算
export function processingStillOn(settings) {
  return PROCESSING.filter((k) => settings[k] === true);
}

export async function openInput(mediaDevices, deviceId) {
  const stream = await mediaDevices.getUserMedia(AUDIO_CONSTRAINTS(deviceId));
  const [track] = stream.getAudioTracks();
  return { stream, stillOn: processingStillOn(track.getSettings()) };
}

// 裝置名稱要在授權麥克風之後才會出現；沒有名稱時給編號
export async function listInputs(mediaDevices) {
  const inputs = (await mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  return inputs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || t('page.audio.input_n', { n: i + 1 }) }));
}
