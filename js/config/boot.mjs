// 設定組切換的第二段（add-web-profiles P3）：main.mjs 第一個 import，在任何模組讀設定之前完成 pending 的切換。
// 失敗（儲存空間不足等）時設定維持切換前的值，結果交給設定頁提示。
import { completePending } from './profiles.mjs';

export const profileBoot = (() => {
  try {
    return completePending(globalThis.localStorage);
  } catch (error) {
    return { switched: false, error };
  }
})();
