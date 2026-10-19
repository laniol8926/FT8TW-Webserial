// QSO 記錄（add-web-transmit qso-log spec、design D20）：通聯完成時寫入 IndexedDB（與 SWL Log 分開的資料庫），
// 不能用時改存記憶體。同一呼號 10 分鐘內不重複記錄（同 FT8TW RECENT_QSO_COOLDOWN_MS）。完整記錄頁在 T5。
// 記錄：{ id, call, grid, myCall, myGrid, startUtc, endUtc, mode, band, freqHz, rstSent, rstRcvd, country }

import { QSO_COOLDOWN_MS } from './retry.mjs';
import { t } from '../i18n/index.mjs';

const DB_NAME = 'ft8tw-qso';
const STORE = 'qso';
export { QSO_COOLDOWN_MS }; // 冷卻時間只在 retry.mjs 定義一次（通聯流程與記錄共用）

// 批次匯入用：真的把主執行緒讓出去（setTimeout，不是 await Promise.resolve() 那種只讓微任務
// 跑完），讓瀏覽器有機會畫面重繪／處理輸入，避免大量匯入（上萬筆）時整個分頁被判定沒有回應。
const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));
const BULK_CHUNK = 500;

class MemoryBackend {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }
  async add(r) {
    this.rows.push({ ...r, id: this.nextId++ });
  }
  async addMany(records, onProgress) {
    let done = 0;
    for (const r of records) {
      this.rows.push({ ...r, id: this.nextId++ });
      onProgress?.(++done, records.length);
      if (done % BULK_CHUNK === 0) await yieldToMain();
    }
  }
  async all() {
    return this.rows.map((r) => ({ ...r }));
  }
  async remove(id) {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

class IdbBackend {
  constructor(db) {
    this.db = db;
  }
  run(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  add(r) {
    return this.run('readwrite', (s) => s.add(r));
  }
  // 分批寫（ADIF 匯入用，大量歷史記錄可能上萬筆）：逐筆各開一個 transaction 太慢，但一個
  // transaction 塞完全部又會讓送出 54,000 個 add() 的這個同步迴圈本身長到讓分頁沒有回應
  // （使用者實測遇到：匯入 54,503 筆後分頁真的沒回應）。折衷：每 BULK_CHUNK 筆一個
  // transaction，塊與塊之間用 yieldToMain() 真的把主執行緒讓出去一次。
  async addMany(records, onProgress) {
    let done = 0;
    for (let i = 0; i < records.length; i += BULK_CHUNK) {
      const chunk = records.slice(i, i + BULK_CHUNK);
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        for (const r of chunk) {
          const req = store.add(r);
          req.onsuccess = () => onProgress?.(++done, records.length);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      await yieldToMain();
    }
  }
  all() {
    return this.run('readonly', (s) => s.getAll());
  }
  remove(id) {
    return this.run('readwrite', (s) => s.delete(id));
  }
}

function openIdb(indexedDB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('endUtc', 'endUtc');
      store.createIndex('call', 'call');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e?.target?.error ?? req.error ?? new Error(t('qso.dbOpenFailed')));
    req.onblocked = () => reject(new Error(t('qso.dbBlocked')));
  });
}

const valid = (q) => q && typeof q.call === 'string' && q.call.trim() && Number.isFinite(q.endUtc) && q.mode;

export async function openQsoLog({ indexedDB }) {
  let backend = null;
  let persistent = false;
  if (indexedDB) {
    try {
      backend = new IdbBackend(await openIdb(indexedDB));
      persistent = true;
    } catch {
      backend = null; // 無痕模式、權限或配額問題：改存記憶體
    }
  }
  backend ??= new MemoryBackend();

  return {
    persistent,
    // 回傳 { added, reason? }：reason 為 'invalid'（缺欄位）或 'cooldown'（同呼號 10 分鐘內已記）
    async add(q) {
      if (!valid(q)) return { added: false, reason: 'invalid' };
      const call = q.call.trim().toUpperCase();
      const recent = (await backend.all()).some((r) => r.call === call && Math.abs(q.endUtc - r.endUtc) < QSO_COOLDOWN_MS);
      if (recent) return { added: false, reason: 'cooldown' };
      await backend.add({ ...q, call });
      return { added: true };
    },
    // 依結束時間新到舊
    async list() {
      return (await backend.all()).sort((a, b) => b.endUtc - a.endUtc);
    },
    remove: (id) => backend.remove(id),
    // 批次匯入（ADIF 匯入用）：重複檢查只整表讀一次、建成記憶體索引，寫入共用一個 transaction，
    // 不是逐筆呼叫 add()（逐筆會整表重掃一次，筆數一多就是 O(n²)，匯入幾百筆就會慢到像卡住）。
    // 回傳 { total, added, duplicate, invalid }，duplicate 計入既有記錄或本批次內互相重複的筆數。
    async importBatch(records, onProgress) {
      const seen = new Map(); // call -> 這個呼號所有記錄的 endUtc 陣列（既有的 + 本批次已經確定要寫入的）
      const existing = await backend.all();
      for (let i = 0; i < existing.length; i++) {
        const r = existing[i];
        if (!seen.has(r.call)) seen.set(r.call, []);
        seen.get(r.call).push(r.endUtc);
        if (i % BULK_CHUNK === 0) await yieldToMain(); // 既有記錄本身可能已經上萬筆（匯入過一次之後再匯入）
      }
      const toAdd = [];
      let duplicate = 0;
      let invalid = 0;
      for (let i = 0; i < records.length; i++) {
        const q = records[i];
        if (!valid(q)) {
          invalid++;
        } else {
          const call = q.call.trim().toUpperCase();
          const times = seen.get(call);
          if (times?.some((t) => Math.abs(q.endUtc - t) < QSO_COOLDOWN_MS)) {
            duplicate++;
          } else {
            if (!seen.has(call)) seen.set(call, []);
            seen.get(call).push(q.endUtc);
            toAdd.push({ ...q, call });
          }
        }
        if (i % BULK_CHUNK === 0) await yieldToMain();
      }
      if (toAdd.length) await backend.addMany(toAdd, onProgress);
      return { total: records.length, added: toAdd.length, duplicate, invalid };
    },
  };
}
