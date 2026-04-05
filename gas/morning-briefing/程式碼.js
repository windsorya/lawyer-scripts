// ============================================================
// 📋 律師晨報推播系統 v2.30
// 功能：每日 08:00 自動推播今日/明日庭期、辦案期限、諮詢預約、
//       案件待辦到期、時效預警、家庭行程、身心狀態至 LINE（透過 Messaging API）
// 作者：Claude for William
// 日期：2026-04-04
// 變更：v2.30 - readHealthSheet_ 改為用 folder ID 精準定位 wjv Drive 的
//               daily-vitals 資料夾，不再用 DriveApp.searchFiles 全域搜尋。
//               CONFIG 新增 HEALTH_DRIVE_FOLDER_ID，移除 HEALTH_DRIVE_FOLDER_NAME。
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

function sendMorningBriefing() {
  try { ensureConsultationFollowupTrigger_(); } catch(e) { Logger.log('Trigger check failed: ' + e); }
  var today = new Date();
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
  message += '\n⭐️【Highlight任務】\n';
  if (highlightEmpty) { message += '⚠️ 今日尚未設定 Highlight，建議現在設定一個最重要的任務。\n'; }
  else { highlightEvents.forEach(function(e) { message += formatEvent(e); }); }

  if (lawyerAdmin.length > 0) {
    message += hasLeave ? '\n📌 【今日行政待辦】⚠️ ' + leaveNames + '\n' : '\n📌 【今日行政待辦】\n';
    lawyerAdmin.forEach(function(e) { message += formatEvent(e); });
  }

  message += '\n🚨 【時效預警】\n';
  if (notionAlerts.deadlines.length === 0) { message += '目前無時效警示\n'; }
  else { notionAlerts.deadlines.forEach(function(d) { message += '▸ ' + d.emoji + ' ' + d.caseName + '｜剩 ' + d.daysLeft + ' 天（' + d.deadline + '）\n'; }); }

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
  message += '\n━━━━━━━━━━━━━━\n';
  message += '💡 今日開庭準備 → https://claude.ai/new?q=今日開庭準備\n';
  message += '💡 領今日身心處方 → https://claude.ai/new?q=' + healthResult.prompt;

  var lineMessages = buildTextMessages_(message);

  var notionTodos = getNotionTodoCandidates_(today);
  var hlCandidates = buildHighlightCandidates_(todayCourt, lawyerDeadlines, consultations, lawyerAdmin, notionAlerts.todos, notionTodos);
  var flexMsg = buildHighlightFlexMessage_(highlightEmpty, hlCandidates);
  if (lineMessages.length < 5) lineMessages.push(flexMsg);

  sendLinePush_(lineMessages);
  Logger.log('晨報推播完成：' + todayStr);
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
    if (data.status && data.status !== 200) { Logger.log('Notion 待辦 API 錯誤：' + response.getContentText()); return results; }

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
        results.push({ icon: icon, title: title, suffix: suffix, sortOrder: sortOrder, daysUntilDue: daysUntilDue !== null ? daysUntilDue : 999 });
      }
    });
    results.sort(function(a, b) { return a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.daysUntilDue - b.daysUntilDue; });
  } catch (error) { Logger.log('Notion 待辦查詢錯誤：' + error.message); }
  return results.slice(0, 6);
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

function getHealthStatus(today) {
  var fallback = { display: '尚無健康數據（Health Auto Export 尚未同步）\n', prompt: '充電' };
  try {
    var ts = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy-MM-dd');
    var y = new Date(today); y.setDate(y.getDate()-1);
    var ys = Utilities.formatDate(y, 'Asia/Taipei', 'yyyy-MM-dd');
    var td = readHealthSheet_(ts), yd = readHealthSheet_(ys);
    if (!td) { var db = new Date(today); db.setDate(db.getDate()-2); var dbs = Utilities.formatDate(db,'Asia/Taipei','yyyy-MM-dd'); var dbd = readHealthSheet_(dbs); if(!dbd) return fallback; return buildHealthDisplay_(dbd, yd||{}); }
    return buildHealthDisplay_(td, yd||{});
  } catch (err) { Logger.log('讀取健康數據錯誤：' + err.message); return { display: '健康數據讀取失敗\n', prompt: '充電' }; }
}

function readHealthSheet_(dateStr) {
  var fn = 'HealthMetrics-' + dateStr;
  var folder;
  try {
    folder = DriveApp.getFolderById(CONFIG.HEALTH_DRIVE_FOLDER_ID);
  } catch (e) {
    Logger.log('無法存取 daily-vitals 資料夾：' + e.message);
    return null;
  }
  var files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  var latest = null, latestTime = 0;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName().indexOf(fn) === -1) continue;
    var t = f.getLastUpdated().getTime();
    if (t > latestTime) { latest = f; latestTime = t; }
  }
  if (!latest) return null;
  var sh = SpreadsheetApp.open(latest).getActiveSheet();
  var h = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  var d = sh.getRange(2,1,1,sh.getLastColumn()).getValues()[0];
  var r = {}; h.forEach(function(x,i){ r[x.toString().trim()] = d[i]; }); return r;
}

function buildHealthDisplay_(td, yd) {
  var pf = function(k,s){ var v=parseFloat(s[k]); return isNaN(v)?null:v; };
  var st=pf('睡眠分析 [睡眠時間] (hr)',td)||pf('睡眠分析 [Total] (hr)',td), sr=pf('睡眠分析 [REM] (hr)',td), hv=pf('心率變異性 (毫秒)',td);
  var rh=pf('靜止心率 (bpm)',td), bo=pf('血氧飽和度 (%)',td), br=pf('呼吸速率 (次/分)',td), sd=pf('睡眠分析 [深層] (hr)',td);
  var steps=pf('步數 (步)',yd), exMin=pf('Apple 運動時間 (分鐘)',yd);
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
      r.push({allDay:ad,time:ad?'':Utilities.formatDate(ev.getStartTime(),'Asia/Taipei','HH:mm'),title:ev.getTitle()});}); return r;
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

function sendLineReply_(rt,mo) {
  try{UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply',{method:'post',headers:{'Content-Type':'application/json','Authorization':'Bearer '+CONFIG.LINE_CHANNEL_ACCESS_TOKEN},
    payload:JSON.stringify({replyToken:rt,messages:mo.slice(0,5)}),muteHttpExceptions:true});
  }catch(err){Logger.log('LINE Reply 錯誤：'+err.message);}
}

// ======================== Webhook doPost ========================

function doPost(e) {
  try{if(!e||!e.postData||!e.postData.contents)return ContentService.createTextOutput('OK');
    var body=JSON.parse(e.postData.contents);(body.events||[]).forEach(function(ev){
      if(ev.type==='postback'&&ev.postback&&ev.postback.data){var d=ev.postback.data;if(d.indexOf('hl:')===0)handleHighlightSelection_(ev.replyToken,d.substring(3));}
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

// ======================== 測試與觸發器 ========================

function testBriefing(){sendMorningBriefing();}
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