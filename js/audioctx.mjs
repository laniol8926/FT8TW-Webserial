// 瀏覽器的自動播放政策：沒有使用者操作前 AudioContext 可能停在 suspended（design D17）。
// 先試 resume；仍被擋就顯示提示，等使用者點擊或按鍵再啟動；點了還沒啟動就繼續等下一次。
// 注意：依 Web Audio 規格，被擋時 resume() 的 promise 會一直 pending 到真的啟動為止，
// 所以只等一小段時間，不能直接 await，否則提示永遠出不來、開始接收也卡住。
const RESUME_WAIT_MS = 300;

const tryResume = (ctx, ms) => Promise.race([
  ctx.resume().catch(() => {}),
  new Promise((r) => setTimeout(r, ms)),
]);

export async function ensureRunning(ctx, { notice, target = document, waitMs = RESUME_WAIT_MS }) {
  if (ctx.state !== 'suspended') return;
  await tryResume(ctx, waitMs);
  if (ctx.state !== 'suspended') return;
  notice.hidden = false;

  const arm = () => {
    const controller = new AbortController();
    const resume = () => {
      controller.abort(); // 點擊與按鍵只要任一個觸發就好
      tryResume(ctx, waitMs).finally(() => {
        if (ctx.state === 'running') notice.hidden = true;
        else if (ctx.state === 'suspended') arm();
      });
    };
    target.addEventListener('pointerdown', resume, { signal: controller.signal });
    target.addEventListener('keydown', resume, { signal: controller.signal });
  };
  arm();
}
