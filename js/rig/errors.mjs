// 電台控制與序列埠的錯誤（安全審查 #9）：錯誤帶 code，畫面依 code 翻譯（rig.err.<code>）；不認得的錯誤才顯示原始訊息。
// message 保持英文原樣（記錄、單元測試比對用）。
import { t } from '../i18n/index.mjs';

export const ERROR_CODES = Object.freeze([
  'unsupported', // 瀏覽器沒有 Web Serial
  'cancelled', // 選埠視窗沒有選埠（按取消，或清單是空的；Chrome 兩者都丟 NotFoundError，分不出來）
  'blocked', // 瀏覽器或政策不允許使用序列埠（SecurityError）
  'badSerial', // 鮑率、資料位元等不合法
  'openFailed', // 開埠失敗（被其他程式占用、拔掉、沒有權限）
  'signalsFailed', // RTS／DTR 控 PTT，但控制線拉不低
  'portNotOpen',
  'writeTimeout', // 寫入卡住（視同斷線）
  'deviceLost', // 拔線、藍牙斷線
  'notConnected',
  'disconnected', // 等待中被中斷連線
  'readTimeout', // 「測試」讀頻沒有回應
  'busyTx', // 發射中不能讀頻（truSDX 讀頻前置 ;RX; 會放開 PTT）
  'pttReleased', // PTT 開送出期間被放開（看門狗、斷線、停止）
  'pttStuck', // PTT 關還沒確定送出，不關埠
  'badSet', // 不認得的指令集
  'badControlMode',
  'probeUnsafe', // 自動探測擋下不在白名單的寫入（add-rig-autosetup A1，程式錯誤才會出現）
]);

export function rigError(code, message, cause) {
  const err = new Error(message, cause === undefined ? undefined : { cause });
  err.code = code;
  return err;
}

// 給使用者看的文字（目前語系）
export function rigErrorText(err) {
  if (err?.code && ERROR_CODES.includes(err.code)) return t(`rig.err.${err.code}`);
  return err?.message ?? String(err);
}

// 選埠失敗時給使用者看的文字（issue #149）。取消與清單空白分不出來，所以附上排解建議；
// filtered：剛才的清單只列常見電台 USB 晶片，先建議按「顯示全部埠」
// rigCodec：電台的 USB 音效已接上（audio-pair.mjs hasRigCodec），全部埠卻沒選到 → 多半是沒裝序列埠驅動
export function portPickText(err, { filtered = false, rigCodec = false } = {}) {
  if (err?.code === 'cancelled') return t(filtered ? 'rig.pick.cancelledFiltered' : rigCodec ? 'rig.pick.noDriver' : 'rig.pick.cancelled');
  if (err?.code === 'blocked' || err?.code === 'unsupported') return rigErrorText(err);
  return t('rig.pick.failed', { msg: rigErrorText(err) });
}
