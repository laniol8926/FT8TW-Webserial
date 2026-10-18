// 新版提示與最低版本強制更新（add-version-tracking，使用者 2026-10-09）。
// 最新版本：同網域的靜態 version.json（部署時由 tools/stamp-version.mjs 產生；cache-busting query＋no-store，D1）。
// 最低流水號：轉送站 /hello 的回應（後台設定，D2），由 hello.mjs 交給 setMinBuild()。
// 狀態：none／available（有新版，只提示，點了重新載入）／required（低於最低版本，等安全時機自動重新載入，D5）。
// 防迴圈（D4）：version.json 的 build ≥ minBuild 才強制；同一個 minBuild 只自動重新載入一次（記在 sessionStorage）。
export const CHECK_MS = 10 * 60_000; // 每 10 分鐘查一次
export const VISIBLE_MIN_GAP_MS = 60_000; // 回到前景、收到較高的 minBuild 時再查，距上次至少這麼久
export const SAFE_POLL_MS = 1000; // 強制更新等待中：每秒看一次是否安全
export const SAFE_HOLD_MS = 3000; // 要連續安全這麼久才重新載入（JS8 排隊的下一則會在發射結束時立刻接上）
export const RELOAD_KEY = 'ft8tw.update.forcedFor';
const MAX_BUILD = 999_999;

const isBuild = (v, min) => Number.isInteger(v) && v >= min && v <= MAX_BUILD;

// version.json → 流水號；格式不對回 null
export function parseLatest(json) {
  return isBuild(json?.build, 1) ? json.build : null;
}

// /hello 回應的 minBuild；不合法（含舊轉送站沒有這個欄位）當 0
export function parseMinBuild(v) {
  return isBuild(v, 0) ? v : 0;
}

export function decide({ current, latest, minBuild, forcedFor }) {
  if (minBuild > current && latest !== null && latest >= minBuild && forcedFor !== minBuild) return 'required';
  if (latest !== null && latest > current) return 'available';
  return 'none';
}

function readForced(storage) {
  try {
    const v = Number(storage?.getItem(RELOAD_KEY));
    return isBuild(v, 1) ? v : null;
  } catch {
    return null;
  }
}

function writeForced(storage, build) {
  try {
    storage?.setItem(RELOAD_KEY, String(build));
  } catch {
    // 私密模式等：防迴圈只靠「伺服器上有夠新的版本」那一關
  }
}

// isSafe()：不在發射（含排隊）、沒有通聯、PTT 沒開（main.mjs 組）；render(state)：更新橫幅
export function createUpdater({
  currentBuild, url, isSafe, reload, render = () => {}, fetchFn = fetch, doc = document, storage = null,
  now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  let latest = null;
  let minBuild = 0;
  let lastCheck = -Infinity;
  let state = 'none';
  let poll = null;
  let safeTicks = 0;
  const forcedFor = readForced(storage);

  function stopPoll() {
    if (poll !== null) clearIntervalFn(poll);
    poll = null;
    safeTicks = 0;
  }

  // 每次檢查安全就累計 1 拍（SAFE_POLL_MS），任一次不安全歸零；累計滿 SAFE_HOLD_MS 才重新載入
  function onPoll() {
    if (!isSafe()) {
      safeTicks = 0;
      return;
    }
    safeTicks += 1;
    if (safeTicks * SAFE_POLL_MS < SAFE_HOLD_MS) return;
    stopPoll();
    writeForced(storage, minBuild);
    reload();
  }

  function update() {
    const next = decide({ current: currentBuild, latest, minBuild, forcedFor });
    if (next !== state) {
      state = next;
      render(state);
    }
    if (state === 'required') {
      if (poll === null) poll = setIntervalFn(onPoll, SAFE_POLL_MS);
    } else {
      stopPoll();
    }
  }

  async function check() {
    lastCheck = now();
    try {
      const res = await fetchFn(`${url}?_=${lastCheck}`, { cache: 'no-store' });
      if (res.ok) latest = parseLatest(await res.json()) ?? latest;
    } catch {
      // 離線、部署中：保留上次的值
    }
    update();
  }

  const checkIfDue = () => (now() - lastCheck >= VISIBLE_MIN_GAP_MS ? check() : null);

  return {
    start() {
      check();
      setIntervalFn(check, CHECK_MS);
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') checkIfDue();
      });
    },
    check,
    // 轉送站 /hello 回應的最低流水號：高於目前、但還不知道伺服器有夠新的版本時，立刻再查一次（有節流）
    setMinBuild(v) {
      minBuild = parseMinBuild(v);
      if (minBuild > currentBuild && (latest === null || latest < minBuild)) checkIfDue();
      update();
    },
    state: () => state,
  };
}

// 頂端橫幅（D10）：available＝可點的按鈕；required＝等待訊息（不能點，等安全時機自動重新載入）；none＝隱藏
// isSafe()：現在可以重新載入（發射、通聯、測試音…都沒在進行）；isStuck()：PTT 關沒確認（等待的原因不同，說明不同）
export function initUpdateBanner({ el, t, reload, isSafe = () => true, isStuck = () => false }) {
  let current = 'none';
  el.addEventListener('click', () => {
    if (current !== 'available') return;
    if (!isSafe()) { // 發射中點了不要直接重新載入（review S3）
      el.textContent = t('update.busy');
      return;
    }
    reload();
  });
  return (state) => {
    current = state;
    el.hidden = state === 'none';
    el.disabled = state !== 'available';
    el.dataset.state = state;
    if (state === 'available') el.textContent = t('update.available');
    else if (state === 'required') el.textContent = t(isStuck() ? 'update.requiredStuck' : 'update.required');
  };
}
