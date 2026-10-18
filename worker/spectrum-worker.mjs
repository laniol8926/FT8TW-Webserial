// 頻譜 Worker（add-web-transmit D21）：收一幀 12 kHz 樣本（FFT_SIZE 點），回傳 0..bins-1 的 dB。
// 放在 Worker：主執行緒只畫圖，FFT 不搶 UI；解碼本來就在另一個 Worker，互不阻塞。
import { createFft, hannWindow } from '../js/spectrum/fft.mjs';

let fft = null;
let win = null;

self.onmessage = ({ data }) => {
  const { samples, utc, bins } = data;
  if (!fft || fft.size !== samples.length) {
    fft = createFft(samples.length);
    win = hannWindow(samples.length);
  }
  const power = fft.power(samples, win, new Float32Array(bins));
  for (let i = 0; i < bins; i++) power[i] = 10 * Math.log10(power[i] + 1e-12);
  self.postMessage({ db: power, utc }, [power.buffer]);
};
