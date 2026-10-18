// 接收中換音訊來源（使用者 2026-10-09：選了音訊來源要重新載入才收得到聲音）：先停（不算使用者停止）再用新裝置開始。
// 重新開始途中又換：不同時跑多個，等這次結束後只再重來一次（用最後選的裝置）；途中使用者停了接收就不再開始。
export function createInputSwitcher({ isRunning, stop, start }) {
  let busy = null;
  let pending = false;
  return {
    changed() {
      if (busy) {
        pending = true;
        return busy;
      }
      busy = (async () => {
        try {
          do {
            pending = false;
            if (!isRunning()) break;
            await stop();
            await start();
          } while (pending);
        } finally {
          busy = null;
        }
      })();
      return busy;
    },
  };
}
