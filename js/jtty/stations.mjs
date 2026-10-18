// JTTY 通訊畫面的電台篩選（add-jtty-utx design U11，同 JS8 D12 的選台下拉）。純函式。
// 選項：「全部電台」＋收過的各台；發話者已知以呼號為鍵，未知以頻率為鍵（`@1500`，±10 Hz 內算同一台）。
// 選某台只顯示：該台發出的、內容提到該呼號的、我發給它的訊息；以頻率為鍵時只顯示該頻率發話者未知的訊息。
import { SENDER_TOL_HZ } from './sender.mjs';

const norm = (s) => String(s ?? '').trim().toUpperCase();

export const isFreqKey = (key) => typeof key === 'string' && key.startsWith('@');
export const freqOfKey = (key) => Number(key.slice(1));

// 內容是否提到呼號（以 token 比對，缺段記號 `...` 也當分隔）
export function mentions(text, call) {
  const c = norm(call);
  if (!c) return false;
  return String(text ?? '').toUpperCase().split(/[\s,，、]+|\.\.\./u).some((w) => w.replace(/^[^A-Z0-9/]+|[^A-Z0-9/]+$/gu, '') === c);
}

/**
 * 下拉要列的台：[{ key, call|null, freqHz, snr|null, lastUtc }]；呼號依字母、未知呼號的依頻率排在後面。
 * snr、freqHz＝該台最近一則收到的訊息。與自己同呼號的照列並標 me（同一台電腦兩個視窗測試、回聲；使用者 2026-10-09：
 * 兩邊都設 BU2GF 時下拉沒有 BU2GF，沒法篩選）。
 */
export function jttyStations(messages, { myCall = '' } = {}) {
  const me = norm(myCall);
  const calls = new Map();
  const freqs = [];
  for (const m of [...messages].sort((a, b) => a.utc - b.utc)) {
    if (m.dir !== 'rx') continue;
    const from = norm(m.from);
    const snr = Number.isFinite(m.snr) ? m.snr : null;
    if (from) {
      calls.set(from, { key: from, call: from, freqHz: m.freqHz ?? null, snr, lastUtc: m.utc, ...(me && from === me ? { me: true } : {}) });
    } else if (Number.isFinite(m.freqHz)) {
      const near = freqs.find((s) => Math.abs(s.freqHz - m.freqHz) <= SENDER_TOL_HZ);
      if (near) Object.assign(near, { snr, lastUtc: m.utc });
      else freqs.push({ key: `@${Math.round(m.freqHz)}`, call: null, freqHz: Math.round(m.freqHz), snr, lastUtc: m.utc });
    }
  }
  const byCall = [...calls.values()].sort((a, b) => (a.call < b.call ? -1 : a.call > b.call ? 1 : 0));
  return [...byCall, ...freqs.sort((a, b) => a.freqHz - b.freqHz)];
}

/** 選項文字：`呼號 SNR 頻率`；未知呼號 `頻率 SNR`；與自己同呼號的加 meLabel（例如「（我）」） */
export function stationLabel(s, { meLabel = '' } = {}) {
  const snr = s.snr === null || s.snr === undefined ? '' : `${s.snr < 0 ? '-' : '+'}${String(Math.abs(Math.round(s.snr))).padStart(2, '0')}`;
  const hz = Number.isFinite(s.freqHz) ? `${Math.round(s.freqHz)}Hz` : '';
  return (s.call ? [`${s.call}${s.me ? meLabel : ''}`, snr, hz] : [hz, snr]).filter(Boolean).join(' ');
}

/** 依選的台篩選（key＝null 全部） */
export function filterJttyStation(messages, key) {
  if (key === null || key === undefined || key === '') return messages;
  if (isFreqKey(key)) {
    const f = freqOfKey(key);
    return messages.filter((m) => m.dir === 'rx' && !m.from && Number.isFinite(m.freqHz) && Math.abs(m.freqHz - f) <= SENDER_TOL_HZ);
  }
  const c = norm(key);
  return messages.filter((m) => norm(m.from) === c || (m.dir === 'tx' && norm(m.to) === c) || mentions(m.text, c));
}
