// 解碼清單暫存（使用者 2026-10-07：切換語言會重新載入頁面，剛剛的解碼內容都不見了）。純邏輯，有單元測試。
// 每批加進解碼清單的列記在 sessionStorage：同一個分頁重新整理、切換語言後還在；關掉分頁就清掉（不會冒出好幾小時前的舊解碼）。
// full＝FT8／FT4／FT2 的接收 slot（取回時也放回呼叫清單、電台卡、地圖）；JS8 與我方發射的列只放回解碼清單。
// 取回時不重送 PSKReporter、不重寫 SWL Log、不觸發通聯流程（那些當時已經做過）。

export const FEED_KEY = 'ft8tw.feed';
export const MAX_AGE_MS = 30 * 60_000;
const MAX_ROWS = 500; // 同解碼清單上限

// startUtc：JTTY 每個 frame 自己的起點（同一個視窗可有多個，code review 2026-10-09）；FT8 等沒有就不帶
const pick = (r) => ({ text: r.text, snr: r.snr, freqHz: r.freqHz, timeSec: r.timeSec, ...(Number.isFinite(r.startUtc) ? { startUtc: r.startUtc } : {}) });

export function createFeedCache({ storage, now = () => Date.now() }) {
  let slots = [];

  function save() {
    try {
      if (slots.length) storage?.setItem(FEED_KEY, JSON.stringify({ v: 1, slots }));
      else storage?.removeItem(FEED_KEY);
    } catch {
      // 容量不足、無痕模式：只是重新載入後不會恢復
    }
  }

  return {
    // msg：addRows 的參數 { startUtc, mode, results, own? }
    record(msg, { full = false } = {}) {
      if (!msg?.results?.length) return;
      slots.push({ startUtc: msg.startUtc, mode: msg.mode, own: msg.own ? true : undefined, ...(Number.isFinite(msg.dialHz) ? { dialHz: msg.dialHz } : {}), full, results: msg.results.map(pick) });
      let rows = slots.reduce((n, s) => n + s.results.length, 0);
      slots.sort((a, b) => a.startUtc - b.startUtc);
      while (rows > MAX_ROWS && slots.length > 1) rows -= slots.shift().results.length;
      save();
    },
    // 重新載入後呼叫一次：回傳 30 分鐘內的 slot（時間由舊到新），並接著記
    restore() {
      let saved = null;
      try {
        saved = JSON.parse(storage?.getItem(FEED_KEY) ?? 'null');
      } catch {
        saved = null;
      }
      const list = Array.isArray(saved?.slots) ? saved.slots : [];
      const cutoff = now() - MAX_AGE_MS;
      slots = list.filter((s) => Number.isFinite(s?.startUtc) && s.startUtc >= cutoff && Array.isArray(s.results)).sort((a, b) => a.startUtc - b.startUtc);
      return slots.map((s) => ({ ...s, results: s.results.map(pick) }));
    },
    clear() {
      slots = [];
      save();
    },
  };
}
