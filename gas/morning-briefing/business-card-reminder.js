// ============================================================
// 📇 名片拍照提醒 v1.0
// 功能：偵測當天社交活動，21:50 推播 LINE 提醒拍名片給 Claude 建檔
// 依賴：程式碼.gs 的 CONFIG 和 sendLineMessage()
// 日期：2026-03-15
// ============================================================

// ===== 社交活動關鍵字 =====

// 高機率：幾乎一定會交換名片
const CARD_HIGH_KEYWORDS = [
  '交流會', '交流晚宴',
  '拜訪', '拜會',
  '交接典禮',
  '參觀',
  '座談',
  '聯誼會', '聯誼',
  '餐會', '晚宴', '餐敘', '尾牙',
  '大會',
  '團拜', '團報',
];

// 中機率：看場合可能會交換名片
const CARD_MEDIUM_KEYWORDS = [
  '理監事', '常務理事',
  '委員會',
  '國賠會議',
  '審查會',
  '家委', '家長', '謝師宴',
  '美食KY', '美食ky', '董事會', '審計', '股東會',
  '工研院',
  '演講', '教育訓練', '講座', '研討',
  '議員',
  '公會',
  '論壇',
  '典禮',
  '摘星',
  '告別式', '公祭',
];

// 排除：符合上面關鍵字但不會換名片的情況
const CARD_EXCLUDE_KEYWORDS = [
  '線上會議', '線上', '視訊',
  '請假', '取消',
  '中律理監事',
];

// ===== 核心判斷 =====

/**
 * 判斷事件標題是否為可能交換名片的社交場合
 * @param {string} summary 事件標題
 * @returns {string|null} 'high'/'medium'/null
 */
function isBusinessCardEvent_(summary) {
  if (!summary) return null;

  // 排除條件優先
  for (const ex of CARD_EXCLUDE_KEYWORDS) {
    if (summary.includes(ex)) return null;
  }

  // 已完成的事件不提醒
  if (summary.includes('✅')) return null;

  for (const kw of CARD_HIGH_KEYWORDS) {
    if (summary.includes(kw)) return 'high';
  }

  for (const kw of CARD_MEDIUM_KEYWORDS) {
    if (summary.includes(kw)) return 'medium';
  }

  return null;
}

// ===== 掃描 + 排程 =====

/**
 * 每日早上執行：掃描當天兩本行事曆，發現社交活動就排 21:50 提醒
 * 設定觸發器：與晨報同為每日 08:00，或獨立設定
 */
function scanAndScheduleCardReminder() {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

  // 掃描兩本行事曆
  const calendarIds = [
    CONFIG.COURT_CALENDAR_ID,   // 〈1〉開庭（社交活動主要在這裡）
    CONFIG.LAWYER_CALENDAR_ID,  // 〈2〉律師
  ];

  const socialEvents = [];

  for (const calId of calendarIds) {
    try {
      const calendar = CalendarApp.getCalendarById(calId);
      if (!calendar) continue;

      const events = calendar.getEvents(startOfDay, endOfDay);
      for (const event of events) {
        const title = event.getTitle();

        // 跳過已完成（綠色）
        const color = event.getColor();
        if (color && CONFIG.DONE_COLORS.includes(color)) continue;

        const level = isBusinessCardEvent_(title);
        if (level) {
          socialEvents.push({ title: title, level: level });
        }
      }
    } catch (e) {
      Logger.log('名片提醒掃描錯誤（' + calId + '）：' + e.message);
    }
  }

  if (socialEvents.length === 0) {
    Logger.log('今日無社交活動，不排名片提醒');
    return;
  }

  // 去重（同一活動可能標題相同）
  const uniqueTitles = [...new Set(socialEvents.map(e => e.title))];

  // 儲存活動標題到 Script Properties，供 21:50 觸發時讀取
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CARD_REMINDER_EVENTS', JSON.stringify(uniqueTitles));

  // 建立當天 21:50 的一次性 trigger
  // 先清除舊的名片提醒 trigger（避免重複）
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'sendCardReminder') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // 設定今天 21:50 觸發
  const triggerTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 21, 50, 0);

  // 如果已經過了 21:50（例如手動測試），就不排了
  if (today.getTime() > triggerTime.getTime()) {
    Logger.log('已過 21:50，不排名片提醒 trigger');
    return;
  }

  ScriptApp.newTrigger('sendCardReminder')
    .timeBased()
    .at(triggerTime)
    .create();

  Logger.log('✅ 已排 21:50 名片提醒，活動：' + uniqueTitles.join('、'));
}

// ===== 21:50 推播 =====

/**
 * 21:50 觸發：推播名片拍照提醒到 LINE
 */
function sendCardReminder() {
  const props = PropertiesService.getScriptProperties();
  const eventsJson = props.getProperty('CARD_REMINDER_EVENTS');

  if (!eventsJson) {
    Logger.log('無名片提醒資料');
    return;
  }

  const eventTitles = JSON.parse(eventsJson);

  // 組訊息
  let message = '📇 今天有拿到名片嗎？\n\n';

  if (eventTitles.length === 1) {
    message += `今天參加了「${eventTitles[0]}」\n`;
  } else {
    message += '今天參加了：\n';
    eventTitles.forEach(t => {
      message += `▸ ${t}\n`;
    });
  }

  message += '\n掏出來拍給 Claude 建檔，下次見面前幫你複習 👇\n\n';
  message += '📱 手機：shortcuts://run-shortcut?name=開Claude\n';
  message += '💻 筆電：https://claude.ai/new';

  sendLineMessage(message);
  Logger.log('✅ 名片提醒已推播');

  // 清除暫存
  props.deleteProperty('CARD_REMINDER_EVENTS');

  // 清除一次性 trigger（自己）
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'sendCardReminder') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

// ===== 觸發器設定 =====

/**
 * 設定每日定時掃描觸發器（每天 08:00 跟晨報一起跑）
 * 執行一次即可
 */
function setupCardReminderTrigger() {
  // 先清除舊的
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'scanAndScheduleCardReminder') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  ScriptApp.newTrigger('scanAndScheduleCardReminder')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .inTimezone('Asia/Taipei')
    .create();

  Logger.log('✅ 已設定每日 08:00 名片提醒掃描觸發器');
}

// ===== 測試用 =====

/**
 * 手動測試：立即掃描今天的行事曆並排提醒
 */
function testCardScan() {
  scanAndScheduleCardReminder();
}

/**
 * 手動測試：立即發送名片提醒（不等 21:50）
 */
function testCardReminder() {
  // 先手動塞測試資料
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CARD_REMINDER_EVENTS', JSON.stringify(['中律理監事會議', '律師聯誼會']));
  sendCardReminder();
}