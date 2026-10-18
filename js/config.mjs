// 轉送站位址（design D5）：正式網頁用 ft8tw-relay 子網域；本機開發走 tools/dev-server.mjs 的 /relay 代理。
// 必須是 bv6lc.com 的第一層子網域：Cloudflare 免費憑證只涵蓋 *.bv6lc.com，relay.ft8tw.bv6lc.com 會 TLS 握手失敗（實測）
export const PRODUCTION_HOST = 'ft8tw.bv6lc.com';
export const PRODUCTION_RELAY = 'https://ft8tw-relay.bv6lc.com';
import { APP_VERSION, BUILD_NUMBER } from './version.mjs';

// 完整版本（使用者 2026-10-06）：1.26.1006-prd.104——正式站 prd、其他網址（含本機開發）dev。
// 標題旁顯示、送轉送站組 decoderSoftware「FT8TW 1.26.1006-prd.104」，ADIF 的 PROGRAMVERSION 也用它
export function webVersion(location) {
  const channel = location?.hostname === PRODUCTION_HOST ? 'prd' : 'dev';
  return `${APP_VERSION}-${channel}.${BUILD_NUMBER}`;
}
export const WEB_VERSION = webVersion(globalThis.location);

export function relayBase(location) {
  return location.hostname === PRODUCTION_HOST ? PRODUCTION_RELAY : `${location.origin}/relay`;
}

// 只有本機開發才允許的測試開關（例如把假音訊對齊 slot）
export function isDevHost(location) {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}
