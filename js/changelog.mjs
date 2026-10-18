// 更新歷程（使用者 2026-10-09）：設置 › 更新歷程 頁顯示。新的在最上面。
// 只寫使用者看得懂的「新增／修正了什麼」，不寫技術細節（webtest/changelog.test.mjs 檢查格式與用字）。
// upcoming: true＝main 上已完成、尚未上線的改動（每次 commit 使用者看得到的改動就補一行）；
// 上線時 node tools/stamp-version.mjs --release 把它改成這次的 version／build／date，之後的改動再開新的「下一版」。
// version＋build 組成畫面上的版本（1.26.1009-prd.306）；build 為 null 的是最早的版本（當時還沒有流水號）。
// 台灣一律寫「台灣」／Taiwan。

export const CHANGELOG = Object.freeze([
  {
    version: '1.26.1018', build: 437, date: '2026-10-18',
    items: {
      'zh-TW': ['手機橫放（畫面較矮）時，整頁可以往下捲動，列表不再被切掉；通聯控制列固定在底部'],
      en: ['On short screens such as a phone in landscape, the whole page now scrolls so the lists are no longer cut off; the QSO control bar stays at the bottom'],
    },
  },
  {
    version: '1.26.1018', build: 434, date: '2026-10-18',
    items: {
      'zh-TW': ['接收中保持螢幕開啟：手機螢幕不再自動熄滅而中斷收訊（設置 › 顯示，預設開，可關掉省電）'],
      en: ['Keep the screen on while receiving, so a phone no longer locks itself and interrupts reception (Settings › Display, on by default; turn off to save battery)'],
    },
  },
  {
    version: '1.26.1018', build: 429, date: '2026-10-18',
    items: {
      'zh-TW': [
        'JTTY 新增糾錯：訊息後面附加校驗 frame，漏收 1～2 個 frame 時可自動補回並標示「已修復」；巨集對話框可選糾錯等級（關／標準／加強，預設標準）',
        '電台選擇序列埠沒有選到埠時，提示可能的原因：先試「顯示全部埠」，清單是空的時請安裝電台的 USB 驅動程式（例如 Silicon Labs CP210x）',
      ],
      en: [
        'JTTY error correction: parity frames are sent after each message so 1–2 missed frames can be recovered automatically and marked "repaired"; choose the level (Off / Standard / Strong, default Standard) in the macro dialog',
        'When no serial port is chosen for the radio, the page now explains why: try "Show all ports" first, and if the list is empty install the radio\'s USB driver (e.g. Silicon Labs CP210x)',
      ],
    },
  },
  {
    version: "1.26.1011", build: 422, date: "2026-10-11",
    items: {
      "zh-TW": ["暫時取消試驗期的發射呼號限制；設定呼號後即可發射，其他發射防護維持啟用"],
      en: ["Temporarily lifted the trial callsign restriction for transmit; set your callsign to transmit, with all other transmit safeguards still active"],
    },
  },
  {
    version: '1.26.1010', build: 421, date: '2026-10-10',
    items: {
      'zh-TW': [
        'JTTY 控制分頁新增「收訊診斷」：顯示最近訊息收到與漏掉的 frame、最可能的漏收原因，並可複製診斷資料',
      ],
      en: [
        'New JTTY reception diagnostics in the Control tab: shows which frames of recent messages were received or missed, the most likely cause, and lets you copy the diagnostic data',
      ],
    },
  },
  {
    version: '1.26.1010', build: 416, date: '2026-10-10',
    items: {
      'zh-TW': [
        'JTTY 輸入時顯示字數、frame 數與秒數；太長的訊息自動分成多則送出，每則之間休息幾個 frame 讓電台散熱（可在巨集設定調整，預設 4 frame）',
        '解碼與呼叫清單的右鍵選單改為先列發送方、再列接收方，各依序為呼叫、關注、查日誌、QRZ',
        '平板與電腦可以拖曳左右兩欄中間的分隔線調整寬度，並記住位置（雙擊分隔線還原）',
      ],
      en: [
        'JTTY shows the character count, frames and seconds while typing; long messages are split into several parts sent with a few frames of rest in between so the radio can cool down (adjustable in the macro settings, default 4 frames)',
        'The right-click menu on decode and call lists now lists the sender first, then the receiver, each in the order Call, Follow, Log, QRZ',
        'On tablets and computers, drag the divider between the left and right columns to change their widths; the position is remembered (double-click the divider to reset)',
      ],
    },
  },
  {
    version: '1.26.1010', build: 408, date: '2026-10-10',
    items: {
      'zh-TW': [
        '解碼清單與呼叫清單的篩選按鈕後面顯示符合的筆數（例如「CQ 3」），切換前就知道會看到幾筆',
      ],
      en: [
        'The filter buttons of the decode and call lists now show how many entries match (for example "CQ 3")',
      ],
    },
  },
  {
    version: '1.26.1010', build: 406, date: '2026-10-10',
    items: {
      'zh-TW': [
        'JTTY 訊息可以刪除：右鍵（手機長按）訊息選「刪除」；控制分頁新增「刪除所有 JTTY 訊息」',
        'FT8／FT4／FT2 的解碼清單與呼叫清單新增篩選：時間（5／10／15／30 分鐘）與類別（追蹤、CQ、叫我、NEW DXCC），地圖跟著只畫篩選後的電台',
        '清單還沒有訊息時，畫面中間顯示雷達掃描動畫（解碼、呼叫、電台卡、JS8、JTTY）',
        '修正：JTTY 電台下拉沒有列出與自己同呼號的電台，現在會列出並標「（我）」',
        '修正：解碼清單在電台卡樣式下，其他模式的列沒有真正隱藏',
      ],
      en: [
        'JTTY messages can be deleted: right-click (long-press on phones) a message and choose Delete; the Control tab has a new "Delete all JTTY messages" button',
        'New filters for the FT8/FT4/FT2 decode and call lists: time (5/10/15/30 minutes) and type (followed, CQ, calling me, new DXCC); the map shows only the filtered stations',
        'When a list has no messages yet, a radar sweep animation is shown in the middle (decodes, calls, station cards, JS8, JTTY)',
        'Fix: the JTTY station list did not include a station using your own callsign; it is now listed and marked (me)',
        'Fix: in the card layout, decode rows of other modes were not actually hidden',
      ],
    },
  },
  {
    version: '1.26.1009', build: 397, date: '2026-10-09',
    items: {
      'zh-TW': [
        'JTTY 支援中文與各國文字：勾選輸入列旁的「強化」就能傳中文、emoji、大小寫（只有 FT8TW 收得到，WSJT-X 只看得到開頭的呼號）',
        'JTTY 泡泡會標出發話者呼號：從訊息內容與頻率判斷；FT8TW 之間會自動附上自己的呼號（可在巨集設定關閉）',
        'JTTY 通訊畫面頂端新增電台篩選，可只看某一台的往來',
      ],
      en: [
        'JTTY now supports Chinese and other scripts: tick "Enhanced" next to the input box to send Chinese, emoji and mixed case (only FT8TW can read it; WSJT-X sees just the leading callsign)',
        'JTTY bubbles now show who sent each message, worked out from the content and frequency; FT8TW stations also attach their own callsign automatically (can be turned off in the macro settings)',
        'New station filter at the top of the JTTY chat to show only one station',
      ],
    },
  },
  {
    version: '1.26.1009', build: 384, date: '2026-10-09',
    items: {
      'zh-TW': [
        '修正：接收中換音訊來源時，要重新載入頁面才會收到新裝置的聲音；現在選了就立即切換',
      ],
      en: [
        'Fix: changing the audio input while receiving now switches right away, without reloading the page',
      ],
    },
  },
  {
    version: '1.26.1009', build: 382, date: '2026-10-09',
    items: {
      'zh-TW': [
        '地圖要移到很遠的地方時，先拉遠看到全世界，再放大到新的位置',
        'JS8 模式也會偵測收訊音訊延遲並建議調整',
        '修正：收訊途中換頻率時，那個時槽不再用新頻率回報給 PSKReporter，也不記入 SWL Log',
        '修正：修改頻率表裡目前選的那筆頻率時，選擇會跟著更新；換頻率或模式時，正在播的測試音會停止',
        '設置 › 顯示與佈景新增「線上地圖來源」：線上衛星影像可選 2025 或 2024 年版，也可以填自己的地圖圖磚網址（可放大到更細的層級）',
        '新增 JTTY 模式：與 WSJT-X 3.2 互通的鍵盤對鍵盤通訊，隨時可發、不必等時槽，有 8 個可編輯的巨集按鈕（呼叫 CQ、交換序號等）',
        '修正：切換模式或頻段後，先前收到的解碼與電台頻率被改成新的頻率，上一個模式的電台也還留在呼叫清單、電台卡與地圖；現在每筆保留收到當時的頻率，並只列出目前模式的電台',
        '修正：接收中切換模式時，狀態列沒有立即顯示新模式',
      ],
      en: [
        'When the map moves a long way, it zooms out to the whole world first, then zooms in on the new spot',
        'JS8 mode now also detects receive audio delay and suggests an adjustment',
        'Fix: when the frequency changes in the middle of a receive slot, that slot is no longer reported to PSKReporter with the new frequency or written to the SWL log',
        'Fix: editing the currently selected entry in the frequency table keeps it selected; changing frequency or mode stops a playing test tone',
        'New “Online map source” in Settings › Display & Appearance: choose the 2025 or 2024 edition of the online satellite imagery, or enter your own map tile address (which can zoom in further)',
        'New JTTY mode: keyboard-to-keyboard chat compatible with WSJT-X 3.2. Transmit any time without waiting for a time slot, with 8 editable macro buttons (CQ, serial-number exchange and more)',
        'Fix: after switching modes or bands, earlier decodes and stations were shown with the new frequency, and stations from the previous mode stayed in the call list, station cards and map; now each entry keeps the frequency it was heard on, and only stations of the current mode are listed',
        'Fix: switching modes while receiving now updates the status bar right away',
      ],
    },
  },
  {
    version: '1.26.1009', build: 306, date: '2026-10-09',
    items: {
      'zh-TW': [
        '新增頻率下拉選單：依模式列出頻率，常用的標 ★ 排在前面，可直接切換',
        '設置可以編輯頻率表（新增、修改、刪除、標為常用、恢復預設）',
        '模式下拉選單移到頻率左邊',
        '新增「收訊音訊延遲」（設置 › 電台與聲音）：用 WebSDR 等有延遲的來源收聽時，自動偵測並建議調整，只影響接收',
        '設了收訊延遲時多一條青色進度條，旁邊可一鍵取消調整',
        '地圖新增「衛星影像（Sentinel-2，線上）」底圖，放大可看到城市輪廓；只有選了才會從網路下載',
      ],
      en: [
        'New frequency drop-down: lists frequencies for the current mode, favorites marked ★ at the top, switch with one click',
        'The frequency table can be edited in Settings (add, edit, delete, mark as favorite, restore defaults)',
        'The mode drop-down moved to the left of the frequency',
        'New “Receive audio delay” (Settings › Radio & Audio): detects the delay of sources such as WebSDR and suggests an adjustment; affects receiving only',
        'When a receive delay is set, an extra cyan progress bar appears, with a button to cancel the adjustment',
        'New map base layer “Satellite (Sentinel-2, online)” with city outlines when zoomed in; downloaded only when you choose it',
      ],
    },
  },
  {
    version: '1.26.1009', build: 286, date: '2026-10-09',
    items: {
      'zh-TW': [
        '地圖放大時改畫清晰的向量地圖，放大到台灣也看得清楚（含縣市界）',
        '地圖較矮時，新出現的電台也會自動框進畫面',
        '選取的電台改用藍色光環，閃幾秒後停止',
        '國界加粗、州界改成細虛線，國名顯示在最上層',
      ],
      en: [
        'Zooming in on the map now draws sharp vector maps; Taiwan is clear even at close range (including county borders)',
        'New stations are framed automatically even when the map is short',
        'The selected station now has a blue halo that stops blinking after a few seconds',
        'Thicker country borders, thin dashed state borders, country names drawn on top',
      ],
    },
  },
  {
    version: '1.26.1009', build: 276, date: '2026-10-09',
    items: {
      'zh-TW': [
        '新增電台自動設定精靈（設置 › 電台與聲音）：自動找出電台型號與連線方式',
        '新增設定組：可存多組設定並快速切換，目前使用的設定組以紫色條紋標示',
        '有新版本時頁面頂端會提示，點一下就更新',
        '標題下方顯示電台型號、頻率與 S 表，發射時顯示 SWR（過高標紅）',
        '通聯紀錄、解碼卡片改用電台的實際頻率',
        '頻率顯示省略多餘的 0（例如 14.074 MHz）',
        '地圖新增格線（Grid）、CQ 分區、ITU 分區、州界開關；地形底圖的國界更清楚',
      ],
      en: [
        'New radio setup wizard (Settings › Radio & Audio) that finds your radio model and connection automatically',
        'New settings profiles: keep several sets of settings and switch quickly; the active profile is marked with purple stripes',
        'A notice appears at the top when a new version is available; click it to update',
        'Radio model, frequency and S-meter are shown under the title, and SWR while transmitting (red when too high)',
        'QSO logs and decode cards now use the radio’s actual frequency',
        'Frequencies are shown without extra zeros (e.g. 14.074 MHz)',
        'Map switches for grid squares, CQ zones, ITU zones and state borders; clearer borders on the terrain map',
      ],
    },
  },
  {
    version: '1.26.1009', build: 247, date: '2026-10-09',
    items: {
      'zh-TW': ['3D 地球自動移動更平順，高緯度不再扭轉'],
      en: ['Smoother automatic movement on the 3D globe, no more twisting near the poles'],
    },
  },
  {
    version: '1.26.1009', build: 245, date: '2026-10-09',
    items: {
      'zh-TW': [
        '新增電台控制（CAT／PTT）：電腦版 Chrome／Edge 可用 USB 或藍牙連接電台，支援 84 種機型',
        '切換波段時自動設定電台頻率；SWR 過高時自動停止發射',
        '新增 3D 地球：日夜分界線、國界、可拖曳旋轉',
        '新增地圖設定（右鍵或齒輪鈕）：選擇地圖種類、國界、國名',
        '開啟網頁時顯示測試版使用聲明',
      ],
      en: [
        'New radio control (CAT/PTT): connect your radio over USB or Bluetooth in desktop Chrome/Edge; 84 models supported',
        'Changing bands sets the radio frequency automatically; transmitting stops automatically when SWR is too high',
        'New 3D globe with day/night line and country borders, drag to rotate',
        'New map settings (right-click or the gear button): map type, borders and country names',
        'A beta-version notice is shown when the page opens',
      ],
    },
  },
  {
    version: '1.26.1008', build: 211, date: '2026-10-08',
    items: {
      'zh-TW': [
        '手機版畫面改成和 FT8TW App 一樣：紫色工具列、兩行解碼列、底部 5 個分頁、右側浮動按鈕',
        'iGate 新增「檢查登入」，可先確認 passcode 是否正確',
        '解碼清單只顯示目前模式的訊息',
        '地圖自動移動改成飛行動畫，並把連線與航線一起框進畫面；手動縮放或拖曳後 30 秒自動恢復',
      ],
      en: [
        'The phone layout now matches the FT8TW app: purple toolbar, two-line decodes, five bottom tabs, floating buttons on the right',
        'iGate “Check login” lets you verify your passcode first',
        'The decode list shows only messages of the current mode',
        'The map now flies to new positions and frames links and paths; it returns to auto-framing 30 seconds after you zoom or drag',
      ],
    },
  },
  {
    version: '1.26.1008', build: 188, date: '2026-10-08',
    items: {
      'zh-TW': [
        'JS8 可以收發中文與大小寫訊息',
        '新增 APRS-IS iGate：JS8 的位置與訊息可以轉送到 APRS-IS',
      ],
      en: [
        'JS8 can send and receive Chinese text and mixed-case messages',
        'New APRS-IS iGate: JS8 positions and messages can be forwarded to APRS-IS',
      ],
    },
  },
  {
    version: '1.26.1008', build: 172, date: '2026-10-08',
    items: {
      'zh-TW': [
        'JS8 支援五種速度（NOR、FST、TUR、SLO、FTW）收發，並同時解出其他速度的訊號',
        '修正網頁放在背景時錄音變慢、解不出訊號的問題',
        '頻譜與地圖可以收起，也可以拖曳調整高度',
      ],
      en: [
        'JS8 supports five speeds (NOR, FST, TUR, SLO, FTW) and decodes the other speeds at the same time',
        'Fixed recording slowing down and decodes failing while the page is in the background',
        'The spectrum and map can be collapsed and resized by dragging',
      ],
    },
  },
  {
    version: '1.26.1007', build: 144, date: '2026-10-07',
    items: {
      'zh-TW': [
        '地圖畫出「誰呼叫誰」的連線動畫，喊 CQ 的電台有向外擴散的圓圈',
        'JS8 模式的地圖只畫對話中的電台',
        '切換語言或重新整理後，解碼清單會保留',
        '版本號可以選取複製；電台卡依呼號排序',
      ],
      en: [
        'The map animates who is calling whom; stations calling CQ show expanding rings',
        'In JS8 mode the map shows only stations in the conversation',
        'The decode list is kept after switching language or reloading',
        'The version text can be copied; station cards are sorted by callsign',
      ],
    },
  },
  {
    version: '1.26.1007', build: 137, date: '2026-10-07',
    items: {
      'zh-TW': [
        '新增 JS8 通訊畫面：對話泡泡、常用訊息、自動回覆、定時 HB',
        '狀態列的模式改成下拉選單，可以直接切換',
        '畫面文字不會再被誤選取（訊息內容仍可選取）',
      ],
      en: [
        'New JS8 chat screen: message bubbles, quick messages, auto-replies and timed HB',
        'The mode in the status bar is now a drop-down you can switch directly',
        'Screen text is no longer selected by accident (message text can still be selected)',
      ],
    },
  },
  {
    version: '1.26.1007', build: 127, date: '2026-10-07',
    items: {
      'zh-TW': ['選單標題旁新增語言快速切換', '地圖配色調整'],
      en: ['Quick language switch next to the menu title', 'Updated map colors'],
    },
  },
  {
    version: '1.26.1007', build: 124, date: '2026-10-07',
    items: {
      'zh-TW': [
        '新增英文介面：瀏覽器是中文時自動顯示繁體中文，也可以在設置手動選擇',
        '電台卡下方新增通聯進度（網格、報告、R 報告、RR73、73）',
        '地圖只畫右邊目前清單裡的電台；沒有網格的電台用國家中心點',
        '設置新增「時間偏移」：同步時間、手動調整 −2～+2 秒',
      ],
      en: [
        'New English interface: Traditional Chinese is shown automatically for Chinese browsers, or choose in Settings',
        'QSO progress (grid, report, R-report, RR73, 73) below the station cards',
        'The map shows only stations in the current list; stations without a grid use their country’s center',
        'New “Time offset” setting: sync time or adjust manually by −2 to +2 seconds',
      ],
    },
  },
  {
    version: '1.26.1007', build: 105, date: '2026-10-07',
    items: {
      'zh-TW': [
        '修正部分手機解不出訊號的問題',
        '地圖畫出與通聯對象之間的航線',
        '解碼清單、呼叫清單與電台卡顯示國旗；通聯紀錄卡加上 QRZ 連結',
        '列表字型大小可以在 8～26 之間調整',
        '頻譜按右鍵（手機長按）可以調整瀑布圖顯示',
      ],
      en: [
        'Fixed some phones not decoding any signals',
        'The map draws the path to your QSO partner',
        'Country flags in the decode list, calling list and station cards; QRZ links on QSO log cards',
        'List font size adjustable from 8 to 26',
        'Right-click (long-press on phones) the spectrum to adjust the waterfall display',
      ],
    },
  },
  {
    version: '1.26.1006', build: 94, date: '2026-10-06',
    items: {
      'zh-TW': [
        '新增發射（VOX）：FT8、FT4、FT2、JS8，並有發射時間上限等安全防護',
        '新增自動通聯：自動回應 CQ、通聯順序、通聯紀錄',
        '新增 JS8 與 FT2 收訊',
        '介面比照 FT8TW App：頻譜／瀑布圖、地圖、解碼卡片、呼叫清單、電台卡、右鍵選單',
        '新增設置頁（分類同 FT8TW App）',
      ],
      en: [
        'New transmitting (VOX) for FT8, FT4, FT2 and JS8, with safety limits such as a transmit time limit',
        'New automatic QSOs: auto-reply to CQ, QSO sequence and QSO log',
        'New JS8 and FT2 receiving',
        'Interface modeled on the FT8TW app: spectrum/waterfall, map, decode cards, calling list, station cards, right-click menu',
        'New Settings page (same sections as the FT8TW app)',
      ],
    },
  },
  {
    version: '0.26.1005', build: null, date: '2026-10-05',
    items: {
      'zh-TW': [
        '第一版上線：在瀏覽器裡解碼 FT8、FT4，並把收到的電台回報到 PSKReporter',
        '手機、平板、桌機三種版面',
        '頁首顯示解碼週期進度條與版本',
      ],
      en: [
        'First release: decode FT8 and FT4 in the browser and report heard stations to PSKReporter',
        'Layouts for phones, tablets and desktops',
        'Decode-cycle progress bar and version shown in the header',
      ],
    },
  },
]);

// 畫面上的版本字串：1.26.1009-prd.306；沒有流水號的早期版本只顯示 0.26.1005；即將推出的回 null（畫面另用「下一版」字樣）
export function releaseLabel(entry) {
  if (entry.upcoming) return null;
  return entry.build === null ? entry.version : `${entry.version}-prd.${entry.build}`;
}

// 某語系的項目；沒有該語系時用英文
export function releaseItems(entry, locale) {
  return entry.items[locale] ?? entry.items.en;
}

