// ============================================================
// 📋 律師晨報推播系統 v2.32
// 功能：每日 08:00 自動推播今日/明日庭期、辦案期限、諮詢預約、
//       案件待辦到期、時效預警、家庭行程、身心狀態至 LINE（透過 Messaging API）
// 作者：Claude for William
// 日期：2026-04-04
// 變更：v2.31 - readHealthSheet_ 改架構：支援新日聚合檔（HealthMetrics-YYYY-MM-DD 單列）
//               同名多檔時選 lastRow≤5 的日聚合；以最新列為準；月彙總檔為 fallback。
//               getHealthStatus 簡化：僅讀今日，yesterday fallback，不再雙日合併。
// ============================================================

// ======================== 設定區 ========================

const CONFIG = {
  LINE_CHANNEL_ACCESS_TOKEN: PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
  LINE_USER_ID: 'Ua8c6a43c83f292424fb719cb6407ce3c',
  COURT_CALENDAR_ID: '9d8oj0jqrd1lf60908ol444m68@group.calendar.google.com',
  LAWYER_CALENDAR_ID: 'nlkp6pcrl9cs2ret7ssoe9kre0@group.calendar.google.com',
  CONSULTATION_CALENDAR_ID: '5e90kb0v0g9ltcrmatmbkat5t4@group.calendar.google.com',
  FAMILY_CALENDAR_ID: 'kej9tlp9q9qjc95ap5ja610q2k@group.calendar.google.com',
  HIGHLIGHT_CALENDAR_ID: 'a61f3iiaiejbd7t5tcqvpsab2k@group.calendar.google.com',
  PROJECT_MGMT_CALENDAR_ID: '489cda49eb84e47b69f8442a833b3999c009def022ebb81e97ae6bb4244d2d46@group.calendar.google.com',
  NOTION_API_KEY: PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY'),
  CASE_DB_ID: '00dd6a5982664289b639749be8ef25c7',
  TODO_DB_ID: '640e22f21ca4838c9ba7010ad615471e',
  HEALTH_DRIVE_FOLDER_ID: '17s7CskRBaanx4LGz6svc92Q2ZGI7mnt1',
  SKIP_PATTERNS: ['(陳律)', '（陳律）'],
  DONE_PATTERNS: ['✅'],
  DONE_COLORS: ['2', '10', '11'],
  DEADLINE_WARN_DAYS: [30, 7, 3, 1],
  LEAVE_KEYWORDS: ['特休', '休假', '請假', '年假', '補休', '病假', '事假', '喪假', '婚假', '產假', '公假'],
};

// ======================== 共用工具 ========================

function shouldSkipCalendarEvent(event) {
  var title = event.getTitle();
  if (CONFIG.SKIP_PATTERNS.some(function(p) { return title.includes(p); })) return true;
  if (CONFIG.DONE_PATTERNS.some(function(p) { return title.includes(p); })) return true;
  var color = event.getColor();
  if (color && CONFIG.DONE_COLORS.includes(color)) return true;
  return false;
}

function isAllDayEventActiveOnDate(event, targetDate) {
  if (!event.isAllDayEvent()) return true;
  var eventEnd = event.getEndTime();
  var startOfTarget = new Date(targetDate);
  startOfTarget.setHours(0, 0, 0, 0);
  return eventEnd.getTime() > startOfTarget.getTime();
}

function getNextBusinessDay(baseDate) {
  var next = new Date(baseDate);
  next.setDate(next.getDate() + 1);
  var day = next.getDay();
  if (day === 6) next.setDate(next.getDate() + 2);
  if (day === 0) next.setDate(next.getDate() + 1);
  return next;
}

function normalizeTitle(title) {
  return title.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '').trim();
}

function isSimilarTitle(titleA, titleB) {
  var a = normalizeTitle(titleA), b = normalizeTitle(titleB);
  if (a === b) return true;
  if (Math.abs(a.length - b.length) <= 5 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

function formatEvent(e, defaultAllDayEmoji) {
  defaultAllDayEmoji = defaultAllDayEmoji || '';
  if (e.allDay) {
    var hasLeadingEmoji = /^\p{Emoji}/u.test(e.title);
    return (hasLeadingEmoji || !defaultAllDayEmoji) ? '▸ ' + e.title + '\n' : '▸ ' + defaultAllDayEmoji + ' ' + e.title + '\n';
  }
  return '▸ ' + e.time + ' ' + e.title + '\n';
}

function sortEvents(events) {
  return events.slice().sort(function(a, b) {
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    return a.time.localeCompare(b.time);
  });
}

function isLeaveEvent(title) { return CONFIG.LEAVE_KEYWORDS.some(function(kw) { return title.includes(kw); }); }

function truncateLabel_(text, maxLen) {
  return text.length <= maxLen ? text : text.substring(0, maxLen - 1) + '…';
}

// ======================== 主程式 ========================

/**
 * 確保晨報觸發器存在。每次 sendMorningBriefing 執行時先呼叫。
 * 如果觸發器被意外刪除，自動重建（每日 08:00 Asia/Taipei）。
 */
function ensureMorningBriefingTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  var hasMorningTrigger = triggers.some(function(t) {
    return t.getHandlerFunction() === 'sendMorningBriefing' &&
           t.getTriggerSource() === ScriptApp.TriggerSource.CLOCK;
  });
  if (!hasMorningTrigger) {
    Logger.log('⚠️ 晨報觸發器不存在，自動重建...');
    ScriptApp.newTrigger('sendMorningBriefing')
      .timeBased()
      .atHour(8)
      .everyDays(1)
      .inTimezone('Asia/Taipei')
      .create();
    Logger.log('✅ 晨報觸發器已重建：每日 08:00 Asia/Taipei');
  }
}

function sendMorningBriefing() {
  try { ensureMorningBriefingTrigger_(); } catch(e) { Logger.log('Morning trigger check failed: ' + e); }
  try { ensureConsultationFollowupTrigger_(); } catch(e) { Logger.log('Trigger check failed: ' + e); }
  try { ensureAutoCourtPrepTrigger_(); } catch(e) { Logger.log('autoCourtPrep trigger: ' + e); }
  try { ensureHighlightSyncTrigger_(); } catch(e) { Logger.log('highlightSync trigger: ' + e); }
  try {
  var today = new Date();
  var holidayMode = isHolidayMode_();
  var todayStr = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy/MM/dd (EEE)');

  var lawyerAll = sortEvents(getLawyerDeadlineEvents(today));
  var leaveEvents = lawyerAll.filter(function(e) { return isLeaveEvent(e.title) && !e.title.includes('陳律'); });
  var hasLeave = leaveEvents.length > 0;
  var leaveNames = leaveEvents.map(function(e) { return e.title; }).join('、');

  var chenCourtEvents = sortEvents(getChenLawyerCourtEvents_(today));
  var chenLeaveEvents = lawyerAll.filter(function(e) { return e.title.includes('陳律') && isLeaveEvent(e.title); });
  var hasChenActivity = chenCourtEvents.length > 0 || chenLeaveEvents.length > 0;

  var message = '📋 律師晨報｜' + todayStr + '\n━━━━━━━━━━━━━━\n';
  var ritualSection = getRitualReminders();
  if (ritualSection) message += ritualSection;
  if (hasLeave) message += '\n⚠️ ' + leaveNames + '｜今日行政待辦需律師自行處理\n';

  var todayCourt = sortEvents(getCourtEvents(today, 0));
  message += '\n⚖️【今日庭期】\n';
  if (todayCourt.length === 0) { message += '今日無庭期\n'; }
  else { todayCourt.forEach(function(e) { message += formatEvent(e); if (!e.allDay && e.location) message += '  📍 ' + e.location + '\n'; }); }

  var nextBizDay = getNextBusinessDay(today);
  var nextBizDayStr = Utilities.formatDate(nextBizDay, 'Asia/Taipei', 'MM/dd(EEE)');
  var tomorrowCourt = sortEvents(getCourtEvents(nextBizDay, 0));
  var dow = today.getDay();
  var isWeekendOrFriday = (dow === 5 || dow === 6 || dow === 0);
  var tomorrowLabel = isWeekendOrFriday ? '下週一庭期（' + nextBizDayStr + '）' : '明日庭期';
  message += '\n⚖️【' + tomorrowLabel + '】\n';
  if (tomorrowCourt.length === 0) { message += (isWeekendOrFriday ? '下週一無庭期\n' : '明日無庭期\n'); }
  else { tomorrowCourt.forEach(function(e) { message += formatEvent(e); if (!e.allDay && e.location) message += '  📍 ' + e.location + '\n'; }); }

  var consultations = sortEvents(getConsultationEvents(today));
  if (consultations.length > 0) { message += '\n💬【今日諮詢預約】\n'; consultations.forEach(function(e) { message += formatEvent(e); }); }

  var lawyerNonLeave = lawyerAll.filter(function(e) { return !isLeaveEvent(e.title) && !e.title.includes('陳律'); });
  var lawyerDeadlines = lawyerNonLeave.filter(function(e) { return e.title.startsWith('⏰'); });
  var lawyerAdmin = lawyerNonLeave.filter(function(e) { return !e.title.startsWith('⏰'); });
  if (lawyerDeadlines.length > 0) { message += '\n⏰【今日辦案期限】\n'; lawyerDeadlines.forEach(function(e) { message += formatEvent(e); }); }

  var notionAlerts = getNotionAlerts(today);
  if (notionAlerts.todos.length > 0) { message += '\n⏰【案件待辦到期】\n'; notionAlerts.todos.forEach(function(t) { message += '▸ ' + t.caseName + '：' + t.todo + '\n'; }); }

  var highlightEvents = sortEvents(getHighlightEvents(today));
  var highlightEmpty = (highlightEvents.length === 0);
  message += holidayMode ? '\n⭐️【今日亮點】\n' : '\n⭐️【Highlight任務】\n';
  if (highlightEmpty) { message += '⚠️ 今日尚未設定 Highlight，建議現在設定一個最重要的任務。\n'; }
  else { highlightEvents.forEach(function(e) { message += formatEvent(e); }); }

  message += '\n🚨 【時效預警】\n';
  if (notionAlerts.deadlines.length === 0) { message += '目前無時效警示\n'; }
  else { notionAlerts.deadlines.forEach(function(d) { message += '▸ ' + d.emoji + ' ' + d.caseName + '｜剩 ' + d.daysLeft + ' 天（' + d.deadline + '）\n'; }); }

  var gmailAlerts = getGmailAlerts(today);
  if (gmailAlerts) message += gmailAlerts + '\n';

  if (hasChenActivity) { message += '\n👤【陳律動態】\n'; chenLeaveEvents.forEach(function(e) { message += '▸ ' + e.title + '\n'; }); chenCourtEvents.forEach(function(e) { message += formatEvent(e); }); }

  var familyEvents = sortEvents(getFamilyEvents(today, todayCourt, lawyerAll));
  if (familyEvents.length > 0) { message += '\n🏠 【今日家庭行程】\n'; familyEvents.forEach(function(e) { message += formatEvent(e); }); }

  if (today.getDay() === 1) {
    var weekCourt = getWeekCourtEvents(today);
    message += '\n📌 【本週庭期總覽】\n';
    if (weekCourt.length === 0) { message += '本週無庭期\n'; }
    else { weekCourt.forEach(function(e) { message += '▸ ' + e.date + ' ' + e.time + ' ' + e.title + '\n'; }); }
  }

  var healthResult = getHealthStatus(today);

  // 睡眠數據未同步 → 延後整則晨報，用獨立的 retryMorningBriefing 避免跟固定排程 trigger 混淆
  if (healthResult.sleepMissing) {
    var retryCount = parseInt(PropertiesService.getScriptProperties().getProperty('BRIEFING_RETRY_COUNT') || '0');
    if (retryCount < 3) {
      PropertiesService.getScriptProperties().setProperty('BRIEFING_RETRY_COUNT', String(retryCount + 1));
      var retryTime = new Date(new Date().getTime() + 5 * 60 * 1000);
      ScriptApp.newTrigger('retryMorningBriefing')
        .timeBased()
        .at(retryTime)
        .create();
      Logger.log('睡眠數據未同步，延後晨報第 ' + (retryCount + 1) + ' 次（5分鐘後 retryMorningBriefing）');
      // 第一次延後時推送簡短提示
      if (retryCount === 0) {
        try {
          sendLinePush_([{ type: 'text', text: '⏳ 睡眠數據尚未同步，晨報延後 5 分鐘發送。\n請開啟 Health Auto Export 同步一下。' }]);
        } catch (e) { Logger.log('提示推送失敗：' + e.message); }
      }
      return; // 不發晨報，等重試
    } else {
      // 重試 3 次仍無睡眠，放棄等待，發沒有睡眠的版本
      Logger.log('睡眠數據重試已達 3 次上限，發送不含睡眠的晨報');
      PropertiesService.getScriptProperties().deleteProperty('BRIEFING_RETRY_COUNT');
    }
  } else {
    // 有睡眠數據（或不需要重試），清除計數器
    PropertiesService.getScriptProperties().deleteProperty('BRIEFING_RETRY_COUNT');
  }

  message += '\n🧘 【身心狀態】\n' + healthResult.display;
  if (healthResult.isFallback) message += '（注：以上為昨日數據，今日數據同步後將補發）\n';
  message += '\n━━━━━━━━━━━━━━\n';
  message += '💡 今日開庭準備 → https://claude.ai/new?q=今日開庭準備\n';
  message += '💡 領今日身心處方 → https://claude.ai/new?q=' + healthResult.prompt;

  if (healthResult.isFallback) {
    try {
      var nine = new Date(today);
      nine.setHours(12, 0, 0, 0);
      if (nine.getTime() > new Date().getTime()) {
        ScriptApp.newTrigger('sendHealthSupplement')
          .timeBased()
          .at(nine)
          .create();
        Logger.log('已建立 12:00 健康數據補發 trigger');
      }
    } catch (trigErr) { Logger.log('建立補發 trigger 失敗：' + trigErr.message); }
  }

  var lineMessages = buildTextMessages_(message);

  // 任務 Flex Carousel（Phase 1）：Notion 工作待辦 + GCal 行政待辦
  var notionTodos = holidayMode ? [] : getNotionTodoCandidates_(today);
  var taskItems = collectTaskItems_(notionTodos, lawyerAdmin);
  if (taskItems.length > 0) {
    var carouselMsg = buildTaskFlexCarousel_(taskItems);
    if (carouselMsg && lineMessages.length < 4) lineMessages.push(carouselMsg);
  }

  var hlCandidates;
  if (holidayMode) {
    var familyEvts = getFamilyEvents(today, todayCourt, lawyerAll);
    hlCandidates = buildHolidayHighlightCandidates_(familyEvts);
  } else {
    hlCandidates = buildHighlightCandidates_(todayCourt, lawyerDeadlines, consultations, lawyerAdmin, notionAlerts.todos, notionTodos);
  }
  var flexMsg = buildHighlightFlexMessage_(highlightEmpty, hlCandidates);
  if (lineMessages.length < 5) lineMessages.push(flexMsg);

  sendLinePush_(lineMessages);
  Logger.log('晨報推播完成：' + todayStr);
  } catch(e) {
    var errTs = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss');
    sendLinePush_([{type:'text',text:'⚠️ 律師晨報執行失敗\n錯誤：'+e.message+'\n時間：'+errTs}]);
    Logger.log('晨報執行失敗：' + e.message);
  }
}

// ======================== Notion 💼工作待辦 查詢（v2.28 新增） ========================

function getNotionTodoCandidates_(today) {
  var results = [];
  try {
    var response = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + CONFIG.TODO_DB_ID + '/query', {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      payload: JSON.stringify({ filter: { property: 'Checkbox', checkbox: { equals: false } }, page_size: 100 }),
      muteHttpExceptions: true,
    });
    var data = JSON.parse(response.getContentText());
    if (!data.results || (data.status && data.status !== 200)) { Logger.log('Notion 待辦 API 錯誤：' + response.getContentText()); return results; }

    var todayTime = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    var msPerDay = 86400000;

    data.results.forEach(function(page) {
      var props = page.properties;
      var titleProp = props['Title'];
      if (!titleProp || !titleProp.title || titleProp.title.length === 0) return;
      var title = titleProp.title.map(function(t) { return t.plain_text; }).join('');
      if (!title) return;

      var dateProp = props['Date'];
      var dueDate = null, daysUntilDue = null;
      if (dateProp && dateProp.date && dateProp.date.start) {
        dueDate = dateProp.date.start.substring(0, 10);
        daysUntilDue = Math.ceil((new Date(dueDate).getTime() - todayTime) / msPerDay);
      }

      var priorityProp = props['Priority Level'];
      var priority = (priorityProp && priorityProp.select) ? priorityProp.select.name : 'No Priority';

      var include = false, icon = '📋', sortOrder = 99;

      if (daysUntilDue !== null && daysUntilDue < 0) {
        include = true; icon = '🔴'; sortOrder = 0;
      } else if (daysUntilDue !== null && daysUntilDue === 0) {
        include = true; icon = '📅'; sortOrder = 1;
      } else if (priority === 'High Priority') {
        if (daysUntilDue === null || daysUntilDue <= 7) { include = true; icon = '🔥'; sortOrder = 2; }
      } else if (priority === 'Medium Priority') {
        if (daysUntilDue !== null && daysUntilDue <= 3) { include = true; icon = '🟡'; sortOrder = 3; }
      }

      if (include) {
        var suffix = '';
        if (daysUntilDue !== null && daysUntilDue < 0) suffix = '（逾期' + Math.abs(daysUntilDue) + '天）';
        else if (daysUntilDue !== null && daysUntilDue === 0) suffix = '（今日到期）';
        results.push({ icon: icon, title: title, suffix: suffix, sortOrder: sortOrder, daysUntilDue: daysUntilDue !== null ? daysUntilDue : 999, pageId: page.id, dueDate: dueDate });
      }
    });
    results.sort(function(a, b) { return a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.daysUntilDue - b.daysUntilDue; });
  } catch (error) { Logger.log('Notion 待辦查詢錯誤：' + error.message); }
  return results.slice(0, 6);
}

// ======================== 假日模式判斷（v2.31） ========================

function getTaiwanHolidayCalendar_() {
  var strategies = [
    function() { return CalendarApp.getCalendarById('zh-tw.taiwan.official#holiday@group.v.calendar.google.com'); },
    function() { return CalendarApp.getCalendarById('zh-tw.taiwan.official#holiday@group.v.calendar.google.com'); },
    function() { return CalendarApp.getCalendarById('en.taiwan#holiday@group.v.calendar.google.com'); },
    function() {
      var cals = CalendarApp.getCalendarsByName('台灣');
      return cals.length > 0 ? cals[0] : null;
    },
    function() {
      var cals = CalendarApp.getCalendarsByName('Taiwan');
      return cals.length > 0 ? cals[0] : null;
    }
  ];
  for (var i = 0; i < strategies.length; i++) {
    try {
      var cal = strategies[i]();
      if (cal) {
        Logger.log('getTaiwanHolidayCalendar_: 策略 ' + (i+1) + ' 成功，日曆名稱：' + cal.getName());
        return cal;
      }
    } catch(e) {
      Logger.log('getTaiwanHolidayCalendar_: 策略 ' + (i+1) + ' 失敗：' + e.message);
    }
  }
  Logger.log('getTaiwanHolidayCalendar_: 全部策略失敗，回傳 null');
  return null;
}

function isHolidayMode_() {
  var today = new Date();
  var day = today.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) {
    // 週末但要排除補班日
    try {
      var cal = getTaiwanHolidayCalendar_();
      if (cal) {
        var events = cal.getEventsForDay(today);
        for (var i = 0; i < events.length; i++) {
          if (events[i].getTitle().indexOf('補行上班') >= 0) return false; // 補班日→工作模式
        }
      }
    } catch(e) { Logger.log('假日日曆檢查錯誤：' + e.message); }
    return true; // 一般週末→假日模式
  }
  // 非週末，檢查是否為國定假日
  try {
    var cal = getTaiwanHolidayCalendar_();
    if (cal) {
      var events = cal.getEventsForDay(today);
      for (var i = 0; i < events.length; i++) {
        var title = events[i].getTitle();
        if (title.indexOf('補行上班') >= 0) return false;
        // 有假日事件且不是補班→假日模式
        return true;
      }
    }
  } catch(e) { Logger.log('假日日曆檢查錯誤：' + e.message); }
  return false; // 預設工作模式
}

// ======================== Highlight 候選產生（v2.28） ========================

function buildHighlightCandidates_(courtEvents, deadlineEvents, consultations, adminEvents, caseAlertTodos, notionTodos) {
  var candidates = [], seen = {};

  function add(icon, label, fullTitle) {
    var key = fullTitle.substring(0, 50);
    if (seen[key]) return;
    seen[key] = true;
    candidates.push({ icon: icon, label: truncateLabel_(label, 17), data: 'hl:' + truncateLabel_(fullTitle, 280) });
  }

  courtEvents.forEach(function(e) { add('⚖️', e.time ? e.time + ' ' + e.title : e.title, e.title); });
  deadlineEvents.forEach(function(e) { add('⏰', e.title.replace(/^⏰\s*/, ''), e.title); });
  // 有固定時間的諮詢/行政行程已列在晨報正文，不再放進 Highlight（避免重複且無需選擇）
  consultations.forEach(function(e) { if (e.allDay) add('💬', e.title, e.title); });
  adminEvents.forEach(function(e) { if (e.allDay) add('📌', e.title, e.title); });
  caseAlertTodos.forEach(function(t) { add('📋', t.caseName + '：' + t.todo, t.caseName + '：' + t.todo); });
  notionTodos.forEach(function(t) { add(t.icon, t.title + t.suffix, t.title); });

  return candidates.slice(0, 10);
}

// ======================== 假日 Highlight 候選產生（v2.32） ========================

function buildHolidayHighlightCandidates_(familyEvents) {
  var candidates = [], seen = {};

  function add(icon, label, fullTitle) {
    var key = fullTitle.substring(0, 50);
    if (seen[key]) return;
    seen[key] = true;
    candidates.push({ icon: icon, label: truncateLabel_(label, 17), data: 'hl:' + truncateLabel_(fullTitle, 280) });
  }

  // 1. 家庭行事曆今日事件（如果有）
  familyEvents.forEach(function(e) { add('👨‍👩‍👧', e.time ? e.time + ' ' + e.title : e.title, e.title); });

  // 2. 從 5 個 Notion database 撈未完成真實任務
  var notionSources = [
    { dbId: 'bbee22f2-1ca4-8204-8c3a-0762b543100f', icon: '📥' },
    { dbId: '126e22f2-1ca4-82f4-a239-877c4a809bfa',  icon: '👨‍💼' },
    { dbId: 'e95e22f2-1ca4-828e-aefa-07cb6adc890a',  icon: '👨‍👩‍👧' },
    { dbId: '9a2e22f2-1ca4-827e-84a0-877316d747e5',  icon: '♻️' },
    { dbId: '476e22f2-1ca4-82b3-b768-0787728e380f',  icon: '😎' },
  ];

  var today = new Date();
  var todayTime = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  var msPerDay = 86400000;
  var notionTasks = [];
  var priorityRankMap = { 'High Priority': 1, 'Medium Priority': 2, 'Low Priority': 3, 'No Priority': 4 };

  notionSources.forEach(function(src) {
    try {
      var resp = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + src.dbId + '/query', {
        method: 'post',
        headers: { 'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        payload: JSON.stringify({ filter: { property: 'Checkbox', checkbox: { equals: false } }, page_size: 50 }),
        muteHttpExceptions: true,
      });
      var data = JSON.parse(resp.getContentText());
      if (!data.results || (data.status && data.status !== 200)) {
        Logger.log('假日 Notion [' + src.icon + '] 錯誤：' + resp.getContentText());
        return;
      }
      data.results.forEach(function(page) {
        var props = page.properties;
        var titleProp = props['Title'];
        if (!titleProp || !titleProp.title || !titleProp.title.length) return;
        var title = titleProp.title.map(function(t) { return t.plain_text; }).join('');
        if (!title) return;

        var dateProp = props['Date'];
        var dueDate = null, daysUntilDue = null;
        if (dateProp && dateProp.date && dateProp.date.start) {
          dueDate = dateProp.date.start.substring(0, 10);
          daysUntilDue = Math.ceil((new Date(dueDate).getTime() - todayTime) / msPerDay);
        }

        var priorityProp = props['Priority Level'];
        var priority = (priorityProp && priorityProp.select) ? priorityProp.select.name : 'No Priority';
        var priorityRank = priorityRankMap[priority] || 4;
        var isOverdue = daysUntilDue !== null && daysUntilDue < 0;
        var hasDate = dueDate !== null;

        // sortOrder: 逾期=0；其餘 priorityRank*2 + (無日期?1:0)
        var sortOrder = isOverdue ? 0 : priorityRank * 2 + (hasDate ? 0 : 1);

        notionTasks.push({
          icon: src.icon, title: title, sortOrder: sortOrder,
          daysUntilDue: daysUntilDue !== null ? daysUntilDue : 9999, isOverdue: isOverdue
        });
      });
    } catch (e) {
      Logger.log('假日 Notion [' + src.icon + '] 例外：' + e.message);
    }
  });

  // 排序：sortOrder ASC，同 sortOrder 則較早到期優先
  notionTasks.sort(function(a, b) {
    return a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.daysUntilDue - b.daysUntilDue;
  });

  // 填入候選（保留家庭行事曆的 slot）
  var slotsLeft = Math.max(0, 8 - candidates.length);
  notionTasks.slice(0, slotsLeft).forEach(function(t) {
    add(t.icon, t.title, t.title);
  });

  // 週日固定加入下週預覽
  if (today.getDay() === 0) {
    add('📋', '下週預覽', '預覽下週行程與重要事項');
  }

  return candidates.slice(0, 8);
}

// ======================== Highlight Flex Message（v2.28：卡片內嵌按鈕） ========================

function buildHighlightFlexMessage_(highlightEmpty, candidates) {
  var claudeUrl = 'https://claude.ai/new?q=' + encodeURIComponent('設定今日Highlight（推薦模式）');

  if (candidates.length === 0) {
    return {
      type: 'flex', altText: '🎯 設定今日 Highlight',
      contents: { type: 'bubble', size: 'kilo',
        styles: { body: { backgroundColor: '#FFFBEB' }, footer: { backgroundColor: '#FFFBEB' } },
        body: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: '🎯 今日 Highlight', weight: 'bold', size: 'md', color: '#B45309' },
          { type: 'text', text: highlightEmpty ? '今天最重要的一件事是什麼？' : '重新檢視今天的北極星任務', size: 'sm', color: '#92400E', margin: 'md', wrap: true },
          { type: 'text', text: 'Claude 會根據待辦和庭期推薦候選，你選完自動同步。', size: 'xs', color: '#A8A29E', margin: 'md', wrap: true }
        ]},
        footer: { type: 'box', layout: 'vertical', contents: [
          { type: 'button', style: 'primary', color: '#D97706', action: { type: 'uri', label: '⭐ 立即設定 Highlight', uri: claudeUrl } }
        ]}
      }
    };
  }

  var bodyContents = [
    { type: 'text', text: '🎯 今日 Highlight', weight: 'bold', size: 'md', color: '#B45309' },
    { type: 'text', text: '點選今天最重要的任務（可複選）：', size: 'sm', color: '#92400E', margin: 'md', wrap: true },
    { type: 'separator', margin: 'lg' }
  ];

  candidates.forEach(function(c) {
    bodyContents.push({
      type: 'button', style: 'secondary', height: 'sm', margin: 'md',
      action: { type: 'postback', label: c.icon + ' ' + c.label, data: c.data, displayText: '⭐ 設定 Highlight：' + c.label }
    });
  });

  bodyContents.push({ type: 'separator', margin: 'lg' });
  bodyContents.push({ type: 'button', style: 'link', height: 'sm', margin: 'md', action: { type: 'uri', label: '💡 以上都不是？用 Claude 自訂', uri: claudeUrl }, color: '#78716C' });

  return {
    type: 'flex', altText: '🎯 設定今日 Highlight（' + candidates.length + ' 個候選）',
    contents: { type: 'bubble', size: 'mega', styles: { body: { backgroundColor: '#FFFBEB' } },
      body: { type: 'box', layout: 'vertical', paddingBottom: '18px', contents: bodyContents }
    }
  };
}

// ======================== Highlight 任務模組 ========================

function getHighlightEvents(today) {
  var s = new Date(today); s.setHours(0,0,0,0);
  var e = new Date(today); e.setHours(23,59,59,999);
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.HIGHLIGHT_CALENDAR_ID);
    if (!cal) return [];
    var evts = cal.getEvents(s, e), r = [];
    evts.forEach(function(ev) {
      if (shouldSkipCalendarEvent(ev)) return;
      if (!isAllDayEventActiveOnDate(ev, today)) return;
      var ad = ev.isAllDayEvent();
      r.push({ allDay: ad, time: ad ? '' : Utilities.formatDate(ev.getStartTime(), 'Asia/Taipei', 'HH:mm'), title: ev.getTitle() });
    });
    return r;
  } catch (err) { Logger.log('讀取 Highlight 行事曆錯誤：' + err.message); return []; }
}

// ======================== 家庭行程模組 ========================

function getFamilyEvents(today, courtEvents, lawyerEvents) {
  var s = new Date(today); s.setHours(0,0,0,0);
  var e = new Date(today); e.setHours(23,59,59,999);
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.FAMILY_CALENDAR_ID);
    if (!cal) return [];
    var evts = cal.getEvents(s, e);
    var pubTitles = courtEvents.map(function(x){return x.title;}).concat(lawyerEvents.map(function(x){return x.title;}));
    var r = [];
    evts.forEach(function(ev) {
      if (shouldSkipCalendarEvent(ev)) return;
      if (!isAllDayEventActiveOnDate(ev, today)) return;
      var t = ev.getTitle();
      if (pubTitles.some(function(pt){return isSimilarTitle(t, pt);})) return;
      var ad = ev.isAllDayEvent();
      r.push({ allDay: ad, time: ad ? '' : Utilities.formatDate(ev.getStartTime(), 'Asia/Taipei', 'HH:mm'), title: t });
    });
    return r;
  } catch (err) { Logger.log('讀取家庭行事曆錯誤：' + err.message); return []; }
}

// ======================== 身心狀態模組 ========================

// 補發今日健康數據（由 sendMorningBriefing 在 fallback 時建立的 12:00 一次性 trigger 呼叫）
function sendHealthSupplement() {
  // Step 1：清除自己的 trigger，避免重複觸發
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'sendHealthSupplement') {
        ScriptApp.deleteTrigger(triggers[i]);
        Logger.log('已清除 sendHealthSupplement trigger');
      }
    }
  } catch (te) { Logger.log('清除 trigger 失敗：' + te.message); }

  // Step 2：重新讀取今日健康數據
  try {
    var today = new Date();
    var ts = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy-MM-dd');
    var td = readHealthSheet_(ts);
    if (!td) {
      Logger.log('sendHealthSupplement：12:00 仍無今日數據，略過補發');
      return;
    }

    // Step 3：有今日數據 → 組裝補發訊息
    var healthResult = buildHealthDisplay_(td, {});
    var todayStr = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy/MM/dd (EEE)');
    var msg = '📊 今日健康數據補發｜' + todayStr + '\n━━━━━━━━━━━━━━\n';
    msg += '\n🧘 【身心狀態】\n' + healthResult.display;
    msg += '\n━━━━━━━━━━━━━━\n';
    msg += '💡 領今日身心處方 → https://claude.ai/new?q=' + healthResult.prompt;

    sendLinePush_([{ type: 'text', text: msg }]);
    Logger.log('健康數據補發完成：' + todayStr);
  } catch (err) {
    Logger.log('sendHealthSupplement 執行失敗：' + err.message);
  }
}

function retryMorningBriefing() {
  // Step 1：清除自己的 trigger
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'retryMorningBriefing') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
  } catch (te) { Logger.log('清除 retryMorningBriefing trigger 失敗：' + te.message); }

  var retryCount = parseInt(PropertiesService.getScriptProperties().getProperty('BRIEFING_RETRY_COUNT') || '0');

  try {
    var today = new Date();
    var ts = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy-MM-dd');

    // 清除 health file cache，強制重讀（檔案內容可能已更新）
    try { PropertiesService.getScriptProperties().deleteProperty('HEALTH_F_HealthMetrics-' + ts); } catch(e) {}

    var td = readHealthSheet_(ts);
    var pf = function(k){ var v = parseFloat((td||{})[k]); return isNaN(v) ? null : v; };
    var hasSleep = pf('睡眠分析 [睡眠時間] (hr)') || pf('睡眠分析 [Total] (hr)');

    if (!hasSleep && retryCount < 3) {
      // 仍無睡眠，繼續重試
      PropertiesService.getScriptProperties().setProperty('BRIEFING_RETRY_COUNT', String(retryCount + 1));
      var retryTime = new Date(new Date().getTime() + 5 * 60 * 1000);
      ScriptApp.newTrigger('retryMorningBriefing')
        .timeBased()
        .at(retryTime)
        .create();
      Logger.log('睡眠數據仍未同步，第 ' + retryCount + ' 次重試後再設 trigger（第 ' + (retryCount + 1) + ' 次）');
      return;
    }

    // 走到這裡：要嘛睡眠到了，要嘛重試已達上限
    // ⚠️ 不在這裡刪 BRIEFING_RETRY_COUNT，讓 sendMorningBriefing 自己判斷：
    //   - hasSleep=true → sleepMissing=false → sendMorningBriefing 走 else 分支，清除計數器，正常發報
    //   - hasSleep=false, retryCount>=3 → sendMorningBriefing 走「已達上限」分支，清除計數器，發不含睡眠版本
    // 若在這裡提前刪除，sendMorningBriefing 會讀到 retryCount=0，誤以為第一次，重啟整個重試迴圈

    if (!hasSleep) {
      Logger.log('睡眠數據重試已達 3 次上限，發送不含睡眠的晨報');
    } else {
      Logger.log('睡眠數據已同步，發送完整晨報');
    }

    // 呼叫原本的 sendMorningBriefing 發送完整晨報
    sendMorningBriefing();

  } catch (err) {
    Logger.log('retryMorningBriefing 執行失敗：' + err.message);
    // 設 99 而非刪除：防止 sendMorningBriefing 讀到 retryCount=0，重啟重試迴圈
    PropertiesService.getScriptProperties().setProperty('BRIEFING_RETRY_COUNT', '99');
    // 失敗了還是發一版晨報，不要讓律師什麼都收不到
    try { sendMorningBriefing(); } catch(e2) { Logger.log('fallback sendMorningBriefing 也失敗：' + e2.message); }
  }
}

function getHealthStatus(today) {
  var fallback = { display: '尚無健康數據（Health Auto Export 尚未同步）\n', prompt: '充電', isFallback: false, sleepMissing: false };
  try {
    var ts = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy-MM-dd');
    var td = readHealthSheet_(ts);

    // 同時讀取昨日檔案作為 yd
    var y = new Date(today); y.setDate(y.getDate() - 1);
    var ys = Utilities.formatDate(y, 'Asia/Taipei', 'yyyy-MM-dd');
    var yd = readHealthSheet_(ys) || {};

    if (!td) {
      // 今日檔案不存在，用昨日檔案當 td
      if (!yd || Object.keys(yd).length === 0) return fallback;
      var result = buildHealthDisplay_(yd, {});
      result.isFallback = true;
      result.sleepMissing = false;
      return result;
    }

    var result = buildHealthDisplay_(td, yd);
    result.isFallback = false;

    // 檢查：今日檔案有步數但睡眠為空 → Health Auto Export 尚未同步睡眠
    var pf = function(k){ var v = parseFloat(td[k]); return isNaN(v) ? null : v; };
    var hasSleep = pf('睡眠分析 [睡眠時間] (hr)') || pf('睡眠分析 [Total] (hr)');
    var hasSteps = pf('步數 (步)');
    result.sleepMissing = (!hasSleep && !!hasSteps);
    return result;
  } catch (err) {
    Logger.log('讀取健康數據錯誤：' + err.message);
    return { display: '健康數據讀取失敗\n', prompt: '充電', isFallback: false, sleepMissing: false };
  }
}

// 讀取指定日期的健康指標。
// 優先：日聚合檔 HealthMetrics-YYYY-MM-DD（單列，含全部指標）
// Fallback：月彙總檔 HealthMetrics-YYYY-MM（找對應日期列）
function readHealthSheet_(dateStr) {
  // Strategy 1: day-unit file HealthMetrics-YYYY-MM-DD
  var dayFileId = findHealthFileId_('HealthMetrics-' + dateStr);
  if (dayFileId) {
    var data = extractLatestHealthRow_(dayFileId);
    if (data) return data;
  }
  // Strategy 2: monthly aggregate file HealthMetrics-YYYY-MM
  var ym = dateStr.substring(0, 7);
  var monthFileId = findHealthFileId_('HealthMetrics-' + ym);
  if (monthFileId) {
    var mdata = extractMonthlyHealthRow_(monthFileId, dateStr);
    if (mdata) return mdata;
  }
  return null;
}

// 搜尋 Drive 找到指定名稱的 Spreadsheet，快取 file ID。
// 若有多個同名檔（舊逐分鐘 + 新日聚合），選 lastRow ≤ 5 的（日聚合）。
function findHealthFileId_(filename) {
  var cacheKey = 'HEALTH_F_' + filename;
  try {
    var cached = PropertiesService.getScriptProperties().getProperty(cacheKey);
    if (cached) return cached;
  } catch(e) {}
  try {
    var token = ScriptApp.getOAuthToken();
    var q = encodeURIComponent("name = '" + filename + "' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
    var url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&pageSize=5&fields=files(id,name)';
    var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    var files = JSON.parse(resp.getContentText()).files;
    if (!files || files.length === 0) return null;
    var chosen = files[0].id;
    if (files.length > 1) {
      // Multiple files: pick the daily aggregate (fewest rows)
      for (var i = 0; i < files.length; i++) {
        try {
          var sh = SpreadsheetApp.openById(files[i].id).getActiveSheet();
          if (sh.getLastRow() <= 5) { chosen = files[i].id; break; }
        } catch(e) {}
      }
    }
    PropertiesService.getScriptProperties().setProperty(cacheKey, chosen);
    return chosen;
  } catch(e) { Logger.log('findHealthFileId_ 失敗：' + e.message); }
  return null;
}

// 讀日聚合檔（新格式：單列）或逐分鐘檔（舊格式：多列）最新一列資料。
// 逐分鐘檔時，同時補 row 2 的字段（midnight aggregate）。
function extractLatestHealthRow_(fileId) {
  try {
    var sh = SpreadsheetApp.openById(fileId).getActiveSheet();
    var ncols = sh.getLastColumn();
    var nrows = sh.getLastRow();
    if (nrows < 2) return null;
    var h = sh.getRange(1, 1, 1, ncols).getValues()[0];
    // Read the latest row (last row with data)
    var latestRow = sh.getRange(nrows, 1, 1, ncols).getValues()[0];
    var r = {};
    h.forEach(function(x, i) {
      var k = x.toString().trim(); var v = latestRow[i];
      if (k && v !== '' && v !== null && v !== undefined) r[k] = v;
    });
    // For per-minute files: also merge row 2 to fill in any aggregate fields (e.g. sleep at midnight)
    if (nrows > 5) {
      var row2 = sh.getRange(2, 1, 1, ncols).getValues()[0];
      h.forEach(function(x, i) {
        var k = x.toString().trim(); var v = row2[i];
        if (k && !r.hasOwnProperty(k) && v !== '' && v !== null && v !== undefined) r[k] = v;
      });
    }
    return Object.keys(r).length > 1 ? r : null;
  } catch(e) { Logger.log('extractLatestHealthRow_ 失敗：' + e.message); return null; }
}

// 月彙總檔：找到 dateStr 對應的列並回傳資料。
function extractMonthlyHealthRow_(fileId, dateStr) {
  try {
    var sh = SpreadsheetApp.openById(fileId).getActiveSheet();
    var ncols = sh.getLastColumn();
    var nrows = sh.getLastRow();
    if (nrows < 2) return null;
    var h = sh.getRange(1, 1, 1, ncols).getValues()[0];
    var aCol = sh.getRange(2, 1, nrows - 1, 1).getValues();
    for (var i = 0; i < aCol.length; i++) {
      var cell = aCol[i][0];
      var cellStr = (cell instanceof Date) ? Utilities.formatDate(cell, 'Asia/Taipei', 'yyyy-MM-dd') : cell.toString();
      if (cellStr.indexOf(dateStr) === 0) {
        var row = sh.getRange(i + 2, 1, 1, ncols).getValues()[0];
        var r = {};
        h.forEach(function(x, ci) {
          var k = x.toString().trim(); var v = row[ci];
          if (k && v !== '' && v !== null && v !== undefined) r[k] = v;
        });
        return Object.keys(r).length > 1 ? r : null;
      }
    }
  } catch(e) { Logger.log('extractMonthlyHealthRow_ 失敗：' + e.message); }
  return null;
}

function buildHealthDisplay_(td, yd) {
  var pf = function(k,s){ var v=parseFloat(s[k]); return isNaN(v)?null:v; };
  // Sleep is in yesterday's daily aggregate; fallback to yd when td is missing
  var st=pf('睡眠分析 [睡眠時間] (hr)',td)||pf('睡眠分析 [Total] (hr)',td)||pf('睡眠分析 [睡眠時間] (hr)',yd)||pf('睡眠分析 [Total] (hr)',yd);
  var sr=pf('睡眠分析 [REM] (hr)',td)||pf('睡眠分析 [REM] (hr)',yd);
  var sd=pf('睡眠分析 [深層] (hr)',td)||pf('睡眠分析 [深層] (hr)',yd);
  // HRV/HR from td (current day intraday), fallback to yd
  var hv=pf('心率變異性 (毫秒)',td)||pf('心率變異性 (毫秒)',yd);
  var rh=pf('靜止心率 (bpm)',td)||pf('靜止心率 (bpm)',yd);
  var bo=pf('血氧飽和度 (%)',td)||pf('血氧飽和度 (%)',yd);
  var br=pf('呼吸速率 (次/分)',td)||pf('呼吸速率 (次/分)',yd);
  var steps=pf('步數 (步)',yd)||pf('步數 (步)',td), exMin=pf('Apple 運動時間 (分鐘)',yd)||pf('Apple 運動時間 (分鐘)',td);
  function ml(v,g,y){ if(v===null)return''; return v>=g?'🟢':v>=y?'🟡':'🔴'; }
  var status='🟢', stxt='狀態良好';
  if(st!==null){ if(st<5.5){status='🔴';stxt='睡眠嚴重不足';} else if(st<6.5&&status!=='🔴'){status='🟡';stxt='睡眠不足';} }
  if(hv!==null){ if(hv<25&&status!=='🔴'){status='🔴';stxt='壓力偏高';} else if(hv<35&&status==='🟢'){status='🟡';stxt='留意壓力';} }
  var disp=status+' 身心狀態：'+stxt+'\n', m=[];
  if(st!==null) m.push(ml(st,6.5,5.5)+' 睡眠 '+st.toFixed(1)+'h');
  if(sr!==null) m.push(ml(sr,1.1,0.8)+' REM '+sr.toFixed(1)+'h');
  if(hv!==null) m.push(ml(hv,35,25)+' HRV '+hv.toFixed(0)+'ms');
  if(steps!==null&&steps>0) m.push(ml(steps,7000,3000)+' 步數 '+Math.round(steps));
  if(exMin!==null&&exMin>0) m.push(ml(exMin,30,10)+' 運動 '+Math.round(exMin)+'min');
  if(m.length>0) disp+=m.join('｜')+'\n';
  var pp=[];
  if(st!==null) pp.push('sleep'+st.toFixed(1)+'h'); if(sd!==null) pp.push('deep'+sd.toFixed(1)+'h');
  if(sr!==null) pp.push('REM'+sr.toFixed(1)+'h'); if(hv!==null) pp.push('HRV'+hv.toFixed(0)+'ms');
  if(rh!==null) pp.push('rhr'+rh.toFixed(0)+'bpm'); if(br!==null) pp.push('br'+br.toFixed(1));
  if(bo!==null) pp.push('spo2-'+bo.toFixed(1));
  if(steps!==null&&steps>0) pp.push('steps'+Math.round(steps)); if(exMin!==null&&exMin>0) pp.push('ex'+Math.round(exMin)+'min');
  return { display: disp, prompt: 'charge,'+pp.join(',') };
}

// ======================== Google Calendar 模組 ========================

function getCourtEvents(baseDate, offsetDays) {
  var td = new Date(baseDate); td.setDate(td.getDate()+offsetDays);
  var s = new Date(td); s.setHours(0,0,0,0); var e = new Date(td); e.setHours(23,59,59,999);
  try { var cal = CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID); if(!cal) return []; var evts=cal.getEvents(s,e), r=[];
    evts.forEach(function(ev){ if(shouldSkipCalendarEvent(ev))return; if(!isAllDayEventActiveOnDate(ev,td))return; var ad=ev.isAllDayEvent();
      r.push({allDay:ad, time:ad?'':Utilities.formatDate(ev.getStartTime(),'Asia/Taipei','HH:mm'), title:ev.getTitle(), location:ev.getLocation()||''}); }); return r;
  } catch(err){ Logger.log('讀取庭期行事曆錯誤：'+err.message); return []; }
}

function getWeekCourtEvents(mon) {
  var r=[]; for(var i=0;i<5;i++){ var de=getCourtEvents(mon,i); var td=new Date(mon);td.setDate(td.getDate()+i);
    var ds=Utilities.formatDate(td,'Asia/Taipei','MM/dd(EEE)'); de.forEach(function(e){r.push({date:ds,time:e.time,title:e.title});}); } return r;
}

function getLawyerDeadlineEvents(today) {
  var s=new Date(today);s.setHours(0,0,0,0); var e=new Date(today);e.setHours(23,59,59,999);
  try { var cal=CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID); if(!cal)return[]; var evts=cal.getEvents(s,e),r=[];
    evts.forEach(function(ev){if(shouldSkipCalendarEvent(ev))return;if(!isAllDayEventActiveOnDate(ev,today))return;var ad=ev.isAllDayEvent();
      r.push({allDay:ad,time:ad?'':Utilities.formatDate(ev.getStartTime(),'Asia/Taipei','HH:mm'),title:ev.getTitle(),eventId:ev.getId()});}); return r;
  } catch(err){Logger.log('讀取律師行事曆錯誤：'+err.message);return[];}
}

function getConsultationEvents(today) {
  var s=new Date(today);s.setHours(0,0,0,0); var e=new Date(today);e.setHours(23,59,59,999);
  try { var cal=CalendarApp.getCalendarById(CONFIG.CONSULTATION_CALENDAR_ID); if(!cal)return[];
    return cal.getEvents(s,e).filter(function(ev){return ev.getTitle().includes('王律');})
      .map(function(ev){var ad=ev.isAllDayEvent();return{allDay:ad,time:ad?'':Utilities.formatDate(ev.getStartTime(),'Asia/Taipei','HH:mm'),title:ev.getTitle()};})
      .sort(function(a,b){return a.time.localeCompare(b.time);});
  } catch(err){Logger.log('讀取諮詢預約行事曆錯誤：'+err.message);return[];}
}

function getChenLawyerCourtEvents_(today) {
  var s=new Date(today);s.setHours(0,0,0,0); var e=new Date(today);e.setHours(23,59,59,999);
  try { var cal=CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID); if(!cal)return[]; var evts=cal.getEvents(s,e),r=[];
    evts.forEach(function(ev){var t=ev.getTitle();if(!t.match(/^[\(（]陳律[\)）]/))return;
      if(CONFIG.DONE_PATTERNS.some(function(p){return t.includes(p);}))return;var c=ev.getColor();if(c&&CONFIG.DONE_COLORS.includes(c))return;
      if(!isAllDayEventActiveOnDate(ev,today))return;var ad=ev.isAllDayEvent();r.push({allDay:ad,time:ad?'':Utilities.formatDate(ev.getStartTime(),'Asia/Taipei','HH:mm'),title:t});}); return r;
  } catch(err){Logger.log('讀取陳律開庭事件錯誤：'+err.message);return[];}
}

// ======================== Notion 案件追蹤 API 模組 ========================

function getNotionAlerts(today) {
  var result={todos:[],deadlines:[]};
  try { var resp=UrlFetchApp.fetch('https://api.notion.com/v1/databases/'+CONFIG.CASE_DB_ID+'/query',{method:'post',
    headers:{'Authorization':'Bearer '+CONFIG.NOTION_API_KEY,'Notion-Version':'2022-06-28','Content-Type':'application/json'},
    payload:JSON.stringify({filter:{property:'狀態',select:{equals:'進行中'}},page_size:100}),muteHttpExceptions:true});
    var data=JSON.parse(resp.getContentText()); if(data.status&&data.status!==200){Logger.log('Notion API 錯誤：'+resp.getContentText());return result;}
    var tt=new Date(today.getFullYear(),today.getMonth(),today.getDate()).getTime();
    data.results.forEach(function(p){var pr=p.properties;var cn=getNotionTitle(pr['案件簡稱']);if(!cn)return;
      var todo=getNotionRichText(pr['待辦事項']),ncd=getNotionDate(pr['下次庭期']);
      if(todo&&ncd){var d=Math.ceil((new Date(ncd).getTime()-tt)/86400000);if(d<=3&&d>=0)result.todos.push({caseName:cn,todo:todo.substring(0,50)+(todo.length>50?'...':'')});}
      var dl=getNotionDate(pr['時效截止']);if(dl){var dl2=Math.ceil((new Date(dl).getTime()-tt)/86400000);
        if(dl2<=30&&dl2>=0){var em='⚠️';if(dl2<=1)em='🔴';else if(dl2<=3)em='🟠';else if(dl2<=7)em='🟡';result.deadlines.push({caseName:cn,deadline:dl,daysLeft:dl2,emoji:em});}
        if(dl2<0)result.deadlines.push({caseName:cn,deadline:dl,daysLeft:dl2,emoji:'❌'});}});
    result.deadlines.sort(function(a,b){return a.daysLeft-b.daysLeft;});
  } catch(err){Logger.log('Notion API 錯誤：'+err.message);} return result;
}

function getNotionTitle(p){if(!p||!p.title||p.title.length===0)return'';return p.title.map(function(t){return t.plain_text;}).join('');}
function getNotionRichText(p){if(!p||!p.rich_text||p.rich_text.length===0)return'';return p.rich_text.map(function(t){return t.plain_text;}).join('');}
function getNotionDate(p){if(!p||!p.date||!p.date.start)return null;return p.date.start;}

// ======================== Gmail 時效性通知攔截（v2.32） ========================

function getGmailAlerts(today) {
  try {
    var query = 'is:unread newer_than:2d (from:律師公會 OR from:nchu.edu.tw OR from:gov.tw OR from:laf.org.tw)';
    var threads = GmailApp.search(query, 0, 20);
    if (threads.length === 0) return '';

    var URGENCY_KW = ['報名', '開會', '期限', '截止', '回覆', '出席', '簽到', '繳費', '註冊', '研習', '訓練', '會議', '通知', '調查表', '問卷'];

    function getSenderAlias(from) {
      if (from.indexOf('律師公會') >= 0) return '公會';
      if (from.indexOf('nchu') >= 0 || from.indexOf('中興') >= 0) return '中興';
      if (from.indexOf('laf') >= 0 || from.indexOf('法律扶助') >= 0) return '法扶';
      if (from.indexOf('judicial') >= 0) return '司法院';
      if (from.indexOf('moj') >= 0) return '法務部';
      if (from.indexOf('gov.tw') >= 0) return '政府';
      var m = from.match(/^([^<@\n]+)/);
      return m ? m[1].trim().substring(0, 4) : from.substring(0, 4);
    }

    var todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    var yr = today.getFullYear();

    function extractDeadlineDate(text) {
      var patterns = [
        { re: /(\d{3,4})年(\d{1,2})月(\d{1,2})日(?:前|截止)/, fn: function(m) {
          var y = parseInt(m[1]) < 1000 ? parseInt(m[1]) + 1911 : parseInt(m[1]);
          return new Date(y, parseInt(m[2])-1, parseInt(m[3]));
        }},
        { re: /截止(?:日期)?[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/, fn: function(m) {
          return new Date(parseInt(m[1]), parseInt(m[2])-1, parseInt(m[3]));
        }},
        { re: /截止(?:日期)?[：:]\s*(\d{1,2})\/(\d{1,2})/, fn: function(m) {
          return new Date(yr, parseInt(m[1])-1, parseInt(m[2]));
        }},
        { re: /(\d{1,2})月(\d{1,2})日前/, fn: function(m) {
          return new Date(yr, parseInt(m[1])-1, parseInt(m[2]));
        }},
        { re: /(\d{1,2})\/(\d{1,2})前/, fn: function(m) {
          return new Date(yr, parseInt(m[1])-1, parseInt(m[2]));
        }},
      ];
      for (var i = 0; i < patterns.length; i++) {
        var mm = text.match(patterns[i].re);
        if (mm) {
          var dt = patterns[i].fn(mm);
          if (!isNaN(dt.getTime()) && dt.getTime() >= todayStart) {
            return { date: dt, str: (dt.getMonth()+1) + '/' + dt.getDate() };
          }
        }
      }
      return null;
    }

    var alerts = [];
    threads.forEach(function(thread) {
      try {
        var msgs = thread.getMessages();
        var msg = msgs[msgs.length - 1];
        if (!msg.isUnread()) return;
        var from = msg.getFrom() || '';
        var subject = msg.getSubject() || '';
        var body500 = msg.getPlainBody().substring(0, 500);
        var combined = subject + ' ' + body500;

        var hasUrgency = URGENCY_KW.some(function(kw) { return combined.indexOf(kw) >= 0; });
        if (!hasUrgency) return;

        var alias = getSenderAlias(from);
        var dl = extractDeadlineDate(combined);

        if (dl) {
          try {
            var lawyerCal = CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID);
            if (lawyerCal) {
              var evTitle = '⏰期限：' + alias;
              var ds = new Date(dl.date); ds.setHours(0,0,0,0);
              var de = new Date(dl.date); de.setHours(23,59,59,999);
              var dup = lawyerCal.getEvents(ds, de).some(function(ev) { return ev.getTitle() === evTitle; });
              if (!dup) lawyerCal.createAllDayEvent(evTitle, dl.date);
            }
          } catch(calErr) { Logger.log('Gmail alert 建行事曆失敗：' + calErr.message); }
        }

        var tag = dl ? '⌛截止 ' + dl.str : '';
        if (!tag) {
          var mm2 = combined.match(/(\d{1,2})月(\d{1,2})日/);
          if (mm2 && (combined.indexOf('開會') >= 0 || combined.indexOf('會議') >= 0 || combined.indexOf('出席') >= 0)) {
            tag = '📅開會 ' + mm2[1] + '/' + mm2[2];
          }
        }
        if (!tag) tag = '📌注意';

        alerts.push({ alias: alias, subject: subject.substring(0, 30), tag: tag });
      } catch(msgErr) { Logger.log('Gmail 讀取訊息錯誤：' + msgErr.message); }
    });

    if (alerts.length === 0) return '';

    var out = '\n📧 重要 Email 通知\n━━━━━━━━━━━━\n';
    alerts.forEach(function(a) {
      out += '• [' + a.alias + '] ' + a.tag + '\n';
      out += '  「' + a.subject + '」\n';
    });
    out += '━━━━━━━━━━━━';
    return out;

  } catch(err) {
    Logger.log('getGmailAlerts 執行失敗：' + err.message);
    return '';
  }
}

// ======================== LINE Messaging API 模組 ========================

function buildTextMessages_(text) {
  var ML=4500,msgs=[]; if(text.length<=ML){msgs.push({type:'text',text:text});}
  else{var ls=text.split('\n'),cur='';ls.forEach(function(l){if((cur+'\n'+l).length>ML){msgs.push({type:'text',text:cur});cur=l;}else{cur=cur?cur+'\n'+l:l;}});if(cur)msgs.push({type:'text',text:cur});}
  return msgs.slice(0,4);
}

function sendLinePush_(mo) {
  try{var r=UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push',{method:'post',headers:{'Content-Type':'application/json','Authorization':'Bearer '+CONFIG.LINE_CHANNEL_ACCESS_TOKEN},
    payload:JSON.stringify({to:CONFIG.LINE_USER_ID,messages:mo.slice(0,5)}),muteHttpExceptions:true});
    if(r.getResponseCode()!==200)Logger.log('LINE 推播失敗：'+r.getContentText());else Logger.log('LINE 推播成功（共 '+mo.length+' 則訊息）');
  }catch(err){Logger.log('LINE 推播錯誤：'+err.message);}
}

function sendLineMessage(text){sendLinePush_(buildTextMessages_(text));}

function pushCourtPrepManual() {
  var msg1 = '📋 開庭準備已產出（完整版）\n\n案件：黃雋廷案 115審金訴818\n庭期：04/13(Mon) 09:50\n法院：臺灣臺中地方法院\n類型：刑事審理｜開庭\n\n👉 https://www.notion.so/33ee22f21ca481a39430face3bcb28af\n\n✅ 含完整案情、辯護策略、雷區提示';
  var msg2 = '📋 開庭準備已產出（完整版）\n\n案件：劉懷仁案 115訴137\n庭期：04/13(Mon) 14:00\n法院：臺灣苗栗地方法院\n類型：刑事審理｜開庭\n\n👉 https://www.notion.so/33ee22f21ca481989252cadc11808ddb\n\n✅ 含DB實證法官傾向、量刑預估、§57人設狀態';
  sendLinePush_(buildTextMessages_(msg1));
  sendLinePush_(buildTextMessages_(msg2));
}

function setScriptProperty(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
  return 'Set ' + key + ' (len=' + value.length + ')';
}



function sendLineReply_(rt,mo) {
  try{UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply',{method:'post',headers:{'Content-Type':'application/json','Authorization':'Bearer '+CONFIG.LINE_CHANNEL_ACCESS_TOKEN},
    payload:JSON.stringify({replyToken:rt,messages:mo.slice(0,5)}),muteHttpExceptions:true});
  }catch(err){Logger.log('LINE Reply 錯誤：'+err.message);}
}

// ======================== Webhook doPost ========================

function doPost(e) {
  try{if(!e||!e.postData||!e.postData.contents)return ContentService.createTextOutput('OK');
    var body=JSON.parse(e.postData.contents);(body.events||[]).forEach(function(ev){
      if(ev.type==='postback'&&ev.postback&&ev.postback.data){
        var d=ev.postback.data;
        if(d.indexOf('hl:')===0) handleHighlightSelection_(ev.replyToken,d.substring(3));
        else if(d.indexOf('task:')===0) handleTaskAction_(ev.replyToken,d);
      }
      if(ev.type==='message'&&ev.message&&ev.message.type==='text'&&ev.replyToken) {
        handleMessageEvent_(ev.replyToken,ev.message.text);
      }
    });}catch(err){Logger.log('doPost 錯誤：'+err.message);}
  return ContentService.createTextOutput('OK');
}

function handleHighlightSelection_(rt,title) {
  var today=new Date(),ok=false;
  try{var cal=CalendarApp.getCalendarById(CONFIG.HIGHLIGHT_CALENDAR_ID);if(cal){
    var s=new Date(today);s.setHours(0,0,0,0);var e=new Date(today);e.setHours(23,59,59,999);
    if(!cal.getEvents(s,e).some(function(ev){return ev.getTitle()===title;}))cal.createAllDayEvent(title,today);ok=true;}
  }catch(err){Logger.log('建立 Highlight 事件錯誤：'+err.message);}
  sendLineReply_(rt,[{type:'text',text:ok?'⭐ 已設定 Highlight：\n'+title+'\n\n可繼續點選其他項目複選 💪':'❌ 設定失敗，請用 Claude 手動設定。'}]);
}

// ======================== 任務 Flex Carousel（Phase 1） ========================

function collectTaskItems_(notionTodos, calAdminEvents) {
  var items = [];
  notionTodos.forEach(function(t) {
    if (!t.pageId) return;
    var dueTxt = '';
    if (t.daysUntilDue < 0) dueTxt = '逾期' + Math.abs(t.daysUntilDue) + '天';
    else if (t.daysUntilDue === 0) dueTxt = '今日到期';
    else if (t.daysUntilDue < 999 && t.dueDate) dueTxt = t.dueDate;
    items.push({ icon: t.icon, title: t.title, source: 'Notion', taskId: t.pageId,
      dueTxt: dueTxt, sourceTxt: 'Notion待辦', sortOrder: t.sortOrder });
  });
  calAdminEvents.forEach(function(ev) {
    if (!ev.eventId) return;
    items.push({ icon: '📌', title: ev.title.replace(/^📌\s*/, ''), source: 'GCal', taskId: ev.eventId,
      dueTxt: '今日', sourceTxt: '行事曆', sortOrder: 10 });
  });
  items.sort(function(a, b) { return a.sortOrder - b.sortOrder; });
  return items;
}

function getPriorityColor_(icon) {
  if (icon === '🔴') return '#DC2626';
  if (icon === '📅') return '#D97706';
  if (icon === '🔥') return '#9333EA';
  if (icon === '🟡') return '#0891B2';
  return '#4B5563';
}

function buildTaskFlexCarousel_(taskItems) {
  var MAX_BUBBLES = 12;
  var shown = taskItems.slice(0, MAX_BUBBLES);
  var bubbles = shown.map(function(item) {
    var doneData   = 'task:done:'   + item.source + ':' + item.taskId;
    var snoozeData = 'task:snooze:' + item.source + ':' + item.taskId;
    var delData    = 'task:del:'    + item.source + ':' + item.taskId;
    if (doneData.length   > 295) doneData   = doneData.substring(0, 295);
    if (snoozeData.length > 295) snoozeData = snoozeData.substring(0, 295);
    if (delData.length    > 295) delData    = delData.substring(0, 295);
    var titleTxt = item.title.length > 40 ? item.title.substring(0, 39) + '…' : item.title;
    var subTxt   = item.sourceTxt + (item.dueTxt ? ' · ' + item.dueTxt : '');
    var bgColor  = getPriorityColor_(item.icon);
    var shortTitle = truncateLabel_(item.title, 20);
    return {
      type: 'bubble', size: 'kilo',
      header: { type: 'box', layout: 'horizontal', backgroundColor: bgColor, paddingAll: '10px',
        contents: [{ type: 'text', text: item.icon + ' ' + item.sourceTxt, size: 'xs', color: '#FFFFFF', weight: 'bold' }] },
      body: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
        contents: [
          { type: 'text', text: titleTxt, weight: 'bold', size: 'sm', wrap: true, maxLines: 3, color: '#1C1917' },
          { type: 'text', text: subTxt, size: 'xxs', color: '#78716C', margin: 'sm' }
        ]},
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: '8px',
        contents: [
          { type: 'button', style: 'primary', height: 'sm', flex: 1, color: '#16A34A',
            action: { type: 'postback', label: '✅', data: doneData, displayText: '✅ 完成：' + shortTitle } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1,
            action: { type: 'postback', label: '⏰+1', data: snoozeData, displayText: '⏰ 延後：' + shortTitle } },
          { type: 'button', style: 'secondary', height: 'sm', flex: 1,
            action: { type: 'postback', label: '🗑', data: delData, displayText: '🗑 刪除：' + shortTitle } }
        ]}
    };
  });
  if (bubbles.length === 0) return null;
  var altSuffix = taskItems.length > MAX_BUBBLES ? '（顯示前' + MAX_BUBBLES + '項）' : '';
  return {
    type: 'flex',
    altText: '📋 今日 ' + taskItems.length + ' 項任務' + altSuffix,
    contents: { type: 'carousel', contents: bubbles }
  };
}

// ======================== 任務動作處理（Phase 2） ========================

function handleTaskAction_(replyToken, data) {
  var parts = data.split(':');
  if (parts.length < 4) { sendLineReply_(replyToken, [{type:'text', text:'❌ 無效的任務指令'}]); return; }
  var action = parts[1];
  var source = parts[2];
  var taskId = parts.slice(3).join(':');  // GCal ID 可能含冒號，重新合併
  var result = { ok: false, msg: '❌ 操作失敗' };
  try {
    if (source === 'Notion') {
      if (action === 'done')   result = notionCompleteTask_(taskId);
      else if (action === 'snooze') result = notionSnoozeTask_(taskId);
      else if (action === 'del')    result = notionDeleteTask_(taskId);
    } else if (source === 'GCal') {
      if (action === 'done')   result = gcalCompleteEvent_(taskId);
      else if (action === 'snooze') result = gcalSnoozeEvent_(taskId);
      else if (action === 'del')    result = gcalDeleteEvent_(taskId);
    } else if (source === 'TickTick') {
      result = { ok: false, msg: '⚠️ TickTick 暫無 API 整合，請手動處理' };
    }
  } catch(err) {
    Logger.log('handleTaskAction_ 錯誤：' + err.message);
    result = { ok: false, msg: '❌ 操作失敗：' + err.message };
  }

  // Reply 只送確認文字（快速，避免 reply token 過期）
  sendLineReply_(replyToken, [{type:'text', text: result.msg}]);

  // 任何操作成功後，用 debounce 延遲推 Highlight（避免多次操作時每次都打斷畫面）
  if (result.ok) scheduleHighlightPush_();
}

// Debounce：任務操作後延遲 ~1 分鐘才推 Highlight，避免多次連點時每次都打斷畫面
// 每次呼叫都會取消舊的 trigger，重設新的（從最後一次操作起算 1 分鐘）
function scheduleHighlightPush_() {
  // 先清光所有同名 trigger（不依賴 ID，防止殘留累積）
  try {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'pushHighlightPending_') ScriptApp.deleteTrigger(t);
    });
  } catch(e) {}
  // 建新 trigger：從現在起 65 秒後執行（GAS 最小精度約 1 分鐘）
  try {
    var when = new Date(Date.now() + 65000);
    ScriptApp.newTrigger('pushHighlightPending_').timeBased().at(when).create();
    Logger.log('已安排 Highlight 推播：' + when.toISOString());
  } catch(err) { Logger.log('scheduleHighlightPush_ 失敗：' + err.message); }
}

function pushHighlightPending_() {
  // 清除所有同名 trigger（自己 + 任何殘留）
  try {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'pushHighlightPending_') ScriptApp.deleteTrigger(t);
    });
  } catch(e) {}
  // 推更新版 Highlight
  try {
    var hlFlex = buildRefreshedHighlightFlex_();
    sendLinePush_([hlFlex]);
    Logger.log('Highlight debounce 推播完成');
  } catch(err) { Logger.log('pushHighlightPending_ 失敗：' + err.message); }
}

// 完成任務後重新產出 Highlight flex（重新抓 Notion todos，已完成的已被 checkbox filter 排除）
function buildRefreshedHighlightFlex_() {
  var today = new Date();
  var holidayMode = isHolidayMode_();
  var hlEvents = getHighlightEvents(today);
  var highlightEmpty = (hlEvents.length === 0);
  var candidates;
  if (holidayMode) {
    candidates = buildHolidayHighlightCandidates_(getFamilyEvents(today, [], []));
  } else {
    var todayCourt    = sortEvents(getCourtEvents(today, 0));
    var lawyerAll     = sortEvents(getLawyerDeadlineEvents(today));
    var lawyerNL      = lawyerAll.filter(function(e){ return !isLeaveEvent(e.title) && !e.title.includes('陳律'); });
    var lawyerDeadlines = lawyerNL.filter(function(e){ return e.title.startsWith('⏰'); });
    var lawyerAdmin     = lawyerNL.filter(function(e){ return !e.title.startsWith('⏰'); });
    var consultations = sortEvents(getConsultationEvents(today));
    var notionTodos   = getNotionTodoCandidates_(today);  // 重新抓，checkbox:true 的已被 filter 排除
    candidates = buildHighlightCandidates_(todayCourt, lawyerDeadlines, consultations, lawyerAdmin, [], notionTodos);
  }
  return buildHighlightFlexMessage_(highlightEmpty, candidates);
}

function notionCompleteTask_(pageId) {
  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, {
    method: 'patch',
    headers: { 'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    payload: JSON.stringify({ properties: { 'Checkbox': { checkbox: true } } }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() === 200) return { ok: true, msg: '✅ 已完成任務' };
  return { ok: false, msg: '❌ 完成失敗：' + resp.getContentText().substring(0, 100) };
}

function notionSnoozeTask_(pageId) {
  var newDate;
  try {
    var getResp = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY, 'Notion-Version': '2022-06-28' },
      muteHttpExceptions: true
    });
    if (getResp.getResponseCode() === 200) {
      var pageData = JSON.parse(getResp.getContentText());
      var dp = pageData.properties && pageData.properties['Date'];
      if (dp && dp.date && dp.date.start) {
        var base = new Date(dp.date.start); base.setDate(base.getDate() + 1);
        newDate = Utilities.formatDate(base, 'Asia/Taipei', 'yyyy-MM-dd');
      }
    }
  } catch(e) {}
  if (!newDate) {
    var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    newDate = Utilities.formatDate(tomorrow, 'Asia/Taipei', 'yyyy-MM-dd');
  }
  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, {
    method: 'patch',
    headers: { 'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    payload: JSON.stringify({ properties: { 'Date': { date: { start: newDate } } } }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() === 200) return { ok: true, msg: '⏰ 已延後至 ' + newDate };
  return { ok: false, msg: '❌ 延後失敗：' + resp.getContentText().substring(0, 100) };
}

function notionDeleteTask_(pageId) {
  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, {
    method: 'patch',
    headers: { 'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    payload: JSON.stringify({ archived: true }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() === 200) return { ok: true, msg: '🗑 已刪除任務' };
  return { ok: false, msg: '❌ 刪除失敗：' + resp.getContentText().substring(0, 100) };
}

function gcalCompleteEvent_(eventId) {
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID);
    var ev = cal.getEventById(eventId);
    if (!ev) return { ok: false, msg: '❌ 找不到行事曆事件' };
    var t = ev.getTitle();
    if (!t.startsWith('✅')) ev.setTitle('✅ ' + t);
    return { ok: true, msg: '✅ 已標記完成：' + t };
  } catch(err) { return { ok: false, msg: '❌ 完成失敗：' + err.message }; }
}

function gcalSnoozeEvent_(eventId) {
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID);
    var ev = cal.getEventById(eventId);
    if (!ev) return { ok: false, msg: '❌ 找不到行事曆事件' };
    var t = ev.getTitle();
    if (ev.isAllDayEvent()) {
      var nd = new Date(ev.getAllDayStartDate()); nd.setDate(nd.getDate() + 1);
      ev.setAllDayDate(nd);
      return { ok: true, msg: '⏰ 已延後至 ' + Utilities.formatDate(nd, 'Asia/Taipei', 'MM/dd') + '：' + t };
    } else {
      var ns = new Date(ev.getStartTime()); ns.setDate(ns.getDate() + 1);
      var ne = new Date(ev.getEndTime()); ne.setDate(ne.getDate() + 1);
      ev.setTime(ns, ne);
      return { ok: true, msg: '⏰ 已延後至 ' + Utilities.formatDate(ns, 'Asia/Taipei', 'MM/dd HH:mm') + '：' + t };
    }
  } catch(err) { return { ok: false, msg: '❌ 延後失敗：' + err.message }; }
}

function gcalDeleteEvent_(eventId) {
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID);
    var ev = cal.getEventById(eventId);
    if (!ev) return { ok: false, msg: '❌ 找不到行事曆事件' };
    var t = ev.getTitle();
    ev.deleteEvent();
    return { ok: true, msg: '🗑 已刪除：' + t };
  } catch(err) { return { ok: false, msg: '❌ 刪除失敗：' + err.message }; }
}

// ======================== 快速新增任務（Phase 3） ========================

function handleMessageEvent_(replyToken, text) {
  var trimmed = (text || '').trim();
  var isAdd = trimmed.indexOf('+') === 0 || trimmed.indexOf('新增 ') === 0 || trimmed.indexOf('新增') === 0;
  if (!isAdd) {
    sendLineReply_(replyToken, [{type:'text', text:'💡 輸入 +任務名稱 可快速新增待辦\n例如：+朱倖慧案做狀'}]);
    return;
  }
  var title = trimmed.replace(/^\+\s*/, '').replace(/^新增\s*/, '').trim();
  if (!title) { sendLineReply_(replyToken, [{type:'text', text:'❌ 請輸入任務名稱，例如：+朱倖慧案做狀'}]); return; }
  var result = notionAddQuickTask_(title);
  sendLineReply_(replyToken, [{type:'text', text: result.msg}]);
}

function notionAddQuickTask_(title) {
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      parent: { database_id: CONFIG.TODO_DB_ID },
      properties: {
        'Title': { title: [{ text: { content: title } }] },
        'Date': { date: { start: today } },
        'Checkbox': { checkbox: false }
      }
    }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() === 200) return { ok: true, msg: '✅ 已新增待辦：' + title };
  return { ok: false, msg: '❌ 新增失敗：' + resp.getContentText().substring(0, 100) };
}

// ======================== 測試與觸發器 ========================

function testBriefing(){sendMorningBriefing();}

function diagBriefing() {
  var steps = [];
  try {
    var today = new Date();
    steps.push('1.start');

    var lawyerAll = sortEvents(getLawyerDeadlineEvents(today));
    steps.push('2.lawyer:' + lawyerAll.length);

    var lawyerNonLeave = lawyerAll.filter(function(e){return !isLeaveEvent(e.title)&&!e.title.includes('陳律');});
    var lawyerAdmin = lawyerNonLeave.filter(function(e){return !e.title.startsWith('⏰');});
    steps.push('3.admin:' + lawyerAdmin.length);

    var notionTodos = getNotionTodoCandidates_(today);
    steps.push('4.notion:' + notionTodos.length);

    var taskItems = collectTaskItems_(notionTodos, lawyerAdmin);
    steps.push('5.tasks:' + taskItems.length);

    var carousel = buildTaskFlexCarousel_(taskItems);
    steps.push('6.carousel:' + (carousel ? 'ok' : 'null'));

    sendLinePush_([{type:'text', text:'🩺 診斷完成\n' + steps.join('\n')}]);
    steps.push('7.push:ok');
  } catch(err) {
    steps.push('ERR:' + err.message);
    try { sendLinePush_([{type:'text', text:'🩺 診斷錯誤\n' + steps.join('\n') + '\n錯誤：' + err.message}]); } catch(e2) {}
  }
  return steps.join(' | ');
}
function setupDailyTrigger(){ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()==='sendMorningBriefing')ScriptApp.deleteTrigger(t);});ScriptApp.newTrigger('sendMorningBriefing').timeBased().atHour(8).everyDays(1).inTimezone('Asia/Taipei').create();Logger.log('✅ 已設定每日 08:00 觸發器');}
function removeAllTriggers(){ScriptApp.getProjectTriggers().forEach(function(t){ScriptApp.deleteTrigger(t);});Logger.log('已移除所有觸發器');}
function testHealthStatus(){var r=getHealthStatus(new Date());Logger.log('display:\n'+r.display);Logger.log('prompt:\n'+r.prompt);}
function testFamilyEvents(){var t=new Date(),c=getCourtEvents(t,0),l=getLawyerDeadlineEvents(t),f=getFamilyEvents(t,c,l);Logger.log('家庭行程：');if(!f.length)Logger.log('無');else f.forEach(function(e){Logger.log('▸ '+e.time+' '+e.title);});}

function testHighlightCandidates() {
  var t=new Date(),court=sortEvents(getCourtEvents(t,0)),la=sortEvents(getLawyerDeadlineEvents(t));
  var nl=la.filter(function(e){return !isLeaveEvent(e.title)&&!e.title.includes('陳律');});
  var dl=nl.filter(function(e){return e.title.startsWith('⏰');}),ad=nl.filter(function(e){return !e.title.startsWith('⏰');});
  var co=sortEvents(getConsultationEvents(t)),na=getNotionAlerts(t),nt=getNotionTodoCandidates_(t);
  var cs=buildHighlightCandidates_(court,dl,co,ad,na.todos,nt);
  Logger.log('Highlight 候選（'+cs.length+' 項）：');
  cs.forEach(function(c,i){Logger.log((i+1)+'. ['+c.icon+' '+c.label+'] → '+c.data);});
}

function testNotionTodos() {
  var ts=getNotionTodoCandidates_(new Date());
  Logger.log('Notion 待辦候選（'+ts.length+' 項）：');
  ts.forEach(function(t,i){Logger.log((i+1)+'. '+t.icon+' '+t.title+t.suffix);});
}

function testGmailAlerts(){var r=getGmailAlerts(new Date());Logger.log(r||'（無命中信件）');}

// ─── 家庭儀式地雷掃描 ──────────────────────────────────────────────────────

var FAMILY_RITUALS = [
  { date: '04-09', name: '老婆生日',   leadDays: 30, checklist: '餐廳訂位（你出錢）+ 蛋糕 + 禮物 + 當天不排公務' },
  { date: '01-05', name: '荳荳生日',   leadDays: 14, checklist: '特別餐廳 + 蛋糕 + 禮物' },
  { date: '02-14', name: '情人節',     leadDays: 14, checklist: '餐廳或活動安排' },
  { date: '02-22', name: '王志文生日', leadDays: 7,  checklist: '老婆會安排，配合即可' },
  { date: '07-02', name: '潭子爸生日', leadDays: 14, checklist: '主動提出慶生安排' },
  { date: '11-08', name: '潭子媽生日', leadDays: 14, checklist: '主動提出慶生安排' },
  { date: '12-27', name: '台中爸生日', leadDays: 7,  checklist: '參與老婆安排 + 帶荳去看' },
  { date: '12-24', name: '聖誕節',     leadDays: 30, checklist: '配合荳荳禮物工程' },
];

/**
 * 掃描未來 leadDays 天內的家庭重要日期，回傳提醒文字。
 * 無命中時回傳空字串，由 sendMorningBriefing 決定是否插入段落。
 */
function getRitualReminders() {
  var tz = 'Asia/Taipei';
  var now = new Date();
  var todayStr = Utilities.formatDate(now, tz, 'MM-dd');
  var todayYear = parseInt(Utilities.formatDate(now, tz, 'yyyy'));

  var lines = [];

  FAMILY_RITUALS.forEach(function(r) {
    // 計算今年和明年的目標日期，取最近且 >= 今天的那個
    var parts = r.date.split('-');
    var mm = parseInt(parts[0]);
    var dd = parseInt(parts[1]);

    var thisYear = new Date(todayYear, mm - 1, dd);
    var nextYear = new Date(todayYear + 1, mm - 1, dd);

    // 今天 0:00（台北時區）
    var todayMidnight = new Date(
      parseInt(Utilities.formatDate(now, tz, 'yyyy')),
      parseInt(Utilities.formatDate(now, tz, 'MM')) - 1,
      parseInt(Utilities.formatDate(now, tz, 'dd'))
    );

    var target = (thisYear >= todayMidnight) ? thisYear : nextYear;
    var daysLeft = Math.round((target - todayMidnight) / (1000 * 60 * 60 * 24));

    if (daysLeft < 0 || daysLeft > r.leadDays) return;

    var icon;
    if (daysLeft === 0)      icon = '🔴';
    else if (daysLeft <= 7)  icon = '🟡';
    else                     icon = '⚪';

    var line;
    if (daysLeft === 0) {
      line = icon + ' 今天是' + r.name + '！' + r.checklist;
    } else {
      line = icon + ' ' + r.name + '倒數 ' + daysLeft + ' 天｜' + r.checklist;
    }
    lines.push(line);
  });

  if (lines.length === 0) return '';
  return '\n🎂 家庭儀式提醒\n' + lines.join('\n') + '\n';
}

// ======================== 法官傾向 API 共用模組 ========================
// 供 auto-court-prep.js 呼叫：LINE 通知摘要 + Claude prompt 注入
// 資料來源：aceofbase.ngrok.app（本機 MCP server REST endpoint）

var _JUDICIAL_API = 'https://aceofbase.ngrok.app/api/judge-stats';

/** API 呼叫 → 回傳原始 JSON（供 prompt 注入用），失敗回傳 null */
function _fetchJudgeStatsJson_(judge, court, caseType) {
  try {
    var url = _JUDICIAL_API
      + '?judge='     + encodeURIComponent(judge)
      + '&court='     + encodeURIComponent(court)
      + '&case_type=' + encodeURIComponent(caseType);
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'ngrok-skip-browser-warning': '1' } });
    if (r.getResponseCode() !== 200) return null;
    return JSON.parse(r.getContentText());
  } catch (e) { return null; }
}

/**
 * 法官傾向統計 JSON → Claude prompt 專用格式化區塊
 * @param {Object} d  - _fetchJudgeStatsJson_ 回傳值
 * @param {string} judge
 * @param {string} caseType - 'M'/'V'/'A'
 */
function _buildJudgeStatsBlock_(d, judge, caseType) {
  if (!d || d.error || !d.total_cases) {
    return '## 法官傾向（本地 DB）\n查無資料（新任法官或資料覆蓋不足）\n\n';
  }
  var n = d.total_cases, range = d.date_range || '', courtLabel = d.court || '';
  var block = '## 法官傾向（本地 DB 實際統計，請據此校準分析）\n';
  block += '承審法官：' + judge + '｜' + courtLabel + '\n';
  block += '統計範圍：近 ' + n + ' 件（' + range + ' 年）\n\n';

  if (caseType === 'M' && d.criminal_stats) {
    var cs = d.criminal_stats;
    var pct = Math.round(cs.probation_rate * 100);
    var avg = cs.avg_sentence_months;
    var sd  = cs.sentence_distribution || {};
    var lvl = pct < 15 ? '偏低' : pct < 30 ? '中等' : '偏高';
    block += '【刑事統計】\n';
    block += '- 緩刑率：' + pct + '%（' + lvl + '）\n';
    block += '- 平均刑期：' + avg + ' 個月\n';
    block += '- 刑度分布：6月以下 ' + (sd['6月以下']||0) + '件｜'
           + '6月-1年 '  + (sd['6月-1年'] ||0) + '件｜'
           + '1-2年 '    + (sd['1-2年']   ||0) + '件｜'
           + '2年以上 '  + (sd['2年以上'] ||0) + '件\n';
    block += '\n⚠️ 量刑策略提示（請在量刑分析模組中具體評估）：\n';
    if (pct < 15) {
      block += '緩刑比例偏低（' + pct + '%），以緩刑為目標的勝算不高。\n';
      block += '建議：策略重心移到「6 個月以下，得易科罰金」，聚焦刑度而非緩刑資格。\n';
      block += '請評估本案有利因子（初犯/和解/認罪/賠償）能否將刑度壓至 6 月以下（均刑基準：' + avg + ' 月）。\n';
    } else if (pct >= 30) {
      block += '緩刑比例偏高（' + pct + '%），值得積極爭取。\n';
      block += '建議：完整準備緩刑聲請，強調犯後態度、賠償和解、社會連結。\n';
    } else {
      block += '緩刑比例中等（' + pct + '%），視有利因子決定是否主打緩刑。\n';
    }
  } else if (caseType === 'V' && d.civil_stats) {
    var vs = d.civil_stats;
    var wr = Math.round(vs.plaintiff_win_rate * 100);
    var ar = vs.avg_award_rate ? Math.round(vs.avg_award_rate * 100) : null;
    block += '【民事統計】\n';
    block += '- 原告勝率：' + wr + '%\n';
    if (ar !== null) block += '- 平均判賠比例：' + ar + '%（判賠/請求）\n';
    block += '\n⚠️ 訴訟策略提示：\n';
    if (wr >= 55) block += '原告勝率偏高（' + wr + '%），訴訟積極進行對原告有利。\n';
    else if (wr <= 40) block += '原告勝率偏低（' + wr + '%），請確認訴訟標的與舉證是否充分。\n';
    if (ar !== null && ar < 60) block += '判賠比例偏低（' + ar + '%），聲請金額建議保留合理空間。\n';
  } else if (caseType === 'A' && d.admin_stats) {
    var as_ = d.admin_stats;
    var rr = Math.round(as_.revocation_rate * 100);
    block += '【行政統計】\n';
    block += '- 撤銷率：' + rr + '%\n';
    block += '\n⚠️ 訴訟策略提示：\n';
    if (rr >= 30) block += '撤銷率偏高（' + rr + '%），積極攻擊處分違法點有較大勝算。\n';
    else block += '撤銷率偏低（' + rr + '%），需更精準聚焦最強的違法論點。\n';
  }
  block += '\n';
  return block;
}

/** 從行事曆 description 抓法官名（格式：法官：XXX / 承辦：XXX） */
function _judgeFromDesc_(desc) {
  var m = desc.match(/(?:法官|承辦|檢察官)[：:：\s]+([^\s\n,，（(]{2,4})/);
  return m ? m[1].trim() : '';
}

/** 從事件標題萃取案件名稱（去掉開庭/案號/括號） */
function _caseNameFromTitle_(title) {
  var s = title.replace(/^(開庭|宣判|調解|律見)[：:：\s]?/, '').trim();
  s = s.replace(/[（(][^）)]*[）)]/g, '').trim();
  s = s.replace(/\d{2,3}\s*年?度?\s*[^\s\d]{1,4}字第?\d+[號号]?/g, '').trim();
  return s.length >= 2 ? s : '';
}

/** 從 Notion 案件追蹤 DB 查 ▸法官 欄位 */
function _judgeFromNotion_(caseName) {
  try {
    var r = UrlFetchApp.fetch(
      'https://api.notion.com/v1/databases/' + COURT_PREP_CASE_DB_ID + '/query',
      { method: 'post',
        headers: { 'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY,
                   'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        payload: JSON.stringify({ filter: { property: '案件名稱', title: { contains: caseName } }, page_size: 1 }),
        muteHttpExceptions: true });
    var d = JSON.parse(r.getContentText());
    if (!d.results || !d.results.length) return '';
    var jp = d.results[0].properties['▸法官'];
    if (!jp || !jp.rich_text) return '';
    return jp.rich_text.map(function(t) { return t.plain_text; }).join('').trim();
  } catch (e) { return ''; }
}

/** 地點字串 → 法院代碼（預設 TCD） */
function _courtCode_(text) {
  var map = [['臺中地','TCD'],['台中地','TCD'],['高院臺中','TCA'],['臺中高分','TCA'],
             ['高等行政','TCBA'],['臺北地','TPD'],['台北地','TPD'],['高院','TCA']];
  for (var i = 0; i < map.length; i++) {
    if (text.indexOf(map[i][0]) !== -1) return map[i][1];
  }
  return 'TCD';
}

/** 事件文字推斷案件類型（M/V/A） */
function _caseType_(text) {
  if (/民字|家字|簡民|消費/.test(text)) return 'V';
  if (/行政訴訟|行訴字|行政/.test(text)) return 'A';
  return 'M';
}

/** 呼叫 aceofbase REST API，回傳格式化字串 */
function _fetchInsightLine_(judge, court, caseType) {
  try {
    var url = _JUDICIAL_API
      + '?judge=' + encodeURIComponent(judge)
      + '&court=' + encodeURIComponent(court)
      + '&case_type=' + encodeURIComponent(caseType);
    var r = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { 'ngrok-skip-browser-warning': '1' }
    });
    if (r.getResponseCode() !== 200) return '';
    return _formatInsight_(JSON.parse(r.getContentText()), caseType);
  } catch (e) { return ''; }
}

/** JSON stats → 一行摘要文字 */
function _formatInsight_(d, caseType) {
  if (!d || d.error || !d.total_cases) return '';
  var n = d.total_cases, range = d.date_range || '';
  var parts = [];

  if (caseType === 'M' && d.criminal_stats) {
    var cs = d.criminal_stats;
    parts.push('刑事' + n + '件');
    if (range) parts.push(range + '年');
    parts.push('緩刑' + Math.round((cs.probation_rate || 0) * 100) + '%');
    if (cs.avg_sentence_months > 0) parts.push('均刑' + cs.avg_sentence_months + '月');
  } else if (caseType === 'V' && d.civil_stats) {
    var vs = d.civil_stats;
    parts.push('民事' + n + '件');
    if (range) parts.push(range + '年');
    parts.push('原告勝率' + Math.round((vs.plaintiff_win_rate || 0) * 100) + '%');
  } else if (caseType === 'A' && d.admin_stats) {
    var as_ = d.admin_stats;
    parts.push('行政' + n + '件');
    if (range) parts.push(range + '年');
    parts.push('撤銷率' + Math.round((as_.revocation_rate || 0) * 100) + '%');
  } else {
    parts.push(n + '件');
    if (range) parts.push(range + '年');
  }

  return parts.join('，');
}
