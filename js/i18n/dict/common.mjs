// 字典：common 區（key 一律以 "common." 開頭；兩語系 key 必須一致，webtest/i18n.test.mjs 檢查）
// 到處都用的詞；只有 A 區（頁面主體）寫這個檔，其他區可直接讀
export default {
  en: {
    'common.ok': 'OK',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.clear': 'Clear',
    'common.stop': 'Stop',
    'common.auto': 'Auto',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.on': 'On',
    'common.off': 'Off',
    // 列舉分隔（「回音消除、降噪」）與句中逗號（「目前沒有記錄，本網站已用…」）
    'common.list_sep': ', ',
    'common.comma': ', ',
  },
  'zh-TW': {
    'common.ok': '確定',
    'common.cancel': '取消',
    'common.close': '關閉',
    'common.clear': '清除',
    'common.stop': '停止',
    'common.auto': '自動',
    'common.save': '儲存',
    'common.delete': '刪除',
    'common.on': '開',
    'common.off': '關',
    'common.list_sep': '、',
    'common.comma': '，',
  },
};
