import { isValidCallsign } from '../settings.mjs';
import { t } from '../i18n/index.mjs';

// 一輪 JS8 解碼結果的去向（tasks 6.5）：畫面每個 frame 一列（同 FT8TW 解碼清單邊收邊顯示）、
// 回報只取有發送者的 frame（D10）、SWL Log 只記組好的訊息。輸入是 Js8MessageAssembler.processCycle 的結果。

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function js8CycleOutputs({ frames, messages }, { startUtc }) {
  const rows = frames.map(({ frame, up, text }) => ({
    snr: frame.snr,
    timeSec: frame.timeSec,
    freqHz: frame.freqHz,
    text: text || t('js8.undecodable'),
    sender: up.callsignFrom,
    grid: up.grid,
  }));
  // 同一輪同呼號只回報一次（D10）；解不出呼號就跳過，不猜
  const seen = new Set();
  const reports = [];
  for (const r of rows) {
    // 群組（@ALLCALL）、雜湊（<...>）或雜訊解出的怪字串都不回報（同 FT8 路徑的 isValidCallsign）
    if (!r.sender || !isValidCallsign(r.sender) || seen.has(r.sender)) continue;
    seen.add(r.sender);
    reports.push({ snr: r.snr, freqHz: r.freqHz, text: r.text, sender: r.sender, grid: r.grid });
  }
  const logRecords = messages.map((m) => ({
    utc: startUtc,
    snr: m.snr,
    dt: null, // 訊息跨多個 frame，沒有單一的 DT
    audioHz: m.freqHz,
    text: m.complete ? m.text : `${m.text}（不完整）`,
    sender: m.callsignFrom,
    grid: m.grid,
  }));
  return { rows, reports, logRecords };
}
