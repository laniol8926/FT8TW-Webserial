// 世界陸地輪廓（web/data/world_110m.bin）解析，格式同 FT8TW WorldOutline.java：
//   大端序；4 bytes magic "WOL1"、int32 ring 數；每個 ring：int32 點數 n，接 n 組 float32 經度、float32 緯度。
// 讀取失敗一律回空輪廓、不丟例外：地圖少了陸地仍然看得出電台位置，不值得讓面板當掉（同 FT8TW）。
// 點數先檢查上限再配置陣列，壞檔不會先要一塊超大記憶體。
const MAGIC = 'WOL1';
export const MAX_RINGS = 10_000;
export const MAX_POINTS_PER_RING = 100_000;
export const MAX_TOTAL_POINTS = 1_000_000;

export const EMPTY_OUTLINE = Object.freeze([]);

// buffer：ArrayBuffer 或 TypedArray。回傳 ring 陣列，每個 ring 是攤平的 Float32Array {lon0, lat0, lon1, lat1, ...}
export function parseOutline(buffer) {
  try {
    const view = buffer instanceof ArrayBuffer
      ? new DataView(buffer)
      : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let off = 0;
    for (let i = 0; i < MAGIC.length; i++) {
      if (view.getUint8(off++) !== MAGIC.charCodeAt(i)) return EMPTY_OUTLINE;
    }
    const ringCount = view.getInt32(off, false);
    off += 4;
    if (ringCount < 0 || ringCount > MAX_RINGS) return EMPTY_OUTLINE;
    const rings = [];
    let total = 0;
    for (let r = 0; r < ringCount; r++) {
      const n = view.getInt32(off, false);
      off += 4;
      if (n < 0 || n > MAX_POINTS_PER_RING) return EMPTY_OUTLINE;
      total += n;
      if (total > MAX_TOTAL_POINTS) return EMPTY_OUTLINE;
      if (off + n * 8 > view.byteLength) return EMPTY_OUTLINE; // 檔案被截斷
      const ring = new Float32Array(n * 2);
      for (let i = 0; i < ring.length; i++) {
        ring[i] = view.getFloat32(off, false);
        off += 4;
      }
      rings.push(ring);
    }
    return rings;
  } catch {
    return EMPTY_OUTLINE; // 連表頭都讀不完（DataView 越界）
  }
}

// 從網址載入；網路錯誤、HTTP 錯誤都回空輪廓
export async function loadOutline(url, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return EMPTY_OUTLINE;
    return parseOutline(await res.arrayBuffer());
  } catch {
    return EMPTY_OUTLINE;
  }
}
