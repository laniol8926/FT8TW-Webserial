// JS8 對話儲存（add-web-js8-chat js8-chat spec「選台篩選」「對話保存」、design D11、D12）。
// 對齊 App Js8ChatStore：存 IndexedDB（與 QSO 記錄、SWL Log 分開的資料庫），不能用時改存記憶體；
// 畫面最多載入最近 500 則（App MAX_IN_MEMORY）。保留期限由呼叫端用 retention.mjs 的 cutoffFor() 算出後呼叫 purgeOlderThan。
// 訊息：{ id, utc, dir:'rx'|'tx', from, to, text, complete, snr, freqHz, submode, utx, live, grid? }
//   id：呼叫端給（例如接收中泡泡的 bucketKey）或由 store 產生；live＝接收中（逐 frame 用 update 更新，定稿時 live:false）

export const DB_NAME = 'ft8tw-js8chat'; // JTTY 對話另開 ft8tw-jttychat（add-web-jtty D10），由呼叫端傳 dbName
const STORE = 'messages';
export const MAX_MESSAGES = 500;

const norm = (c) => (typeof c === 'string' ? c.trim().toUpperCase() : '');

// 同 utc 以 id 排序，數字在字串前（同 IndexedDB 的 key 順序），結果才穩定
function byUtcThenId(a, b) {
  if (a.utc !== b.utc) return a.utc - b.utc;
  const na = typeof a.id === 'number';
  const nb = typeof b.id === 'number';
  if (na !== nb) return na ? -1 : 1;
  if (na) return a.id - b.id;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

class MemoryBackend {
  constructor() {
    this.rows = new Map();
    this.nextId = 1;
  }
  async add(r) {
    let id = r.id;
    if (id == null) {
      while (this.rows.has(this.nextId)) this.nextId++;
      id = this.nextId++;
    }
    this.rows.set(id, structuredClone({ ...r, id }));
    return id;
  }
  async get(id) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async put(r) {
    this.rows.set(r.id, structuredClone(r));
  }
  async all() {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  async remove(id) {
    this.rows.delete(id);
  }
  async clear() {
    this.rows.clear();
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
    // id 沒給時交給 autoIncrement；不可帶 id: undefined/null 進去
    const { id, ...rest } = r;
    return this.run('readwrite', (s) => s.add(id == null ? rest : r));
  }
  get(id) {
    return this.run('readonly', (s) => s.get(id));
  }
  put(r) {
    return this.run('readwrite', (s) => s.put(r));
  }
  all() {
    return this.run('readonly', (s) => s.getAll());
  }
  remove(id) {
    return this.run('readwrite', (s) => s.delete(id));
  }
  clear() {
    return this.run('readwrite', (s) => s.clear());
  }
}

function openIdb(indexedDB, dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('utc', 'utc');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e?.target?.error ?? req.error ?? new Error('js8chat db open failed'));
    req.onblocked = () => reject(new Error('js8chat db blocked'));
  });
}

export async function openJs8Chat({ indexedDB, now = Date.now, dbName = DB_NAME } = {}) {
  let backend = null;
  let persistent = false;
  if (indexedDB) {
    try {
      backend = new IdbBackend(await openIdb(indexedDB, dbName));
      persistent = true;
    } catch {
      backend = null; // 無痕模式、權限或配額問題：改存記憶體
    }
  }
  backend ??= new MemoryBackend();

  const removeWhere = async (pred) => {
    const doomed = (await backend.all()).filter(pred);
    for (const r of doomed) await backend.remove(r.id);
    return doomed.length;
  };

  return {
    persistent,
    // 回傳存好的訊息（含 id）；dir 不是 rx／tx 的不收，回 null
    async add(m) {
      if (!m || (m.dir !== 'rx' && m.dir !== 'tx')) return null;
      const row = { ...m, utc: Number.isFinite(m.utc) ? m.utc : now() };
      const id = await backend.add(row);
      return { ...row, id };
    },
    // 接收中泡泡逐 frame 更新；id 不可被 patch 改掉。找不到回 false
    async update(id, patch) {
      const r = await backend.get(id);
      if (!r) return false;
      await backend.put({ ...r, ...patch, id: r.id });
      return true;
    },
    // 依 utc 遞增（含接收中），只回最新 limit 則
    async list({ limit = MAX_MESSAGES } = {}) {
      const rows = (await backend.all()).sort(byUtcThenId);
      return rows.slice(Math.max(0, rows.length - limit));
    },
    remove: (id) => backend.remove(id),
    // 刪除與該台往來的全部對話（範圍同 filterByStation）
    removeStation: (call) => removeWhere((r) => involves(r, norm(call))),
    clearAll: () => backend.clear(),
    // 刪除 utc 早於門檻者；門檻 null（保留設定「不刪除」）不動。回傳刪除數
    async purgeOlderThan(utcMs) {
      if (!Number.isFinite(utcMs)) return 0;
      return removeWhere((r) => r.utc < utcMs);
    },
  };
}

function involves(m, call) {
  return norm(m.from) === call || norm(m.to) === call;
}

// 選台篩選（D12）：call 為 null＝全部電台；否則 from 或 to 為該台（大小寫不敏感）
export function filterByStation(messages, call) {
  if (call == null) return messages;
  const c = norm(call);
  return messages.filter((m) => involves(m, c));
}

// 不列入選台下拉：空字串、@ALLCALL 這類群組、<...> 雜湊呼號、自己
const isListable = (call, me) => call !== '' && !call.startsWith('@') && !/^<.*>$/.test(call) && call !== me;

const byCall = (a, b) => (a.call < b.call ? -1 : a.call > b.call ? 1 : 0);

// 選台下拉要列的台（D12）：收到過該台發的訊息的台（同 App：聽過 ∩ 有對話）。
// snr＝該台最近一則 RX 的 SNR（沒有時 null）、grid＝該台 RX 訊息最近已知的網格、lastUtc＝最後一次聽到。
// 排序：call（預設，呼號字母）、snr（高到低，沒 SNR 的排最後）、recent（新到舊）；同值以呼號為第二鍵，清單才不會跳動。
export function stationsWithChat(messages, { sort = 'call', myCall = '' } = {}) {
  const me = norm(myCall);
  const map = new Map();
  const sorted = [...messages].sort((a, b) => a.utc - b.utc);
  // 同 App Js8ChatStore.stationsWithChat：聽過 ∩ 有對話。對話紀錄裡每則收到的訊息都算「有對話」，
  // 所以等於「收到過該台發的訊息」；只送過、沒聽過的台不列。lastUtc 是最後一次聽到（「最近收到」不算自己送出的）
  for (const m of sorted) {
    const from = norm(m.from);
    if (m.dir !== 'rx' || !isListable(from, me)) continue;
    let s = map.get(from);
    if (!s) map.set(from, (s = { call: from, snr: null, grid: null, lastUtc: m.utc }));
    s.lastUtc = Math.max(s.lastUtc, m.utc);
    if (Number.isFinite(m.snr)) s.snr = m.snr;
    if (m.grid) s.grid = m.grid;
  }
  const out = [...map.values()];
  if (sort === 'snr') {
    out.sort((a, b) => {
      if (a.snr === b.snr) return byCall(a, b);
      if (a.snr === null) return 1;
      if (b.snr === null) return -1;
      return b.snr - a.snr;
    });
  } else if (sort === 'recent') {
    out.sort((a, b) => b.lastUtc - a.lastUtc || byCall(a, b));
  } else {
    out.sort(byCall);
  }
  return out;
}

// 選定台的對話已全部刪除 → UI 自動回「全部電台」
export function shouldResetSelection(messages, selectedCall) {
  return selectedCall != null && filterByStation(messages, selectedCall).length === 0;
}
