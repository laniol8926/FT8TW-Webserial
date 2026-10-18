// 舊瀏覽器相容。2026-10-06 實測 Note 8（Android 9、Chrome 101）：沒有 AbortSignal.timeout（Chrome 103 才有），
// 時鐘量測與回報上傳一直丟 TypeError。

// 逾時就中止的 AbortSignal（fetch 用）
export function timeoutSignal(ms, { AbortSignalImpl = globalThis.AbortSignal } = {}) {
  if (typeof AbortSignalImpl?.timeout === 'function') return AbortSignalImpl.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })), ms);
  return ctrl.signal;
}
