// 「用目前位置」（design D13）：只在使用者按下時呼叫，回傳 6 碼網格；經緯度不離開這個函式。
// 被擋時要說清楚怎麼改回允許：Chrome 對已封鎖的網站不會再跳出詢問，只會直接回「沒有權限」（使用者實測）。
import { t } from './i18n/index.mjs';
import { latLonToGrid } from './maidenhead.mjs';

const UNBLOCK = t('page.geo.unblock');
const MESSAGES = {
  1: t('page.geo.denied', { unblock: UNBLOCK }),
  2: t('page.geo.unavailable'),
  3: t('page.geo.timeout'),
};

async function permissionState(permissions) {
  try {
    return (await permissions?.query({ name: 'geolocation' }))?.state ?? null;
  } catch {
    return null; // 不支援 Permissions API：直接呼叫定位，讓瀏覽器自己詢問
  }
}

export async function locateGrid(geolocation, { permissions, isSecureContext = true } = {}) {
  if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
    throw new Error(t('page.geo.unsupported'));
  }
  if (!isSecureContext) {
    throw new Error(t('page.geo.insecure'));
  }
  if ((await permissionState(permissions)) === 'denied') {
    throw new Error(t('page.geo.blocked', { unblock: UNBLOCK }));
  }
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      (pos) => {
        try {
          resolve({ grid: latLonToGrid(pos.coords.latitude, pos.coords.longitude) });
        } catch {
          reject(new Error(MESSAGES[2]));
        }
      },
      (err) => reject(new Error(MESSAGES[err?.code] ?? MESSAGES[2])),
      // 6 碼網格約 5 公里，不需要 GPS 等級的精度；10 分鐘內的位置可沿用
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 10 * 60_000 },
    );
  });
}
