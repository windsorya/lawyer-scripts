/**
 * 每日陳律工作分配推播 v1.5
 * 每天上午 09:00 掃描今日工作事項，透過 LINE Bot 推播給王律師
 * 王律師長按複製，轉發給陳律師
 * 依賴主檔案的 CONFIG、getNextBusinessDay()、sendLineMessage()
 *
 * 資料來源：
 * - 專案管理行事曆：大任務（撰狀、草擬，1-2天）→【今日專案工作】
 * - 〈2〉律師行事曆（非⏰）：小任務（聯絡、確認，1小時內）→【今日行政待辦】
 * - 〈2〉律師行事曆（⏰開頭）：期限事件 →【近期期限提醒】
 * - 〈1〉開庭行事曆：庭期 →【庭期】
 *
 * v1.0 - 2026-03-13 初版
 * v1.1 - 2026-03-13 新增〈2〉律師行事曆小任務（非⏰事件）→【今日行政待辦】
 * v1.2 - 2026-03-13 區塊標題改為【今日專案工作】【今日行政待辦】；結尾加謝謝～
 * v1.3 - 2026-03-13 庭期改用正則白名單（開庭/宣判/調解/律見 + (X律)開頭）；
 *        移除【你今天有庭】區塊，陳律的庭全面排除不顯示
 * v1.4 - 2026-03-27 律師行事曆+專案管理行事曆排除「陳律」相關人事行程
 *        （如「陳律特休」「陳律請假」等），這些不是陳律師要「完成」的待辦
 * v1.5 - 2026-04-09 陳律特休攔截：偵測到陳律今日請假 → 跳過工作分配，改推友善提示
 * v1.6 - 2026-04-14 王律過濾：專案管理與律師行事曆排除標題含「王律」的行程（僅查標題，不查說明，避免誤殺）
 * v1.7 - 2026-04-14 新增【今日電話諮詢】區塊（呼叫主檔案 getConsultationEvents()）
 * v1.8 - 2026-04-14 新增【王律今日會議室】區塊（同行事曆，只取標題含王律的事件）
 * v1.9 - 2026-04-14 修正：isWangOnly_ 改回同時查標題+說明；移除未經請求的【今日電話諮詢】區塊
 */

// ======================== 主函數 ========================

function sendDailyTaskDispatch() {
  var today = new Date();
  var dayOfWeek = today.getDay(); // 0=日, 1=一, ..., 6=六

  // 週六日不推播
  if (dayOfWeek === 0 || dayOfWeek === 6) return;

  var weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  var month = today.getMonth() + 1;
  var date = today.getDate();
  var dayStr = weekDays[dayOfWeek];

  // 設定掃描範圍
  var todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  var todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
  var weekLater = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  // 逾期掃描：從 30 天前到昨天（不含今天，今天的算「今日」不算逾期）
  var thirtyDaysAgo = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);
  var yesterdayEnd = new Date(todayStart.getTime() - 1);

  // 下一個工作日（用主檔案的 getNextBusinessDay）
  var nextBizDay = getNextBusinessDay(today);
  var nextBizStart = new Date(nextBizDay.getFullYear(), nextBizDay.getMonth(), nextBizDay.getDate(), 0, 0, 0);
  var nextBizEnd = new Date(nextBizDay.getFullYear(), nextBizDay.getMonth(), nextBizDay.getDate(), 23, 59, 59);
  var nextBizLabel = (dayOfWeek === 5) ? '下週一' : '明天';
  var nextBizDateStr = (nextBizDay.getMonth() + 1) + '/' + nextBizDay.getDate();

  // 陳律特休偵測
  var chenOnLeave = false;
  try {
    var lawyerCal = CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID);
    if (lawyerCal) {
      chenOnLeave = lawyerCal.getEvents(todayStart, todayEnd).some(function(ev) {
        var t = ev.getTitle();
        return t.includes('陳律') && isLeaveEvent(t);
      });
    }
  } catch (leaveErr) {
    Logger.log('陳律特休偵測失敗（略過）：' + leaveErr.message);
  }

  // ===== 掃描三個主行事曆 + 會議室 =====
  var todayCourtEvents = getDispatchCourtEvents_(todayStart, todayEnd);
  var tomorrowCourtEvents = getDispatchCourtEvents_(nextBizStart, nextBizEnd);
  var todayProjectEvents = getDispatchProjectEvents_(todayStart, todayEnd);
  var lawyerEventsAll = getDispatchLawyerEvents_(todayStart, weekLater);
  var todayMeetingRoom = getDispatchMeetingRoomEvents_(todayStart, todayEnd); // ★ v1.8：會議室行事曆，只取標題含王律
  // 逾期掃描（過去 30 天到昨天，未完成的事項）
  var overdueProjectEvents = getDispatchProjectEvents_(thirtyDaysAgo, yesterdayEnd);
  var overdueLawyerEvents = getDispatchLawyerEvents_(thirtyDaysAgo, yesterdayEnd);

  // ===== 分類 =====
  var todayCourt = [];         // 今日庭期（已排除所有含X律的事件 + 非案件事件）
  var todayWork = [];          // 今日專案工作（專案管理大任務）
  var todayTodo = [];          // 今日行政待辦（律師行事曆小任務）
  var meetingItems = [];       // 王律今日會議室（會議室行事曆，標題含王律）
  var deadlines = [];          // 近期期限（⏰ 開頭，7天內）
  var tomorrowItems = [];      // 明日預告

  // 處理今日庭期（行事曆層已排除含X律的事件和非案件事件）
  todayCourtEvents.forEach(function(e) {
    todayCourt.push(e);
  });

  // 處理今日專案管理（大任務）
  todayProjectEvents.forEach(function(e) {
    todayWork.push(e.title);
  });

  // 逾期專案工作（過去未完成）→ 併入【今日專案工作】標注 [尚未完成]
  overdueProjectEvents.forEach(function(e) {
    todayWork.push(e.title + ' [尚未完成]');
  });

  // 處理〈2〉律師行事曆：分流 ⏰ 期限 vs 一般小任務
  lawyerEventsAll.forEach(function(e) {
    var isDeadline = e.title.match(/^⏰/);
    var diffDays = Math.ceil((e.startDate.getTime() - todayStart.getTime()) / (1000 * 60 * 60 * 24));

    if (isDeadline) {
      // ⏰ 期限事件
      if (diffDays === 0) {
        deadlines.push({ text: e.title + '（今天到期！）', sort: 0 });
      } else if (diffDays > 0 && diffDays <= 7) {
        var m = e.startDate.getMonth() + 1;
        var d = e.startDate.getDate();
        deadlines.push({
          text: e.title + '（' + m + '/' + d + ' 到期，剩 ' + diffDays + ' 天）',
          sort: diffDays
        });
      }
    } else {
      // 非 ⏰ → 小任務
      if (diffDays === 0) {
        todayTodo.push(e.title);
      }
    }
  });

  // 逾期行政待辦（過去未完成的非⏰小任務）→ 併入【今日行政待辦】標注 [尚未完成]
  overdueLawyerEvents.forEach(function(e) {
    if (e.title.match(/^⏰/)) return; // ⏰ 期限事件不算行政待辦
    todayTodo.push(e.title + ' [尚未完成]');
  });

  // 處理王律今日會議室（★ v1.8）
  todayMeetingRoom.forEach(function(e) {
    meetingItems.push((e.time ? e.time + ' ' : '全天 ') + e.title);
  });

  // 期限按天數排序
  deadlines.sort(function(a, b) { return a.sort - b.sort; });

  // 處理明日預告（只包含開庭行事曆）
  tomorrowCourtEvents.forEach(function(e) {
    tomorrowItems.push(e.timeStr + ' ' + e.title);
  });

  // ===== 組合訊息 =====
  var msg = chenOnLeave
    ? '⚠️ 俊銘今日特休，以下事項由您接手處理：\n\n今天（' + month + '/' + date + ' 週' + dayStr + '）：'
    : '俊銘早，\n今天（' + month + '/' + date + ' 週' + dayStr + '）工作事項：';
  var hasContent = false;

  // 庭期
  if (todayCourt.length > 0) {
    hasContent = true;
    msg += '\n\n【庭期】';
    todayCourt.forEach(function(e) {
      var line = '\n• ' + e.timeStr + ' ' + e.title;
      if (e.location) line += '\n  📍 ' + shortenDispatchLocation_(e.location);
      msg += line;
    });
  }

  // 王律今日會議室（★ v1.8）
  if (meetingItems.length > 0) {
    hasContent = true;
    msg += '\n\n【王律今日會議室】';
    meetingItems.forEach(function(m) {
      msg += '\n• ' + m;
    });
  }

  // 今日專案工作（專案管理大任務）
  if (todayWork.length > 0) {
    hasContent = true;
    msg += '\n\n【今日專案工作】';
    todayWork.forEach(function(w) {
      msg += '\n• ' + w;
    });
  }

  // 今日行政待辦（律師行事曆小任務）
  if (todayTodo.length > 0) {
    hasContent = true;
    msg += '\n\n【今日行政待辦】';
    todayTodo.forEach(function(t) {
      msg += '\n• ' + t;
    });
  }

  // 近期期限
  if (deadlines.length > 0) {
    hasContent = true;
    msg += '\n\n【近期期限提醒】';
    deadlines.forEach(function(d) {
      msg += '\n• ' + d.text;
    });
  }

  // 明日預告
  if (tomorrowItems.length > 0) {
    hasContent = true;
    msg += '\n\n【' + nextBizLabel + '預告・' + nextBizDateStr + '】';
    tomorrowItems.forEach(function(item) {
      msg += '\n• ' + item;
    });
  }

  // 結尾
  if (!hasContent) {
    msg = '俊銘早，\n今天（' + month + '/' + date + ' 週' + dayStr + '）行事曆上沒有排定的事項。如果有臨時交辦的再跟你說，謝謝～';
  } else {
    msg += '\n\n有任何問題再請跟我說，謝謝～\n\nP.S 完成的事項請記得把行程改綠色或加 ✅，我比較好追蹤進度';
  }

  // 推播
  sendLineMessage(msg);
  Logger.log('陳律工作分配推播完成');
}

// ======================== 行事曆讀取 ========================

/**
 * 讀取庭期行事曆事件
 * 用正則白名單過濾：只保留案件相關事件
 */
function getDispatchCourtEvents_(start, end) {
  try {
    var calendar = CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID);
    if (!calendar) return [];
    var events = calendar.getEvents(start, end);
    var results = [];

    events.forEach(function(event) {
      var title = event.getTitle();

      // 排除已完成（✅）
      if (CONFIG.DONE_PATTERNS.some(function(p) { return title.indexOf(p) !== -1; })) return;
      // 排除綠色
      var color = event.getColor();
      if (color && CONFIG.DONE_COLORS.indexOf(color) !== -1) return;
      // 正則白名單：只保留需要交辦陳律的案件庭期
      if (!title.match(/^(開庭|宣判|調解|律見)/)) return;
      if (title.match(/.律/)) return;
      // 排除已取消的庭期（標題含「取消」）
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

/**
 * 讀取專案管理行事曆事件（大任務）
 * v1.4：排除含「陳律」的人事行程
 */
function getDispatchProjectEvents_(start, end) {
  try {
    var calendar = CalendarApp.getCalendarById(CONFIG.PROJECT_MGMT_CALENDAR_ID);
    if (!calendar) {
      Logger.log('找不到專案管理行事曆，請確認 CONFIG.PROJECT_MGMT_CALENDAR_ID');
      return [];
    }
    var events = calendar.getEvents(start, end);
    var results = [];
    events.forEach(function(event) {
      var title = event.getTitle();
      if (title.indexOf('✅') !== -1) return;
      var color = event.getColor();
      if (color && CONFIG.DONE_COLORS.indexOf(color) !== -1) return;
      // ★ v1.4：排除陳律人事行程
      if (title.indexOf('陳律') !== -1) return;
      // ★ v1.6：排除王律相關行程
      if (isWangOnly_(event)) return;

      results.push({
        title: title,
        startDate: event.isAllDayEvent() ? event.getAllDayStartDate() : event.getStartTime()
      });
    });
    return results;
  } catch (err) {
    Logger.log('專案管理行事曆讀取失敗：' + err.message);
    return [];
  }
}

/**
 * 讀取〈2〉律師行事曆事件（期限 + 小任務，統一掃描後在主函數分流）
 * v1.4：排除含「陳律」的人事行程
 */
function getDispatchLawyerEvents_(start, end) {
  try {
    var calendar = CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID);
    if (!calendar) return [];
    var events = calendar.getEvents(start, end);
    var results = [];
    events.forEach(function(event) {
      var title = event.getTitle();
      // 排除已完成
      if (title.indexOf('✅') !== -1) return;
      var color = event.getColor();
      if (color && CONFIG.DONE_COLORS.indexOf(color) !== -1) return;
      // ★ v1.4：排除陳律人事行程（特休、請假等）
      if (title.indexOf('陳律') !== -1) return;
      // ★ v1.6：排除王律相關行程
      if (isWangOnly_(event)) return;

      results.push({
        title: title,
        startDate: event.isAllDayEvent() ? event.getAllDayStartDate() : event.getStartTime()
      });
    });
    return results;
  } catch (err) {
    Logger.log('律師行事曆讀取失敗：' + err.message);
    return [];
  }
}

// ======================== 工具函數 ========================

function formatDispatchTime_(event) {
  if (event.isAllDayEvent()) return '全天';
  var start = event.getStartTime();
  var h = start.getHours();
  var m = start.getMinutes();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function isWangOnly_(event) {
  // 三個主要行事曆（開庭、律師、專案管理）專用：標題或說明含「王律」即排除
  var title = (typeof event.getTitle === 'function') ? event.getTitle() : (event.title || event.summary || '');
  var desc  = (typeof event.getDescription === 'function') ? event.getDescription() : (event.description || '');
  return title.indexOf('王律') !== -1 || desc.indexOf('王律') !== -1;
}

function shortenDispatchLocation_(location) {
  return location
    .replace(/,?\s*\d{3}台灣.*$/g, '')
    .replace(/,?\s*\d{3}Taiwan.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ======================== 觸發器設定 ========================

function setupDispatchTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'sendDailyTaskDispatch') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('sendDailyTaskDispatch')
    .timeBased()
    .atHour(9)
    .everyDays(1)
    .inTimezone('Asia/Taipei')
    .create();

  Logger.log('✅ 已設定每日 09:00 陳律工作分配觸發器');
}

// ======================== 測試 ========================

function testDailyTaskDispatch() {
  sendDailyTaskDispatch();
}

/**
 * 讀取會議室行事曆—只取標題含「王律」的事件（★ v1.8）
 */
function getDispatchMeetingRoomEvents_(start, end) {
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.CONSULTATION_CALENDAR_ID);
    if (!cal) return [];
    return cal.getEvents(start, end)
      .filter(function(ev) {
        return (ev.getTitle() || '').indexOf('王律') !== -1;
      })
      .map(function(ev) {
        var ad = ev.isAllDayEvent();
        return {
          time: ad ? '' : Utilities.formatDate(ev.getStartTime(), 'Asia/Taipei', 'HH:mm'),
          title: ev.getTitle()
        };
      })
      .sort(function(a, b) { return a.time.localeCompare(b.time); });
  } catch (err) {
    Logger.log('會議室行事曆讀取失敗：' + err.message);
    return [];
  }
}

// ======================== 診斷函式（查完刪除）========================

function debugDispatchCalendars() {
  var today = new Date();
  var todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
  var todayEnd   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
  var lines = [];
  lines.push('today=' + Utilities.formatDate(today, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'));
  lines.push('range=' + Utilities.formatDate(todayStart,'Asia/Taipei','MM-dd HH:mm') + ' ~ ' + Utilities.formatDate(todayEnd,'Asia/Taipei','MM-dd HH:mm'));

  var calDefs = [
    { key: 'PROJECT',      id: CONFIG.PROJECT_MGMT_CALENDAR_ID },
    { key: 'LAWYER',       id: CONFIG.LAWYER_CALENDAR_ID },
    { key: 'COURT',        id: CONFIG.COURT_CALENDAR_ID },
    { key: 'CONSULTATION', id: CONFIG.CONSULTATION_CALENDAR_ID }
  ];

  calDefs.forEach(function(def) {
    try {
      var cal = CalendarApp.getCalendarById(def.id);
      if (!cal) { lines.push('[' + def.key + '] NOT FOUND'); return; }
      lines.push('[' + def.key + '] ' + cal.getName());
      var evts = cal.getEvents(todayStart, todayEnd);
      lines.push('  raw=' + evts.length);
      evts.forEach(function(e) {
        var t = e.getTitle();
        var d = (e.getDescription() || '').substring(0, 40);
        var wang = isWangOnly_(e);
        lines.push('  • [' + (wang?'SKIP':'OK') + '] ' + t + (d?' |desc:'+d:''));
      });
    } catch(err) {
      lines.push('[' + def.key + '] ERR: ' + err.message);
    }
  });

  var result = lines.join('\n');
  Logger.log(result);
  return result;
}