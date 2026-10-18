// SWL Log 畫面（tasks 4.1）：保存狀態、依日期區間匯出 ADIF。
import { t } from './i18n/index.mjs';
import { toAdif } from './adif.mjs';
import { dateRangeUtc, openSwlLog } from './swllog.mjs';
import { WEB_VERSION } from './config.mjs';
import { cutoffFor, loadRetention, saveRetention } from './retention.mjs';

const DAY_MS = 86_400_000;

const $ = (id) => document.getElementById(id);

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// getMyGrid：匯出時取目前設定的接收站網格（MY_GRIDSQUARE）
// storage：保留期限存的地方；storageManager：navigator.storage（持久儲存與用量，可能不存在）
export async function initSwlLogUi({ indexedDB, getMyGrid, storage, storageManager }) {
  const log = await openSwlLog({ indexedDB });
  let retention = loadRetention(storage);
  let persisted = false;
  // 申請持久儲存：核准後磁碟空間不足時瀏覽器不會自動清掉整個網站的資料（D16）
  // 不 await：Firefox 會跳詢問，等使用者回答前不可卡住 SWL Log 初始化（期間解碼會漏記）
  if (log.persistent) {
    Promise.resolve()
      .then(async () => (await storageManager?.persisted?.()) === true || (await storageManager?.persist?.()) === true)
      .then((ok) => {
        persisted = ok;
        showUsage();
      })
      .catch(() => {});
  }

  async function showUsage() {
    const parts = [];
    try {
      const oldest = await log.oldest();
      parts.push(oldest === null ? t('page.swl.no_records') : t('page.swl.oldest', { date: new Date(oldest).toISOString().slice(0, 10) }));
    } catch {
      // 讀不到就不顯示
    }
    try {
      const est = await storageManager?.estimate?.();
      if (est?.usage !== undefined) parts.push(t('page.swl.usage', { mb: (est.usage / 1e6).toFixed(1) }));
    } catch {
      // 不支援就不顯示
    }
    if (log.persistent) parts.push(persisted ? t('page.swl.persisted') : t('page.swl.not_persisted'));
    $('log-usage').textContent = parts.join(t('common.comma'));
  }

  // 刪掉超過保留期限的記錄（D16：開啟時與之後每天一次）
  async function maintain() {
    const cutoff = cutoffFor(Date.now(), retention);
    if (cutoff !== null) {
      try {
        await log.prune(cutoff);
      } catch (err) {
        $('log-msg').textContent = t('page.swl.prune_failed', { error: err.message });
      }
    }
    await showUsage();
  }

  $('log-retention').value = retention === null ? 'never' : String(retention);
  $('log-retention').addEventListener('change', () => {
    const v = $('log-retention').value;
    retention = v === 'never' ? null : Number(v);
    saveRetention(storage, retention);
    maintain();
  });
  await maintain();
  setInterval(maintain, DAY_MS);
  let written = 0;
  $('log-status').textContent = log.persistent
    ? t('page.swl.status_ok')
    : t('page.swl.status_none');
  $('log-status').className = log.persistent ? 'hint' : 'warn';
  $('log-from').value = todayUtc();
  $('log-to').value = todayUtc();

  $('log-export').addEventListener('click', async () => {
    try {
      const [from, to] = dateRangeUtc($('log-from').value, $('log-to').value);
      const records = await log.range(from, to);
      const { text, exported, skipped } = toAdif(records, { myGrid: getMyGrid(), programVersion: WEB_VERSION });
      if (exported === 0) {
        $('log-msg').textContent = t('page.swl.nothing');
        return;
      }
      download(text, `ft8tw-swl-${$('log-from').value.replaceAll('-', '')}-${$('log-to').value.replaceAll('-', '')}.adi`);
      $('log-msg').textContent = skipped ? t('page.swl.exported_skipped', { n: exported, skipped }) : t('page.swl.exported', { n: exported });
    } catch (err) {
      $('log-msg').textContent = t('page.swl.export_failed', { error: err.message });
    }
  });

  return {
    persistent: log.persistent,
    async record(records) {
      if (records.length === 0) return;
      try {
        await log.add(records);
        // 第一次寫入後更新「最早一筆／用量」，否則空庫時會一直顯示「目前沒有記錄」到隔天
        if (written === 0) showUsage();
        written += records.length;
        $('log-count').textContent = t('page.swl.count', { n: written });
      } catch (err) {
        $('log-msg').textContent = t('page.swl.write_failed', { error: err.message });
      }
    },
    range: (a, b) => log.range(a, b),
  };
}
