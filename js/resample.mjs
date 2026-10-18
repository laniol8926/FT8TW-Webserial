// 任意取樣率 → 12 kHz 的降取樣器（tasks 3.1），在 AudioWorklet 內逐段呼叫。
// 加 Blackman 窗的 sinc 低通：截止 5 kHz，過渡帶約 3.6～6.4 kHz（與輸入取樣率無關），
// 100～3000 Hz 平坦、會折回音頻段的高頻壓到 −60 dB 以下。
// 係數預先算成多相表（PHASES 個分數相位），非整數比時在相鄰相位間線性內插，執行時不算三角函數。

export const OUT_RATE = 12000;
const CUTOFF_HZ = 5000;
const HALF_WIDTH_AT_48K = 48; // 48 kHz 下單邊 48 個輸入樣本；其他取樣率等比例，讓過渡帶寬度（Hz）一致
const PHASES = 512;

function buildTable(inRate) {
  const hw = Math.ceil((HALF_WIDTH_AT_48K * inRate) / 48000);
  const taps = 2 * hw;
  const fc = CUTOFF_HZ / inRate; // 以輸入取樣率正規化
  // table[p][j]：輸出時刻的分數相位 frac=p/PHASES 時，第 j 個輸入樣本（索引 floor(t)-hw+1+j）的權重
  const table = [];
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    const w = new Float64Array(taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const d = j - hw + 1 - frac; // 輸入樣本相對輸出時刻的距離（樣本）
      const x = 2 * fc * d;
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const u = (d + hw) / (2 * hw); // 0～1
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      w[j] = 2 * fc * sinc * win;
      sum += w[j];
    }
    for (let j = 0; j < taps; j++) w[j] /= sum; // 直流增益正規化為 1
    table.push(w);
  }
  return { hw, taps, table };
}

export class Resampler {
  constructor(inRate) {
    if (!(inRate >= OUT_RATE)) throw new Error(`輸入取樣率必須 ≥ ${OUT_RATE}，收到 ${inRate}`);
    this.inRate = inRate;
    this.step = inRate / OUT_RATE;
    Object.assign(this, buildTable(inRate));
    this.reset();
  }

  reset() {
    // buf[0] 對應輸入的絕對索引 base；開頭補 hw 個 0，讓第 0 個輸出也有完整的左側
    this.buf = new Float32Array(this.hw);
    this.base = -this.hw;
    this.n = 0; // 下一個輸出的序號，對應輸入時刻 t = n * step
  }

  // 回傳這段輸入能產生的輸出；需要右側 hw 個未來樣本，所以輸出會晚約 1 ms 才出來，但時刻對應不變
  process(input) {
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf);
    merged.set(input, this.buf.length);
    const lastIndex = this.base + merged.length - 1;
    const out = [];
    for (;;) {
      const t = this.n * this.step;
      const i0 = Math.floor(t);
      if (i0 + this.hw > lastIndex) break;
      const pf = (t - i0) * PHASES;
      const p = Math.floor(pf);
      const a = pf - p;
      const w0 = this.table[p];
      const w1 = this.table[Math.min(p + 1, PHASES)];
      const first = i0 - this.hw + 1 - this.base;
      let acc = 0;
      for (let j = 0; j < this.taps; j++) acc += merged[first + j] * (w0[j] + a * (w1[j] - w0[j]));
      out.push(acc);
      this.n++;
    }
    // 只留下一個輸出還會用到的樣本
    const keepFrom = Math.floor(this.n * this.step) - this.hw + 1 - this.base;
    this.buf = merged.slice(Math.max(0, keepFrom));
    this.base += Math.max(0, keepFrom);
    return Float32Array.from(out);
  }
}
