// 頻譜用的實數 FFT（add-web-transmit D21、tasks 6.1）。純函式，在 spectrum-worker 裡跑，Node 可直接測。
// 長度須為 2 的冪；以複數 radix-2 迭代實作（2048 點每 160 ms 一次，成本可忽略，不值得再做實數折半最佳化）。

export function isPowerOfTwo(n) {
  return Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0;
}

// Hann 視窗（同 FT8TW 瀑布圖 USE_HANN_WIN）
export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// 建立長度 n 的 FFT：預先算好位元反轉表與旋轉因子，之後每次只做運算
export function createFft(n) {
  if (!isPowerOfTwo(n)) throw new RangeError(`FFT 長度須為 2 的冪：${n}`);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // 實數輸入 → 0..n/2-1 各 bin 的功率（re²+im²）；window 可省略
  function power(input, window, out = new Float32Array(n / 2)) {
    if (input.length !== n) throw new RangeError(`輸入長度須為 ${n}：${input.length}`);
    for (let i = 0; i < n; i++) {
      re[rev[i]] = window ? input[i] * window[i] : input[i];
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    const bins = Math.min(out.length, n / 2);
    for (let i = 0; i < bins; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  }

  return { size: n, power };
}

// 功率 → dB（加極小值避免 log(0)）
export function powerToDb(power, out = new Float32Array(power.length)) {
  for (let i = 0; i < power.length; i++) out[i] = 10 * Math.log10(power[i] + 1e-12);
  return out;
}
