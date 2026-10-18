// 接收中保持螢幕開啟（Screen Wake Lock，使用者 2026-10-18）：手機螢幕自動鎖定會讓分頁暫停，收訊、解碼、回報全部中斷。
// 只防「自動熄滅」；使用者自己按電源鍵鎖定擋不住。切到背景時瀏覽器會自動釋放，回前景再要求。
// 不支援（舊瀏覽器、非 HTTPS）或被拒絕（省電模式）時靜默略過。wakeLock、doc 可注入（單元測試）。
export function createScreenKeeper({ wakeLock = globalThis.navigator?.wakeLock, doc = globalThis.document } = {}) {
  let want = false;
  let sentinel = null;
  let pending = false;

  async function acquire() {
    if (!wakeLock || pending || sentinel || !want || doc?.visibilityState === 'hidden') return;
    pending = true;
    try {
      const s = await wakeLock.request('screen');
      s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
      sentinel = s;
      if (!want) release(); // 要求途中改成不需要
    } catch {
      // 不支援或被拒絕：不影響收訊
    } finally {
      pending = false;
    }
  }

  function release() {
    const s = sentinel;
    sentinel = null;
    s?.release().catch(() => {});
  }

  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState === 'visible') acquire();
  });

  return {
    supported: Boolean(wakeLock),
    get held() { return sentinel !== null; },
    // want：接收中且設定開啟
    set(next) {
      want = Boolean(next);
      if (want) acquire();
      else release();
    },
  };
}
