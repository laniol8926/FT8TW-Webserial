// ADIF 匯入（通聯記錄分頁）：讀 Dan 的 Android FT8TW（或 QRZ／LoTW／其他 logger）匯出的
// .adi 檔，轉成本機 QSO 記錄（js/qso/log.mjs 的 schema）後交給 log.importBatch() 批次寫入。
// 兩邊是各自獨立的資料庫，沒有共用格式，但都讀寫 ADIF（業餘無線電通用的日誌交換格式）——
// Android 版的匯出在手機上的 :7050 web console（QSOLogs 頁的「Export ADI」鍵）。
// 必要欄位只有 CALL／QSO_DATE+TIME_ON／MODE（跟 log.mjs 的 valid() 要求一致）；缺的那幾筆
// 算 invalid，不會讓整個檔案失敗。10 分鐘同呼號防重沿用 log.mjs 的既有規則，重複匯入同一個
// 檔案不會造成重複記錄。批次寫入（而不是逐筆呼叫 add()）是因為逐筆都整表重掃一次重複檢查，
// 筆數一多（幾百筆以上）會慢到看起來像卡住——這裡只整表讀一次、建成記憶體索引。解析／轉換／
// 寫入三個階段都在 log.mjs／這裡用 yieldToMain() 分段，避免上萬筆時整個分頁沒有回應
// （使用者實測遇到：匯入 54,503 筆後分頁真的沒回應——那次是因為沒有分段，一次跑完）。

import { bandOf } from '../bands.mjs';

const SUBMODE_ALIAS = { FT4: 'FT4', JS8: 'JS8' };
const CHUNK = 2000;
// 真的把主執行緒讓出去（setTimeout），不是只讓微任務跑完——大檔案（上萬筆）光是解析／轉換
// 這兩步本身都是純同步迴圈，不中斷一樣會讓分頁長時間沒有回應，跟寫入階段是同一類問題。
const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

// 單筆記錄字串（<eor> 之間，不含 <eor> 本身）解析成 { TAG: value } 的表。
// ADIF 標籤格式：<name:length[:type]>value，length 以位元組數計；我們用字元數切（跟 Android
// 版同一個簡化作法），只有欄位值含多位元組 UTF-8 字元時才會切錯，而 QSO 記錄的欄位
// （呼號／網格／頻段／模式／RST）本來就都是 ASCII，實務上不受影響。
function parseAdifFields(record) {
  const fields = {};
  const re = /<([A-Za-z0-9_]+)(?::(\d+))?(?::[A-Za-z]+)?>/g;
  let match;
  while ((match = re.exec(record))) {
    const name = match[1].toUpperCase();
    if (name === 'EOR' || name === 'EOH') continue;
    const len = match[2] !== undefined ? Number(match[2]) : null;
    const start = match.index + match[0].length;
    fields[name] = len === null ? '' : record.slice(start, start + len);
  }
  return fields;
}

// 解析整份 ADIF 檔案，回傳每筆記錄的欄位表陣列（略過檔頭，<eoh> 之前的內容）。
export async function parseAdifRecords(text) {
  const eohIdx = text.search(/<eoh>/i);
  const body = eohIdx >= 0 ? text.slice(eohIdx + 5) : text;
  const chunks = body.split(/<eor>/i).filter((chunk) => chunk.includes('<'));
  const records = [];
  for (let i = 0; i < chunks.length; i++) {
    records.push(parseAdifFields(chunks[i]));
    if (i % CHUNK === 0) await yieldToMain();
  }
  return records;
}

function parseAdifDateTime(dateStr, timeStr) {
  if (!dateStr || dateStr.length < 8) return null;
  const y = Number(dateStr.slice(0, 4));
  const mo = Number(dateStr.slice(4, 6));
  const d = Number(dateStr.slice(6, 8));
  const t = (timeStr || '').padEnd(6, '0');
  const h = Number(t.slice(0, 2));
  const mi = Number(t.slice(2, 4));
  const s = Number(t.slice(4, 6));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(ms) ? ms : null;
}

// MODE/SUBMODE -> log.mjs 的 mode 字串（FT8TW 自己匯出的 ADIF 用 MFSK+SUBMODE 表 FT4/JS8，
// FT2 沒有正式 ADIF 模式，寫在 COMMENT 裡，見 js/adif.mjs 的 toAdif()，這裡做對應的還原）。
function modeFromFields(f) {
  const mode = (f.MODE || '').toUpperCase();
  const submode = (f.SUBMODE || '').toUpperCase();
  if (submode) return SUBMODE_ALIAS[submode] ?? submode;
  if (mode === 'MFSK' && /\[FT2\]/i.test(f.COMMENT || '')) return 'FT2';
  return mode;
}

// 一筆 ADIF 欄位表 -> js/qso/log.mjs 的記錄格式；缺必要欄位（呼號/日期時間/模式）回傳 null。
export function adifRecordToQso(f) {
  const call = (f.CALL || '').trim().toUpperCase();
  const mode = modeFromFields(f);
  const startUtc = parseAdifDateTime(f.QSO_DATE, f.TIME_ON);
  if (!call || !mode || startUtc === null) return null;
  const endUtc = parseAdifDateTime(f.QSO_DATE_OFF || f.QSO_DATE, f.TIME_OFF || f.TIME_ON) ?? startUtc;
  const freqHz = f.FREQ ? Math.round(Number(f.FREQ) * 1e6) : NaN;
  // BAND 大小寫不保證跟 bandOf() 的 '20m' 這種小寫一致（有些 logger 寫 '20M'）——已通聯判斷
  // 現在是用「呼號｜波段｜模式」比對（cards/rules.mjs workedKey），band 對不起來會變成永遠比對
  // 不到，所以這裡正規化成小寫；BAND 缺的話用 FREQ 算，同 qso/ui.mjs 完成通聯時的算法一致。
  const band = f.BAND ? f.BAND.toLowerCase() : (Number.isFinite(freqHz) ? bandOf(freqHz) ?? undefined : undefined);
  return {
    call,
    grid: f.GRIDSQUARE || undefined,
    myCall: f.STATION_CALLSIGN || undefined,
    myGrid: f.MY_GRIDSQUARE || undefined,
    startUtc,
    endUtc,
    mode,
    band,
    freqHz: Number.isFinite(freqHz) ? freqHz : undefined,
    rstSent: f.RST_SENT || undefined,
    rstRcvd: f.RST_RCVD || undefined,
    country: f.COUNTRY || undefined,
  };
}

// 匯入整份檔案：轉換每筆記錄後交給 log.importBatch() 批次寫入（log 由呼叫端傳入，通常是
// await qsoLogReady；這裡不直接碰 IndexedDB）。onProgress(done, total) 回報目前寫入進度
// （total 是「要寫入的筆數」，ADIF 轉換階段解不出必要欄位的記錄不計在內，因為那些從不會進
// 寫入階段）。回傳統計：total（檔案總筆數）／added／duplicate（10 分鐘同呼號防重擋下）／
// invalid（ADIF 轉換失敗 + 寫入階段判定無效，兩者相加）。
export async function importAdif(text, log, onProgress) {
  const records = await parseAdifRecords(text);
  const mapped = [];
  let invalid = 0;
  for (let i = 0; i < records.length; i++) {
    const q = adifRecordToQso(records[i]);
    if (q) mapped.push(q);
    else invalid++;
    if (i % CHUNK === 0) await yieldToMain();
  }
  const result = await log.importBatch(mapped, onProgress);
  return { total: records.length, added: result.added, duplicate: result.duplicate, invalid: invalid + result.invalid };
}
