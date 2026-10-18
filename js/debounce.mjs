// 延後執行（code review 2026-10-09）：連續呼叫只執行最後一次，停下 delayMs 後才執行。
// 用在 CAT 設頻：頻率下拉用鍵盤上下鍵連按時，每按一次都會改選的頻率，電台只在停下約 300 ms 後設一次
export function createDebouncer({ delayMs, setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (id) => clearTimeout(id) }) {
  let timer = null;
  let task = null;
  const run = () => {
    const fn = task;
    timer = null;
    task = null;
    fn?.();
  };
  return {
    call(fn) {
      if (timer !== null) clearTimeoutFn(timer);
      task = fn;
      timer = setTimeoutFn(run, delayMs);
    },
    // 立刻執行等待中的（例如需要馬上設頻時）
    flush() {
      if (timer === null) return;
      clearTimeoutFn(timer);
      run();
    },
    cancel() {
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      task = null;
    },
    pending: () => timer !== null,
  };
}
