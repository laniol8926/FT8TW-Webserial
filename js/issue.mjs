// 回報問題（使用者 2026-10-09）：關於頁的「回報問題」開 FT8TW repo 的網頁版 issue 範本（.github/ISSUE_TEMPLATE/web.yml，
// 自動帶「網頁版」label），版本號欄先填好。只帶範本與版本號，不帶呼號等個人資料。

export const ISSUE_REPO = 'https://github.com/danleetw/FT8TW';
export const ISSUE_TEMPLATE = 'web.yml';

export function webIssueUrl(version) {
  const u = new URL(`${ISSUE_REPO}/issues/new`);
  u.searchParams.set('template', ISSUE_TEMPLATE);
  if (version) u.searchParams.set('version', version);
  return u.href;
}
