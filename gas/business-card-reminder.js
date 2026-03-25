// ============================================================
// 📇 名片拍照提醒 v1.0
// 功能：偵測當天社交活動，21:50 推播 LINE 提醒拍名片給 Claude 建檔
// 依賴：程式碼.gs 的 CONFIG 和 sendLineMessage()
// 日期：2026-03-15
// ============================================================

// ===== 社交活動關鍵字 =====

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

const CARD_EXCLUDE_KEYWORDS = [
  '線上會議', '線上', '視訊',
  '請假', '取消',
  '中律理監事',
];

function isBusinessCardEvent_(summary) {
  if (!summary) return null;
  for (const ex of CARD_EXCLUDE_KEYWORDS) {
    if (summary.includes(ex)) return null;
  }
  if (summary.includes('✅')) return null;
  for (const kw of CARD_HIGH_KEYWORDS) {
    if (summary.includes(kw)) return 'high';
  }
  for (const kw of CARD_MEDIUM_KEYWORDS) {
    if (summary.includes(kw)) return 'medium';
  }
  return null;
}

function scanAndScheduleCardReminder() {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
  const calendarIds = [
    CONFIG.COURT_CALENDAR_ID,
    CONFIG.LAWYER_CALENDAR_ID,
  ];
  const socialEvents = [];
  for (const calId of calendarIds) {
    try {
      const calendar = CalendarApp.getCalendarById(calId);
      if (!calendar) continue;
      const events = calendar.getEvents(startOfDay, endOfDay);
      for (const event of events) {
        const title = event.getTitle();
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
  const uniqueTitles = [...new Set(socialEvents.map(e => e.title))];
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CARD_REMINDER_EVENTS', JSON.stringify(uniqueTitles));
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'sendCardReminder') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  const triggerTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 21, 50, 0);
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

function sendCardReminder() {
  const props = PropertiesService.getScriptProperties();
  const eventsJson = props.getProperty('CARD_REMINDER_EVENTS');
  if (!eventsJson) {
    Logger.log('無名片提醒資料');
    return;
  }
  const eventTitles = JSON.parse(eventsJson);
  let message = '📇 今天有拿到名片嗎？\n\n';
  if (eventTitles.length === 1) {
    message += '今天參加了「' + eventTitles[0] + '」\n';
  } else {
    message += '今天參加了：\n';
    eventTitles.forEach(t => {
      message += '▸ ' + t + '\n';
    });
  }
  message += '\n掏出來拍給 Claude 建檔，下次見面前幫你複習 👇\n\n';
  message += '📱 手機：shortcuts://run-shortcut?name=開Claude\n';
  message += '💻 筆電：https://claude.ai/new';
  sendLineMessage(message);
  Logger.log('✅ 名片提醒已推播');
  props.deleteProperty('CARD_REMINDER_EVENTS');
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'sendCardReminder') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}

function setupCardReminderTrigger() {
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

function testCardScan() {
  scanAndScheduleCardReminder();
}

function testCardReminder() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CARD_REMINDER_EVENTS', JSON.stringify(['中律理監事會議', '律師聯誼會']));
  sendCardReminder();
}
