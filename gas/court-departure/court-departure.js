/**
 * ⚖️ 開庭出發提醒系統 v1.1
 * 功能：掃描開庭行事曆 → 分別計算從事務所/住家的車程
 *       → Notion 待辦同時顯示兩個出發時間 → TT 自動同步
 *       → 提醒時間取「兩者較早」，確保不論從哪裡出發都不遲到
 *
 * 觸發器設定（執行 setupTriggers() 一次即可）：
 *   - scanNextDay()  → 每天 21:00（掃描隔天）
 *   - scanToday()    → 每天 07:00（補漏當天）
 *   - cleanOldProcessed() → 每月 1 日 03:00（清理舊記錄）
 */

// ============================================================
// ① 設定區
// ============================================================
const CONFIG = {
  // 事務所地址
  OFFICE_ADDRESS: '臺中市西區自由路一段101號20樓203',

  // 住家地址
  HOME_ADDRESS: '臺中市西區三民路一段139號',

  // 開庭行事曆 ID
  COURT_CALENDAR_ID: '9d8oj0jqrd1lf60908ol444m68@group.calendar.google.com',

  // Notion 工作待辦 DB
  NOTION_DB_ID: '640e22f2-1ca4-838c-9ba7-010ad615471e',

  // Notion 欄位名稱（依 💼工作待辦 DB 實際欄位）
  NOTION_FIELDS: {
    TITLE: 'Title',
    DATE:  'Date',
  },

  // Buffer（分鐘）
  BUFFER: {
    HIGH_COURT: 35,    // 高等法院、高分院
    DISTRICT:   25,    // 地方法院、地檢、簡易庭、少年法院
    DEFAULT:    20,    // 其他（調解、行政法院等）
  },

  PROCESSED_PROP_KEY: 'courtDeparture_processed',
};

// ============================================================
// ② 入口函數
// ============================================================

function scanNextDay() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  scanAndCreateReminders(tomorrow);
}

function scanToday() {
  scanAndCreateReminders(new Date());
}

/** 手動測試用：scanForDate('2026-04-20') */
function scanForDate(dateStr) {
  // 強制解析為台北當天 00:00，避免 UTC 偏移問題
  const d = dateStr
    ? new Date(dateStr + 'T00:00:00+08:00')
    : new Date();
  scanAndCreateReminders(d);
}

// ============================================================
// ③ 主邏輯
// ============================================================
function scanAndCreateReminders(targetDate) {
  const dateLabel = formatDate(targetDate);
  Logger.log(`\n==============================`);
  Logger.log(`🔍 掃描 ${dateLabel} 的開庭事件`);
  Logger.log(`==============================`);

  const events = getCourtEvents(targetDate);

  if (events.length === 0) {
    Logger.log(`✅ 當天無開庭事件，結束`);
    return;
  }

  Logger.log(`📋 找到 ${events.length} 個事件`);
  const processed = getProcessedEvents();
  let createdCount = 0;

  events.forEach(event => {
    const eventId   = event.getId();
    const title     = event.getTitle();
    const location  = event.getLocation();
    const startTime = event.getStartTime();

    Logger.log(`\n─── ${title} ───`);
    Logger.log(`  時間：${formatDateTime(startTime)}`);
    Logger.log(`  地址：${location || '（無）'}`);

    if (processed[eventId]) {
      Logger.log(`  ⏭️ 已建立過，跳過`);
      return;
    }

    if (!location || location.trim() === '') {
      Logger.log(`  ⚠️ 無地址，建立「需確認地址」通知`);
      notifyNoLocation(title, startTime);
      return;
    }

    const buffer = getBuffer(title);
    Logger.log(`  ⏱️ Buffer：${buffer} 分鐘`);

    // 分別計算兩個起點的車程
    Logger.log(`  🏢 計算從事務所的車程...`);
    const officeTravel = getTravelTime(CONFIG.OFFICE_ADDRESS, location);

    Logger.log(`  🏠 計算從住家的車程...`);
    const homeTravel = getTravelTime(CONFIG.HOME_ADDRESS, location);

    // 兩者都失敗才放棄
    if (officeTravel === null && homeTravel === null) {
      Logger.log(`  ❌ Maps 無法計算任何路線，建立通知`);
      notifyNoLocation(title, startTime);
      return;
    }

    // 計算各自出發時間
    const officeDep = officeTravel !== null
      ? new Date(startTime.getTime() - (officeTravel + buffer) * 60 * 1000)
      : null;

    const homeDep = homeTravel !== null
      ? new Date(startTime.getTime() - (homeTravel + buffer) * 60 * 1000)
      : null;

    // Notion 日期欄位取較早的（最保守），確保 TT 提醒不遲
    const reminderTime = (officeDep && homeDep)
      ? (officeDep < homeDep ? officeDep : homeDep)
      : (officeDep || homeDep);

    Logger.log(`  🏢 事務所出發：${officeDep ? formatDateTime(officeDep) : 'N/A'}`);
    Logger.log(`  🏠 住家出發：${homeDep ? formatDateTime(homeDep) : 'N/A'}`);
    Logger.log(`  ⏰ 提醒時間（取較早）：${formatDateTime(reminderTime)}`);

    const success = createNotionTask(event, {
      officeDep, homeDep, reminderTime,
      officeTravel, homeTravel, buffer,
    });

    if (success) {
      processed[eventId] = {
        title,
        reminderTime: reminderTime.toISOString(),
        createdAt: new Date().toISOString(),
      };
      saveProcessedEvents(processed);
      createdCount++;
      Logger.log(`  ✅ Notion 待辦建立成功`);
    } else {
      Logger.log(`  ❌ Notion 建立失敗`);
    }
  });

  Logger.log(`\n==============================`);
  Logger.log(`完成：共建立 ${createdCount} 筆出發提醒`);
  Logger.log(`==============================\n`);
}

// ============================================================
// ④ Google Calendar
// ============================================================
function getCourtEvents(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  try {
    const calendar = CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID);
    if (!calendar) {
      Logger.log('❌ 找不到開庭行事曆，請確認 COURT_CALENDAR_ID');
      return [];
    }
    return calendar.getEvents(start, end);
  } catch (e) {
    Logger.log(`❌ Calendar 讀取錯誤：${e.message}`);
    return [];
  }
}

// ============================================================
// ⑤ Google Maps 車程計算（Routes API v2 via UrlFetchApp）
// ============================================================
function getTravelTime(origin, destination) {
  const mapsKey = PropertiesService.getScriptProperties().getProperty('MAPS_API_KEY');
  if (!mapsKey) {
    Logger.log('  ❌ Script Properties 缺少 MAPS_API_KEY');
    return null;
  }

  const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';
  const body = JSON.stringify({
    origin:      { address: origin },
    destination: { address: destination },
    travelMode:  'DRIVE',
  });

  try {
    const res  = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Goog-Api-Key':    mapsKey,
        'X-Goog-FieldMask':  'routes.duration',
      },
      payload: body,
      muteHttpExceptions: true,
    });

    const data = JSON.parse(res.getContentText());

    if (!data.routes || data.routes.length === 0) {
      Logger.log(`  Routes API：[${origin.slice(0, 8)}...] 無路線，回應=${res.getContentText().slice(0, 100)}`);
      return null;
    }

    // duration 格式為 "78s"
    const durationSec = parseInt(data.routes[0].duration.replace('s', ''), 10);
    return Math.ceil(durationSec / 60);

  } catch (e) {
    Logger.log(`  Routes API 錯誤 [${origin.slice(0, 8)}...]：${e.message}`);
    return null;
  }
}

// ============================================================
// ⑥ Buffer 判斷
// ============================================================
function getBuffer(title) {
  if (/高等法院|高院|高分院/.test(title)) return CONFIG.BUFFER.HIGH_COURT;
  if (/地方法院|地院|地檢|簡易庭|少年法院|少年/.test(title)) return CONFIG.BUFFER.DISTRICT;
  return CONFIG.BUFFER.DEFAULT;
}

// ============================================================
// ⑦ Notion 待辦建立
// ============================================================
function createNotionTask(event, times) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY');
  if (!apiKey) {
    Logger.log('  ❌ Script Properties 缺少 NOTION_API_KEY');
    return false;
  }

  const { officeDep, homeDep, reminderTime, officeTravel, homeTravel, buffer } = times;
  const courtTime = event.getStartTime();
  const location  = event.getLocation();
  const bufferType = buffer === CONFIG.BUFFER.HIGH_COURT ? '高院'
                   : buffer === CONFIG.BUFFER.DISTRICT   ? '地院/地檢'
                   : '一般';

  // 標題：顯示兩個出發時間（哪個更早用 ⚡ 標示）
  const officeStr = officeDep
    ? `${formatTime(officeDep)}（車程 ${officeTravel} 分）`
    : '無法計算';
  const homeStr = homeDep
    ? `${formatTime(homeDep)}（車程 ${homeTravel} 分）`
    : '無法計算';

  const title = `🚗 出發提醒：${event.getTitle()}`;

  const notesText = [
    `⚖️ 開庭：${formatDateTime(courtTime)}`,
    `📍 地點：${location}`,
    ``,
    `🏢 從事務所出發：${officeStr}`,
    `🏠 從住家出發：${homeStr}`,
    ``,
    `⏱️ Buffer：${buffer} 分鐘（${bufferType}）`,
    `🔔 提醒時間設為較早者：${formatDateTime(reminderTime)}`,
  ].join('\n');

  const payload = {
    parent: { database_id: CONFIG.NOTION_DB_ID },
    properties: {
      [CONFIG.NOTION_FIELDS.TITLE]: {
        title: [{ text: { content: title } }],
      },
      [CONFIG.NOTION_FIELDS.DATE]: {
        date: { start: toTaipeiISO(reminderTime) },
      },
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: notesText } }],
        },
      },
    ],
  };

  try {
    const response = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    if (code === 200) return true;

    Logger.log(`  Notion API 回傳 ${code}：${response.getContentText().slice(0, 300)}`);
    return false;

  } catch (e) {
    Logger.log(`  Notion fetch 錯誤：${e.message}`);
    return false;
  }
}

// ============================================================
// ⑧ 無地址 / Maps 失敗時的備用通知
// ============================================================
function notifyNoLocation(title, startTime) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY');
  if (!apiKey) return;

  const payload = {
    parent: { database_id: CONFIG.NOTION_DB_ID },
    properties: {
      [CONFIG.NOTION_FIELDS.TITLE]: {
        title: [{ text: { content: `⚠️ 出發時間未定：${title}（請手動設定提醒）` } }],
      },
      [CONFIG.NOTION_FIELDS.DATE]: {
        date: { start: toTaipeiISO(startTime) },
      },
    },
  };

  try {
    UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log(`  notifyNoLocation 失敗：${e.message}`);
  }
}

// ============================================================
// ⑨ 防重複：Script Properties 讀寫
// ============================================================
function getProcessedEvents() {
  const raw = PropertiesService.getScriptProperties()
                .getProperty(CONFIG.PROCESSED_PROP_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function saveProcessedEvents(obj) {
  PropertiesService.getScriptProperties()
    .setProperty(CONFIG.PROCESSED_PROP_KEY, JSON.stringify(obj));
}

/** 清理 30 天前的記錄（每月 1 日自動執行） */
function cleanOldProcessed() {
  const processed = getProcessedEvents();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cleaned = {};
  Object.entries(processed).forEach(([id, data]) => {
    if (new Date(data.createdAt) > cutoff) cleaned[id] = data;
  });
  saveProcessedEvents(cleaned);
  Logger.log(`清理完成，保留 ${Object.keys(cleaned).length} 筆記錄`);
}

// ============================================================
// ⑩ 工具函數
// ============================================================
function formatDate(d) {
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
}

function formatDateTime(d) {
  return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
}

function formatTime(d) {
  return Utilities.formatDate(d, 'Asia/Taipei', 'HH:mm');
}

function toTaipeiISO(d) {
  return Utilities.formatDate(d, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ss+08:00");
}

// ============================================================
// ⑩-b 整合測試（跑完看 log 確認三個 ✅）
// ============================================================
function testAll() {
  Logger.log('===== 整合測試開始 =====\n');

  // Test 1: Script Properties
  const notionKey = PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY');
  const mapsKey   = PropertiesService.getScriptProperties().getProperty('MAPS_API_KEY');
  Logger.log(`[1/3] Script Properties`);
  Logger.log(`  NOTION_API_KEY: ${notionKey ? '✅ 存在' : '❌ 缺少'}`);
  Logger.log(`  MAPS_API_KEY  : ${mapsKey   ? '✅ 存在' : '❌ 缺少'}`);

  // Test 2: Maps API（事務所 → 臺中地院）
  Logger.log(`\n[2/3] Maps Directions API`);
  const testDest = '臺中市西區英才路533號';  // 臺中地院
  const mins = getTravelTime(CONFIG.OFFICE_ADDRESS, testDest);
  if (mins !== null) {
    Logger.log(`  ✅ 事務所 → 臺中地院：${mins} 分鐘`);
  } else {
    Logger.log(`  ❌ Maps API 回傳 null，請檢查 MAPS_API_KEY`);
  }

  // Test 3: Notion API（建立測試待辦，標題含「TEST」方便手動刪除）
  Logger.log(`\n[3/3] Notion API`);
  const payload = {
    parent: { database_id: CONFIG.NOTION_DB_ID },
    properties: {
      [CONFIG.NOTION_FIELDS.TITLE]: {
        title: [{ text: { content: '🧪 TEST 出發提醒系統測試（請手動刪除）' } }],
      },
      [CONFIG.NOTION_FIELDS.DATE]: {
        date: { start: toTaipeiISO(new Date()) },
      },
    },
  };
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionKey}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 200) {
    Logger.log(`  ✅ Notion 建立成功（HTTP 200）`);
  } else {
    Logger.log(`  ❌ Notion 回傳 ${code}：${res.getContentText().slice(0, 200)}`);
  }

  Logger.log('\n===== 測試完畢 =====');
}

// ============================================================
// ⑪ 一次性設定：寫入 Script Properties（執行一次後可刪）
// ============================================================
function oneTimeSetup() {
  PropertiesService.getScriptProperties().setProperties({
    'MAPS_API_KEY': 'MAPS_API_KEY_REMOVED',
  });
  Logger.log('✅ MAPS_API_KEY 已寫入 Script Properties');
}

// ============================================================
// ⑫ 一次性設定：建立觸發器
// ============================================================
function setupTriggers() {
  // 清除舊觸發器
  ScriptApp.getProjectTriggers()
    .filter(t => ['scanNextDay', 'scanToday', 'cleanOldProcessed']
      .includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));

  // 每天 21:00 掃隔天
  ScriptApp.newTrigger('scanNextDay')
    .timeBased().atHour(21).everyDays(1)
    .inTimezone('Asia/Taipei').create();

  // 每天 07:00 掃當天（補漏）
  ScriptApp.newTrigger('scanToday')
    .timeBased().atHour(7).everyDays(1)
    .inTimezone('Asia/Taipei').create();

  // 每月 1 日 03:00 清理舊記錄
  ScriptApp.newTrigger('cleanOldProcessed')
    .timeBased().onMonthDay(1).atHour(3)
    .inTimezone('Asia/Taipei').create();

  Logger.log('✅ 觸發器建立完成：21:00（隔天）+ 07:00（當天補漏）+ 每月1日（清理）');
}
