// 每日陳律工作分配推播 v1.3
// 依賴主檔案的 CONFIG、getNextBusinessDay()、sendLineMessage()
// 敏感資訊已替換為佔位符

function sendDailyTaskDispatch() {
  var today = new Date();
  var dayOfWeek = today.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) return;
  var weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  var month = today.getMonth() + 1;
  var date = today.getDate();
  var dayStr = weekDays[dayOfWeek];
  var todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  var todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
  var weekLater = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  var thirtyDaysAgo = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);
  var yesterdayEnd = new Date(todayStart.getTime() - 1);
  var nextBizDay = getNextBusinessDay(today);
  var nextBizStart = new Date(nextBizDay.getFullYear(), nextBizDay.getMonth(), nextBizDay.getDate(), 0, 0, 0);
  var nextBizEnd = new Date(nextBizDay.getFullYear(), nextBizDay.getMonth(), nextBizDay.getDate(), 23, 59, 59);
  var nextBizLabel = (dayOfWeek === 5) ? '下週一' : '明天';
  var nextBizDateStr = (nextBizDay.getMonth() + 1) + '/' + nextBizDay.getDate();
  var todayCourtEvents = getDispatchCourtEvents_(todayStart, todayEnd);
  var tomorrowCourtEvents = getDispatchCourtEvents_(nextBizStart, nextBizEnd);
  var todayProjectEvents = getDispatchProjectEvents_(todayStart, todayEnd);
  var lawyerEventsAll = getDispatchLawyerEvents_(todayStart, weekLater);
  var overdueProjectEvents = getDispatchProjectEvents_(thirtyDaysAgo, yesterdayEnd);
  var overdueLawyerEvents = getDispatchLawyerEvents_(thirtyDaysAgo, yesterdayEnd);
  var todayCourt = [];
  var todayWork = [];
  var todayTodo = [];
  var deadlines = [];
  var tomorrowItems = [];
  todayCourtEvents.forEach(function(e) { todayCourt.push(e); });
  todayProjectEvents.forEach(function(e) { todayWork.push(e.title); });
  overdueProjectEvents.forEach(function(e) { todayWork.push(e.title + ' [尚未完成]'); });
  lawyerEventsAll.forEach(function(e) {
    var isDeadline = e.title.match(/^⏰/);
    var diffDays = Math.ceil((e.startDate.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));
    if (isDeadline) {
      if (diffDays === 0) {
        deadlines.push({ text: e.title + '（今天到期！）', sort: 0 });
      } else if (diffDays > 0 && diffDays <= 7) {
        var m = e.startDate.getMonth() + 1;
        var d = e.startDate.getDate();
        deadlines.push({ text: e.title + '（' + m + '/' + d + ' 到期，剩 ' + diffDays + ' 天）', sort: diffDays });
      }
    } else {
      if (diffDays === 0) { todayTodo.push(e.title); }
    }
  });
  overdueLawyerEvents.forEach(function(e) {
    if (e.title.match(/^⏰/)) return;
    todayTodo.push(e.title + ' [尚未完成]');
  });
  deadlines.sort(function(a, b) { return a.sort - b.sort; });
  tomorrowCourtEvents.forEach(function(e) { tomorrowItems.push(e.timeStr + ' ' + e.title); });
  var msg = '俊銘早，\n今天（' + month + '/' + date + ' 週' + dayStr + '）工作事項：';
  var hasContent = false;
  if (todayCourt.length > 0) {
    hasContent = true;
    msg += '\n\n【庭期】';
    todayCourt.forEach(function(e) {
      var line = '\n• ' + e.timeStr + ' ' + e.title;
      if (e.location) line += '\n  📍 ' + shortenDispatchLocation_(e.location);
      msg += line;
    });
  }
  if (todayWork.length > 0) {
    hasContent = true;
    msg += '\n\n【今日專案工作】';
    todayWork.forEach(function(w) { msg += '\n• ' + w; });
  }
  if (todayTodo.length > 0) {
    hasContent = true;
    msg += '\n\n【今日行政待辦】';
    todayTodo.forEach(function(t) { msg += '\n• ' + t; });
  }
  if (deadlines.length > 0) {
    hasContent = true;
    msg += '\n\n【近期期限提醒】';
    deadlines.forEach(function(d) { msg += '\n• ' + d.text; });
  }
  if (tomorrowItems.length > 0) {
    hasContent = true;
    msg += '\n\n【' + nextBizLabel + '預告・' + nextBizDateStr + '】';
    tomorrowItems.forEach(function(item) { msg += '\n• ' + item; });
  }
  if (!hasContent) {
    msg = '俊銘早，\n今天（' + month + '/' + date + ' 週' + dayStr + '）行事曆上沒有排定的事項。如果有臨時交辦的再跟你說，謝謝～';
  } else {
    msg += '\n\n有任何問題再請跟我說，謝謝～\n\nP.S 完成的事項請記得把行程改綠色或加 ✅，我比較好追蹤進度';
  }
  sendLineMessage(msg);
  Logger.log('陳律工作分配推播完成');
}

function getDispatchCourtEvents_(start, end) {
  try {
    var calendar = CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID);
    if (!calendar) return [];
    var events = calendar.getEvents(start, end);
    var results = [];
    events.forEach(function(event) {
      var title = event.getTitle();
      if (CONFIG.DONE_PATTERNS.some(function(p) { return title.indexOf(p) !== -1; })) return;
      var color = event.getColor();
      if (color && CONFIG.DONE_COLORS.indexOf(color) !== -1) return;
      if (!title.match(/^(開庭|宣判|調解|律見)/)) return;
      if (title.match(/.律/)) return;
      if (title.indexOf('取消') !== -1) return;
      results.push({
        title: title,
        timeStr: formatDispatchTime_(event),
        location: event.getLocation() || '',
        startTime: event.getStartTime()
      });
    });
    results.sort(function(a, b) { return a.startTime - b.startTime; });
    return results;
  } catch (err) {
    Logger.log('庭期行事曆讀取失敗：' + err.message);
    return [];
  }
}

function getDispatchProjectEvents_(start, end) {
  try {
    var calendar = CalendarApp.getCalendarById(CONFIG.PROJECT_MGMT_CALENDAR_ID);
    if (!calendar) { Logger.log('找不到專案管理行事曆'); return []; }
    var events = calendar.getEvents(start, end);
    var results = [];
    events.forEach(function(event) {
      var title = event.getTitle();
      if (title.indexOf('✅') !== -1) return;
      var color = event.getColor();
      if (color && CONFIG.DONE_COLORS.indexOf(color) !== -1) return;
      results.push({ title: title, startDate: event.isAllDayEvent() ? event.getAllDayStartDate() : event.getStartTime() });
    });
    return results;
  } catch (err) {
    Logger.log('專案管理行事曆讀取失敗：' + err.message);
    return [];
  }
}

function getDispatchLawyerEvents_(start, end) {
  try {
    var calendar = CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID);
    if (!calendar) return [];
    var events = calendar.getEvents(start, end);
    var results = [];
    events.forEach(function(event) {
      var title = event.getTitle();
      if (title.indexOf('✅') !== -1) return;
      var color = event.getColor();
      if (color && CONFIG.DONE_COLORS.indexOf(color) !== -1) return;
      results.push({ title: title, startDate: event.isAllDayEvent() ? event.getAllDayStartDate() : event.getStartTime() });
    });
    return results;
  } catch (err) {
    Logger.log('律師行事曆讀取失敗：' + err.message);
    return [];
  }
}

function formatDispatchTime_(event) {
  if (event.isAllDayEvent()) return '全天';
  var start = event.getStartTime();
  var h = start.getHours();
  var m = start.getMinutes();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function shortenDispatchLocation_(location) {
  return location.replace(/,?\s*\d{3}台灣.*$/g, '').replace(/,?\s*\d{3}Taiwan.*$/gi, '').replace(/\s+/g, ' ').trim();
}

function setupDispatchTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'sendDailyTaskDispatch') { ScriptApp.deleteTrigger(trigger); }
  });
  ScriptApp.newTrigger('sendDailyTaskDispatch').timeBased().atHour(9).everyDays(1).inTimezone('Asia/Taipei').create();
  Logger.log('✅ 已設定每日 09:00 陳律工作分配觸發器');
}

function testDailyTaskDispatch() { sendDailyTaskDispatch(); }
