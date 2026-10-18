// 字典：js8 區（key 一律以 "js8." 開頭；兩語系 key 必須一致，webtest/i18n.test.mjs 檢查）
export default {
  en: {
    'js8.undecodable': '(text could not be decoded)',
    'js8.jscNotLoaded': 'JSC word table is not loaded',
    'js8.utxNotLoaded': 'UTX table is not loaded',
    'js8.jscDownloadFailed': 'JSC word table download failed: {status}',
    'js8.utxDownloadFailed': 'UTX table download failed: {status}',
  },
  'zh-TW': {
    'js8.undecodable': '（無法解出文字）',
    'js8.jscNotLoaded': 'JSC 詞表未載入',
    'js8.utxNotLoaded': 'UTX 字表未載入',
    'js8.jscDownloadFailed': 'JSC 詞表下載失敗: {status}',
    'js8.utxDownloadFailed': 'UTX 字表下載失敗: {status}',
  },
};
