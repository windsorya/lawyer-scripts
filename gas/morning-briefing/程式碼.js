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
  LEAVE_KEYWORDS: ['特休', '休假', '請假', '年假', '補休', '病假', '喪假', '婚假', '產假', '公假'],
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
  message += '\n🧘 【身心狀態】\n' + healthResult.display;
  if (healthResult.isFallback) message += '（注：以上為昨日數據，今日數據同步後將補發）\n';
  message += '\n━━━━━━━━━━━━━━\n';
  message += '💡 今日開庭準備 → https://claude.ai/new?q=今日開庭準備\n';
  message += '💡 領今日身心處方 → https://claude.ai/new?q=' + healthResult.prompt;

  // 若拿到的是昨天的數據，建立 09:00 一次性 trigger 補發今日健康段落
  if (healthResult.isFallback) {
    try {
      var nine = new Date(today);
      nine.setHours(9, 0, 0, 0);
      // 若已過 09:00，不建立（避免 trigger 立刻觸發造成混亂）
      if (nine.getTime() > new Date().getTime()) {
        ScriptApp.newTrigger('sendHealthSupplement')
          .timeBased()
          .at(nine)
          .create();
        Logger.log('已建立 09:00 健康數據補發 trigger');
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
  consultations.forEach(function(e) { add('💬', e.time ? e.time + ' ' + e.title : e.title, e.title); });
  adminEvents.forEach(function(e) { add('📌', e.title, e.title); });
  caseAlertTodos.forEach(function(t) { add('📋', t.caseName + '：' + t.todo, t.caseName + '：' + t.todo); });
  notionTodos.forEach(function(t) { add(t.icon, t.title + t.suffix, t.title); });

  return candidates.slice(0, 10);
}

// ======================== 假日 Highlight 候選產生（v2.31） ========================

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

  // 2. 生活類固定選項（輪替顯示，用 dayOfYear 做 offset）
  var allLifeOptions = [
    { icon: '🥾', label: '大坑步道走走', title: '大坑步道走走' },
    { icon: '📚', label: '閱讀時間', title: '閱讀時間' },
    { icon: '🎬', label: '看劇/電影', title: '看劇或電影' },
    { icon: '🧹', label: '整理家務', title: '整理家務' },
    { icon: '👨‍👩‍👧', label: '陪荳荳活動', title: '陪荳荳活動' },
    { icon: '🍳', label: '研究美食/下廚', title: '研究美食或下廚' },
    { icon: '📦', label: '清空收集箱', title: '清空 TickTick 收集箱' },
    { icon: '😎', label: '翻 Someday 清單', title: '翻 Someday 清單挑一件推進' },
    { icon: '💆', label: '純粹放空充電', title: '純粹放空充電' },
    { icon: '📋', label: '下週預覽', title: '預覽下週行程與重要事項' },
  ];

  var now = new Date();
  var start = new Date(now.getFullYear(), 0, 0);
  var dayOfYear = Math.floor((now - start) / 86400000);
  var offset = dayOfYear % allLifeOptions.length;

  var slots = Math.max(1, 5 - candidates.length);
  for (var i = 0; i < slots && i < allLifeOptions.length; i++) {
    var opt = allLifeOptions[(offset + i) % allLifeOptions.length];
    add(opt.icon, opt.label, opt.title);
  }

  // 週日固定加入下週預覽
  if (now.getDay() === 0) {
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

// 補發今日健康數據（由 sendMorningBriefing 在 fallback 時建立的 09:00 一次性 trigger 呼叫）
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
      Logger.log('sendHealthSupplement：09:00 仍無今日數據，略過補發');
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

function getHealthStatus(today) {
  var fallback = { display: '尚無健康數據（Health Auto Export 尚未同步）\n', prompt: '充電', isFallback: false };
  try {
    var ts = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy-MM-dd');
    var td = readHealthSheet_(ts);
    if (!td) {
      // Fallback: try yesterday
      var y = new Date(today); y.setDate(y.getDate()-1);
      var ys = Utilities.formatDate(y, 'Asia/Taipei', 'yyyy-MM-dd');
      td = readHealthSheet_(ys);
      if (!td) return fallback;
      var result = buildHealthDisplay_(td, {});
      result.isFallback = true;  // 昨天的數據
      return result;
    }
    var result = buildHealthDisplay_(td, {});
    result.isFallback = false;  // 今天的數據
    return result;
  } catch (err) { Logger.log('讀取健康數據錯誤：' + err.message); return { display: '健康數據讀取失敗\n', prompt: '充電', isFallback: false }; }
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

  // 完成任務後，附上更新後的 Highlight 選單（已完成的任務自動排除）
  var msgs = [{type:'text', text: result.msg}];
  if (action === 'done' && result.ok) {
    try {
      var hlFlex = buildRefreshedHighlightFlex_();
      msgs.push(hlFlex);
    } catch(hlErr) { Logger.log('buildRefreshedHighlightFlex_ 失敗：' + hlErr.message); }
  }
  sendLineReply_(replyToken, msgs);
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
