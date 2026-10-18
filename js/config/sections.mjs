// 設定頁的區段（同 FT8TW「設置」主選單的順序與名稱），以及抽屜裡的其他頁面。純資料，畫面在 config/ui.mjs。
// 標題走字典（config.section.<id>）；語系在載入時已決定，這裡直接取字
import { t } from '../i18n/index.mjs';

export const SECTIONS = Object.freeze(['basic', 'autoqso', 'rig', 'upload', 'activation', 'display', 'backup', 'advanced']
  .map((id) => ({ id, title: t(`config.section.${id}`) })));

// 主選單下方的其他頁面（FT8TW 沒有，網頁版自己的）；更新歷程（使用者 2026-10-09）放在關於上面，Ko-fi 維持緊接關於下方
export const EXTRA_PAGES = Object.freeze(['swllog', 'changelog', 'about'].map((id) => ({ id, title: t(`config.section.${id}`) })));

export const HOME_TITLE = t('config.title');

// 頁面 id → 標題；主選單（null）回「設置」，不認得的 id 回 null
export function pageTitle(id) {
  if (id === null) return HOME_TITLE;
  return [...SECTIONS, ...EXTRA_PAGES].find((p) => p.id === id)?.title ?? null;
}
