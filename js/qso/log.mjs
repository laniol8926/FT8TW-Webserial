// QSO 記錄（add-web-transmit qso-log spec、design D20）：通聯完成時寫入 IndexedDB（與 SWL Log 分開的資料庫），
// 不能用時改存記憶體。同一呼號 10 分鐘內不重複記錄（同 FT8TW RECENT_QSO_COOLDOWN_MS）。完整記錄頁在 T5。
// 記錄：{ id, call, grid, myCall, myGrid, startUtc, endUtc, mode, band, freqHz, rstSent, rstRcvd, country }

import { QSO_COOLDOWN_MS } from './retry.mjs';
import { t } from '../i18n/index.mjs';

const DB_NAME = 'ft8tw-qso';
const STORE = 'qso';
export { QSO_COOLDOWN_MS }; // 冷卻時間只在 retry.mjs 定義一次（通聯流程與記錄共用）

class MemoryBackend {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }
  async add(r) {
    this.rows.push({ ...r, id: this.nextId++ });
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
  };
}
