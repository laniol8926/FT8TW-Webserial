// SWL Log（tasks 4.1、swl-log spec）：每則解碼存進 IndexedDB；不能用時改存記憶體並回報 persistent=false，
// 解碼與回報照常（spec：無痕模式要提示記錄不會保存）。
// 紀錄：{ utc（slot 起點 ms）, dialHz, band, mode, snr, dt, audioHz, text }
import { t } from './i18n/index.mjs';

const DB_NAME = 'ft8tw';
const STORE = 'decodes';
export const MEMORY_CAP = 50_000;

export class MemoryBackend {
  constructor({ cap = MEMORY_CAP } = {}) {
    this.cap = cap;
    this.rows = [];
  }

  async add(records) {
    this.rows.push(...records);
    if (this.rows.length > this.cap) this.rows.splice(0, this.rows.length - this.cap);
  }

  async range(fromUtc, toUtc) {
    return this.rows.filter((r) => r.utc >= fromUtc && r.utc < toUtc).sort((a, b) => a.utc - b.utc);
  }

  // 刪掉早於 beforeUtc 的記錄，回傳刪除筆數
  async prune(beforeUtc) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.utc >= beforeUtc);
    return before - this.rows.length;
  }

  async oldest() {
    // 不用 Math.min(...陣列)：幾萬筆時展開運算可能超過參數上限
    return this.rows.length ? this.rows.reduce((m, r) => Math.min(m, r.utc), Infinity) : null;
  }
}

// IndexedDB 的薄包裝：只有開庫、批次寫入、依時間範圍讀
class IdbBackend {
  constructor(db) {
    this.db = db;
  }

  add(records) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const r of records) store.add(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  range(fromUtc, toUtc) {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE).objectStore(STORE).index('utc').getAll(IDBKeyRange.bound(fromUtc, toUtc, false, true));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 用 utc 索引走過早於 beforeUtc 的記錄逐筆刪除，回傳刪除筆數
  prune(beforeUtc) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).index('utc').openCursor(IDBKeyRange.upperBound(beforeUtc, true));
      let removed = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        cursor.delete();
        removed++;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  oldest() {
    return new Promise((resolve, reject) => {
      const req = this.db.transaction(STORE).objectStore(STORE).index('utc').openCursor();
      req.onsuccess = () => resolve(req.result ? req.result.value.utc : null);
      req.onerror = () => reject(req.error);
    });
  }
}

function openIdb(indexedDB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('utc', 'utc');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e?.target?.error ?? req.error ?? new Error(t('page.swl.open_failed')));
    req.onblocked = () => reject(new Error(t('page.swl.blocked')));
  });
}

export async function openSwlLog({ indexedDB }) {
  if (indexedDB) {
    try {
      return wrap(new IdbBackend(await openIdb(indexedDB)), true);
    } catch {
      // 無痕模式、權限或配額問題：改存記憶體
    }
  }
  return wrap(new MemoryBackend(), false);
}

function wrap(backend, persistent) {
  return {
    persistent,
    add: (r) => backend.add(r),
    range: (a, b) => backend.range(a, b),
    prune: (before) => backend.prune(before),
    oldest: () => backend.oldest(),
  };
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s) {
  const m = String(s).match(DATE);
  if (!m) throw new RangeError(t('page.swl.bad_date', { date: s }));
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// 匯出區間以 UTC 日期計：[起日 00:00, 迄日隔天 00:00)
export function dateRangeUtc(from, to) {
  const a = parseDate(from);
  const b = parseDate(to) + 86_400_000;
  if (b <= a) throw new RangeError(t('page.swl.bad_range'));
  return [a, b];
}
