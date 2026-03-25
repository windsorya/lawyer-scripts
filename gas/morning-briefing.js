// ============================================================
// 📋 律師晨報推播系統 v2.25
// 功能：每日 08:00 自動推播今日/明日庭期、辦案期限、諮詢預約、
//       案件待辦到期、時效預警、家庭行程、身心狀態至 LINE（透過 Messaging API）
// 作者：Claude for William
// 日期：2026-03-25
// 變更：v2.25 - 修正全日事件 exclusive end date 判斷（Google Calendar
//               全日事件 endDate 為 exclusive，如 3/23-24 的 end = 3/25，
//               導致 3/25 仍抓到該事件）。新增特休/休假偵測邏輯：
//               偵測到律師行事曆含「特休」「休假」「請假」的全日事件時，
//               (1) 該事件不列入行政待辦 (2) 晨報頂部加警示提示
//               (3) 行政待辦區段加註需律師自行處理。
// ============================================================

// ======================== 設定區 ========================

const CONFIG = {
  LINE_CHANNEL_ACCESS_TOKEN: 'YOUR_LINE_CHANNEL_ACCESS_TOKEN',
  LINE_USER_ID: 'YOUR_LINE_USER_ID',
  COURT_CALENDAR_ID: '9d8oj0jqrd1lf60908ol444m68@group.calendar.google.com',
  LAWYER_CALENDAR_ID: 'nlkp6pcrl9cs2ret7ssoe9kre0@group.calendar.google.com',
  CONSULTATION_CALENDAR_ID: '5e90kb0v0g9ltcrmatmbkat5t4@group.calendar.google.com',
  FAMILY_CALENDAR_ID: 'kej9tlp9q9qjc95ap5ja610q2k@group.calendar.google.com',
  HIGHLIGHT_CALENDAR_ID: 'a61f3iiaiejbd7t5tcqvpsab2k@group.calendar.google.com',
  PROJECT_MGMT_CALENDAR_ID: '489cda49eb84e47b69f8442a833b3999c009def022ebb81e97ae6bb4244d2d46@group.calendar.google.com',
  NOTION_API_KEY: 'YOUR_NOTION_API_KEY',
  CASE_DB_ID: '00dd6a5982664289b639749be8ef25c7',
  HEALTH_DRIVE_FOLDER_NAME: 'daily-vitals',
  SKIP_PATTERNS: ['(陳律)', '（陳律）'],
  DONE_PATTERNS: ['✅'],
  DONE_COLORS: ['2', '10', '11'],
  DEADLINE_WARN_DAYS: [30, 7, 3, 1],
  // ★ v2.25：特休/休假關鍵字
  LEAVE_KEYWORDS: ['特休', '休假', '請假', '年假', '補休'],
};

// ======================== 共用工具 ========================

function shouldSkipCalendarEvent(event) {
  const title = event.getTitle();
  if (CONFIG.SKIP_PATTERNS.some(p => title.includes(p))) return true;
  if (CONFIG.DONE_PATTERNS.some(p => title.includes(p))) return true;
  const color = event.getColor();
  if (color && CONFIG.DONE_COLORS.includes(color)) return true;
  return false;
}

// ★ v2.25：判斷全日事件是否「真正涵蓋」目標日期
// Google Calendar 全日事件 endDate 為 exclusive：
//   「3/23-24」→ start=3/23, end=3/25
//   在 3/25 查詢時 getEvents() 仍會返回此事件，但實際上已結束
// 修正：全日事件的 end date 若 <= targetDate 的 00:00:00，視為已過期
function isAllDayEventActiveOnDate(event, targetDate) {
  if (!event.isAllDayEvent()) return true; // 非全日事件不受此規則影響
  const eventEnd = event.getEndTime(); // exclusive end date
  const startOfTarget = new Date(targetDate);
  startOfTarget.setHours(0, 0, 0, 0);
  // 全日事件的 endDate 是 exclusive，所以 end <= startOfTarget 表示已結束
  return eventEnd.getTime() > startOfTarget.getTime();
}

function getNextBusinessDay(baseDate) {
  const next = new Date(baseDate);
  next.setDate(next.getDate() + 1);
  const day = next.getDay();
  if (day === 6) next.setDate(next.getDate() + 2);
  if (day === 0) next.setDate(next.getDate() + 1);
  return next;
}

function normalizeTitle(title) {
  return title
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function isSimilarTitle(titleA, titleB) {
  const a = normalizeTitle(titleA);
  const b = normalizeTitle(titleB);
  if (a === b) return true;
  if (Math.abs(a.length - b.length) <= 5) {
    if (a.includes(b) || b.includes(a)) return true;
  }
  return false;
}

function formatEvent(e, defaultAllDayEmoji = '') {
  if (e.allDay) {
    const hasLeadingEmoji = /^\p{Emoji}/u.test(e.title);
    if (hasLeadingEmoji || !defaultAllDayEmoji) return `▸ ${e.title}\n`;
    return `▸ ${defaultAllDayEmoji} ${e.title}\n`;
  }
  return `▸ ${e.time} ${e.title}\n`;
}

function sortEvents(events) {
  return events.slice().sort((a, b) => {
    if (a.allDay && !b.allDay) return -1;
    if (!a.allDay && b.allDay) return 1;
    return a.time.localeCompare(b.time);
  });
}

// ★ v2.25：判斷事件標題是否為特休/休假
function isLeaveEvent(title) {
  return CONFIG.LEAVE_KEYWORDS.some(kw => title.includes(kw));
}

// ======================== 主程式 ========================

function sendMorningBriefing() {
  const today = new Date();
  const todayStr = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy/MM/dd (EEE)');

  // ★ v2.25：先掃描律師行事曆，偵測特休事件
  const lawyerAll = sortEvents(getLawyerDeadlineEvents(today));
  const leaveEvents = lawyerAll.filter(e => isLeaveEvent(e.title));
  const hasLeave = leaveEvents.length > 0;
  const leaveNames = leaveEvents.map(e => e.title).join('、');

  let message = `📋 律師晨報｜${todayStr}\n`;
  message += '━━━━━━━━━━━━━━\n';

  // ★ v2.25：特休警示置頂
  if (hasLeave) {
    message += `\n⚠️ ${leaveNames}｜今日行政待辦需律師自行處理\n`;
  }

  const todayCourt = sortEvents(getCourtEvents(today, 0));
  message += '\n⚖️【今日庭期】\n';
  if (todayCourt.length === 0) {
    message += '今日無庭期\n';
  } else {
    todayCourt.forEach(e => {
      message += formatEvent(e);
      if (!e.allDay && e.location) message += `  📍 ${e.location}\n`;
    });
  }

  const nextBizDay = getNextBusinessDay(today);
  const nextBizDayStr = Utilities.formatDate(nextBizDay, 'Asia/Taipei', 'MM/dd(EEE)');
  const tomorrowCourt = sortEvents(getCourtEvents(nextBizDay, 0));
  const dayOfWeekToday = today.getDay();
  const isWeekendOrFriday = (dayOfWeekToday === 5 || dayOfWeekToday === 6 || dayOfWeekToday === 0);
  const tomorrowLabel = isWeekendOrFriday ? `下週一庭期（${nextBizDayStr}）` : '明日庭期';

  message += `\n⚖️【${tomorrowLabel}】\n`;
  if (tomorrowCourt.length === 0) {
    message += isWeekendOrFriday ? '下週一無庭期\n' : '明日無庭期\n';
  } else {
    tomorrowCourt.forEach(e => {
      message += formatEvent(e);
      if (!e.allDay && e.location) message += `  📍 ${e.location}\n`;
    });
  }

  const consultations = sortEvents(getConsultationEvents(today));
  if (consultations.length > 0) {
    message += '\n💬【今日諮詢預約】\n';
    consultations.forEach(e => { message += formatEvent(e); });
  }

  // ★ v2.25：從 lawyerAll 中排除特休事件，再分類
  const lawyerNonLeave = lawyerAll.filter(e => !isLeaveEvent(e.title));
  const lawyerDeadlines = lawyerNonLeave.filter(e => e.title.startsWith('⏰'));
  const lawyerAdmin = lawyerNonLeave.filter(e => !e.title.startsWith('⏰'));

  if (lawyerDeadlines.length > 0) {
    message += '\n⏰【今日辦案期限】\n';
    lawyerDeadlines.forEach(e => { message += formatEvent(e); });
  }

  const notionAlerts = getNotionAlerts(today);
  if (notionAlerts.todos.length > 0) {
    message += '\n⏰【案件待辦到期】\n';
    notionAlerts.todos.forEach(t => { message += `▸ ${t.caseName}：${t.todo}\n`; });
  }

  // ★ v2.24：記錄 Highlight 是否為空，後面決定是否追加 Flex Message
  const highlightEvents = sortEvents(getHighlightEvents(today));
  const highlightEmpty = (highlightEvents.length === 0);

  message += '\n⭐️【Highlight任務】\n';
  if (highlightEmpty) {
    message += '⚠️ 今日尚未設定 Highlight，建議現在設定一個最重要的任務。\n';
  } else {
    highlightEvents.forEach(e => { message += formatEvent(e); });
  }

  // ★ v2.25：行政待辦區段，有特休時加註提示
  if (lawyerAdmin.length > 0) {
    if (hasLeave) {
      message += `\n📌 【今日行政待辦】⚠️ ${leaveNames}\n`;
    } else {
      message += '\n📌 【今日行政待辦】\n';
    }
    lawyerAdmin.forEach(e => { message += formatEvent(e); });
  }

  message += '\n🚨 【時效預警】\n';
  if (notionAlerts.deadlines.length === 0) {
    message += '目前無時效警示\n';
  } else {
    notionAlerts.deadlines.forEach(d => {
      message += `▸ ${d.emoji} ${d.caseName}｜剩 ${d.daysLeft} 天（${d.deadline}）\n`;
    });
  }

  const familyEvents = sortEvents(getFamilyEvents(today, todayCourt, lawyerAll));
  if (familyEvents.length > 0) {
    message += '\n🏠 【今日家庭行程】\n';
    familyEvents.forEach(e => { message += formatEvent(e); });
  }

  if (today.getDay() === 1) {
    const weekCourt = getWeekCourtEvents(today);
    message += '\n📌 【本週庭期總覽】\n';
    if (weekCourt.length === 0) {
      message += '本週無庭期\n';
    } else {
      weekCourt.forEach(e => { message += `▸ ${e.date} ${e.time} ${e.title}\n`; });
    }
  }

  // 模組 7：身心狀態
  const healthResult = getHealthStatus(today);
  message += '\n🧘 【身心狀態】\n';
  message += healthResult.display;

  // 底部連結
  message += '\n━━━━━━━━━━━━━━\n';
  message += '💡 今日開庭準備 → https://claude.ai/new?q=今日開庭準備\n';
  message += '💡 領今日身心處方 → https://claude.ai/new?q=' + healthResult.prompt;

  // ★ v2.24c：組裝 messages 陣列（text + Flex Message）
  const lineMessages = buildTextMessages_(message);

  const flexMsg = buildHighlightFlexMessage_(highlightEmpty);
  if (lineMessages.length < 5) {
    lineMessages.push(flexMsg);
  }

  sendLinePush_(lineMessages);
  Logger.log('晨報推播完成：' + todayStr);
}

// ======================== Highlight Flex Message（v2.24 新增） ========================

function buildHighlightFlexMessage_(highlightEmpty) {
  const claudeUrl = 'https://claude.ai/new?q=' + encodeURIComponent('設定今日Highlight（推薦模式）');
  const subtitle = highlightEmpty
    ? '今天最重要的一件事是什麼？'
    : '重新檢視今天的北極星任務';
  const hint = 'Claude 會根據待辦和庭期推薦候選，你選完自動同步。';
  return {
    type: 'flex',
    altText: '🎯 設定今日 Highlight',
    contents: {
      type: 'bubble',
      size: 'kilo',
      styles: {
        body: { backgroundColor: '#FFFBEB' },
        footer: { backgroundColor: '#FFFBEB' }
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🎯 今日 Highlight',
            weight: 'bold',
            size: 'md',
            color: '#B45309'
          },
          {
            type: 'text',
            text: subtitle,
            size: 'sm',
            color: '#92400E',
            margin: 'md',
            wrap: true
          },
          {
            type: 'text',
            text: hint,
            size: 'xs',
            color: '#A8A29E',
            margin: 'md',
            wrap: true
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#D97706',
            action: {
              type: 'uri',
              label: '⭐ 立即設定 Highlight',
              uri: claudeUrl
            }
          }
        ]
      }
    }
  };
}

// ======================== Highlight 任務模組（v2.14） ========================

function getHighlightEvents(today) {
  const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
  try {
    const calendar = CalendarApp.getCalendarById(CONFIG.HIGHLIGHT_CALENDAR_ID);
    if (!calendar) return [];
    const events = calendar.getEvents(startOfDay, endOfDay);
    const results = [];
    events.forEach(event => {
      if (shouldSkipCalendarEvent(event)) return;
      // ★ v2.25：全日事件 exclusive end date 修正
      if (!isAllDayEventActiveOnDate(event, today)) return;
      const allDay = event.isAllDayEvent();
      results.push({
        allDay,
        time: allDay ? '' : Utilities.formatDate(event.getStartTime(), 'Asia/Taipei', 'HH:mm'),
        title: event.getTitle(),
      });
    });
    return results;
  } catch (error) {
    Logger.log('讀取 Highlight 行事曆錯誤：' + error.message);
    return [];
  }
}

// ======================== 家庭行程模組（v2.6） ========================

function getFamilyEvents(today, courtEvents, lawyerEvents) {
  const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);

  try {
    const calendar = CalendarApp.getCalendarById(CONFIG.FAMILY_CALENDAR_ID);
    if (!calendar) return [];
    const events = calendar.getEvents(startOfDay, endOfDay);

    const publicTitles = [
      ...courtEvents.map(e => e.title),
      ...lawyerEvents.map(e => e.title),
    ];

    const results = [];
    events.forEach(event => {
      if (shouldSkipCalendarEvent(event)) return;
      // ★ v2.25：全日事件 exclusive end date 修正
      if (!isAllDayEventActiveOnDate(event, today)) return;
      const title = event.getTitle();
      const isDuplicate = publicTitles.some(pt => isSimilarTitle(title, pt));
      if (isDuplicate) return;
      const allDay = event.isAllDayEvent();
      results.push({
        allDay,
        time: allDay ? '' : Utilities.formatDate(event.getStartTime(), 'Asia/Taipei', 'HH:mm'),
        title,
      });
    });

    return results;
  } catch (error) {
    Logger.log('讀取家庭行事曆錯誤：' + error.message);
    return [];
  }
}

// ======================== 身心狀態模組（v2.5） ========================

function getHealthStatus(today) {
  const fallback = { display: '尚無健康數據（Health Auto Export 尚未同步）\n', prompt: '充電' };

  try {
    const todayStr   = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy-MM-dd');
    const yesterday  = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = Utilities.formatDate(yesterday, 'Asia/Taipei', 'yyyy-MM-dd');

    const todayData = readHealthSheet_(todayStr);
    const yesterdayData = readHealthSheet_(yesterdayStr);

    if (!todayData) {
      const dayBefore = new Date(today); dayBefore.setDate(dayBefore.getDate() - 2);
      const dayBeforeStr = Utilities.formatDate(dayBefore, 'Asia/Taipei', 'yyyy-MM-dd');
      const dayBeforeData = readHealthSheet_(dayBeforeStr);
      if (!dayBeforeData) return fallback;
      return buildHealthDisplay_(dayBeforeData, yesterdayData || {});
    }

    return buildHealthDisplay_(todayData, yesterdayData || {});
  } catch (error) {
    Logger.log('讀取健康數據錯誤：' + error.message);
    return { display: '健康數據讀取失敗\n', prompt: '充電' };
  }
}

function readHealthSheet_(dateStr) {
  const fileName = `HealthMetrics-${dateStr}`;
  const files = DriveApp.searchFiles(`title contains "${fileName}" and mimeType = "application/vnd.google-apps.spreadsheet"`);
  if (!files.hasNext()) return null;
  const sheet = SpreadsheetApp.open(files.next()).getActiveSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const dataRow  = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = {};
  headers.forEach((h, i) => { data[h.toString().trim()] = dataRow[i]; });
  return data;
}

function buildHealthDisplay_(todayData, yesterdayData) {
  const pf = (key, src) => { const v = parseFloat(src[key]); return isNaN(v) ? null : v; };

  const sleepTotal  = pf('睡眠分析 [睡眠時間] (hr)', todayData) || pf('睡眠分析 [Total] (hr)', todayData);
  const sleepREM    = pf('睡眠分析 [REM] (hr)',  todayData);
  const hrv         = pf('心率變異性 (毫秒)',      todayData);
  const restingHR   = pf('靜止心率 (bpm)',        todayData);
  const bloodOx     = pf('血氧飽和度 (%)',        todayData);
  const breathRate  = pf('呼吸速率 (次/分)',      todayData);
  const sleepDeep   = pf('睡眠分析 [深層] (hr)',  todayData);

  const steps       = pf('步數 (步)',             yesterdayData);
  const exerciseMin = pf('Apple 運動時間 (分鐘)', yesterdayData);

  function metricLight(val, greenMin, yellowMin) {
    if (val === null) return '';
    if (val >= greenMin) return '🟢';
    if (val >= yellowMin) return '🟡';
    return '🔴';
  }

  let status = '🟢';
  let statusText = '狀態良好';

  if (sleepTotal !== null) {
    if (sleepTotal < 5.5) { status = '🔴'; statusText = '睡眠嚴重不足'; }
    else if (sleepTotal < 6.5) { if (status !== '🔴') { status = '🟡'; statusText = '睡眠不足'; } }
  }
  if (hrv !== null) {
    if (hrv < 25) { if (status !== '🔴') { status = '🔴'; statusText = '壓力偏高'; } }
    else if (hrv < 35) { if (status === '🟢') { status = '🟡'; statusText = '留意壓力'; } }
  }

  let display = `${status} 身心狀態：${statusText}\n`;

  const metrics = [];
  if (sleepTotal !== null) metrics.push(`${metricLight(sleepTotal, 6.5, 5.5)} 睡眠 ${sleepTotal.toFixed(1)}h`);
  if (sleepREM !== null)   metrics.push(`${metricLight(sleepREM, 1.1, 0.8)} REM ${sleepREM.toFixed(1)}h`);
  if (hrv !== null)        metrics.push(`${metricLight(hrv, 35, 25)} HRV ${hrv.toFixed(0)}ms`);
  if (steps !== null && steps > 0)             metrics.push(`${metricLight(steps, 7000, 3000)} 步數 ${Math.round(steps)}`);
  if (exerciseMin !== null && exerciseMin > 0) metrics.push(`${metricLight(exerciseMin, 30, 10)} 運動 ${Math.round(exerciseMin)}min`);
  if (metrics.length > 0) display += `${metrics.join('｜')}\n`;

  const promptParts = [];
  if (sleepTotal !== null) promptParts.push(`sleep${sleepTotal.toFixed(1)}h`);
  if (sleepDeep !== null)  promptParts.push(`deep${sleepDeep.toFixed(1)}h`);
  if (sleepREM !== null)   promptParts.push(`REM${sleepREM.toFixed(1)}h`);
  if (hrv !== null)        promptParts.push(`HRV${hrv.toFixed(0)}ms`);
  if (restingHR !== null)  promptParts.push(`rhr${restingHR.toFixed(0)}bpm`);
  if (breathRate !== null) promptParts.push(`br${breathRate.toFixed(1)}`);
  if (bloodOx !== null)    promptParts.push(`spo2-${bloodOx.toFixed(1)}`);
  if (steps !== null && steps > 0)             promptParts.push(`steps${Math.round(steps)}`);
  if (exerciseMin !== null && exerciseMin > 0) promptParts.push(`ex${Math.round(exerciseMin)}min`);

  const prompt = 'charge,' + promptParts.join(',');

  return { display, prompt };
}

// ======================== Google Calendar 模組 ========================

function getCourtEvents(baseDate, offsetDays) {
  const targetDate = new Date(baseDate);
  targetDate.setDate(targetDate.getDate() + offsetDays);
  const startOfDay = new Date(targetDate); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate); endOfDay.setHours(23, 59, 59, 999);
  try {
    const calendar = CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID);
    if (!calendar) return [];
    const events = calendar.getEvents(startOfDay, endOfDay);
    const results = [];
    events.forEach(event => {
      if (shouldSkipCalendarEvent(event)) return;
      // ★ v2.25：全日事件 exclusive end date 修正
      if (!isAllDayEventActiveOnDate(event, targetDate)) return;
      const allDay = event.isAllDayEvent();
      results.push({
        allDay,
        time: allDay ? '' : Utilities.formatDate(event.getStartTime(), 'Asia/Taipei', 'HH:mm'),
        title: event.getTitle(),
        location: event.getLocation() || '',
      });
    });
    return results;
  } catch (error) { Logger.log('讀取庭期行事曆錯誤：' + error.message); return []; }
}

function getWeekCourtEvents(monday) {
  const results = [];
  for (let i = 0; i < 5; i++) {
    const dayEvents = getCourtEvents(monday, i);
    const targetDate = new Date(monday); targetDate.setDate(targetDate.getDate() + i);
    const dateStr = Utilities.formatDate(targetDate, 'Asia/Taipei', 'MM/dd(EEE)');
    dayEvents.forEach(e => { results.push({ date: dateStr, time: e.time, title: e.title }); });
  }
  return results;
}

function getLawyerDeadlineEvents(today) {
  const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
  try {
    const calendar = CalendarApp.getCalendarById(CONFIG.LAWYER_CALENDAR_ID);
    if (!calendar) return [];
    const events = calendar.getEvents(startOfDay, endOfDay);
    const results = [];
    events.forEach(event => {
      if (shouldSkipCalendarEvent(event)) return;
      // ★ v2.25：全日事件 exclusive end date 修正
      if (!isAllDayEventActiveOnDate(event, today)) return;
      const allDay = event.isAllDayEvent();
      results.push({
        allDay,
        time: allDay ? '' : Utilities.formatDate(event.getStartTime(), 'Asia/Taipei', 'HH:mm'),
        title: event.getTitle(),
      });
    });
    return results;
  } catch (error) { Logger.log('讀取律師行事曆錯誤：' + error.message); return []; }
}

function getConsultationEvents(today) {
  const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
  try {
    const calendar = CalendarApp.getCalendarById(CONFIG.CONSULTATION_CALENDAR_ID);
    if (!calendar) return [];
    const events = calendar.getEvents(startOfDay, endOfDay);
    return events
      .filter(event => event.getTitle().includes('王律'))
      .map(event => {
        const allDay = event.isAllDayEvent();
        return {
          allDay,
          time: allDay ? '' : Utilities.formatDate(event.getStartTime(), 'Asia/Taipei', 'HH:mm'),
          title: event.getTitle(),
        };
      })
      .sort((a, b) => a.time.localeCompare(b.time));
  } catch (error) { Logger.log('讀取諮詢預約行事曆錯誤：' + error.message); return []; }
}

// ======================== Notion API 模組 ========================

function getNotionAlerts(today) {
  const result = { todos: [], deadlines: [] };
  try {
    const payload = { filter: { property: '狀態', select: { equals: '進行中' } }, page_size: 100 };
    const response = UrlFetchApp.fetch(`https://api.notion.com/v1/databases/${CONFIG.CASE_DB_ID}/query`, {
      method: 'post',
      headers: { 'Authorization': `Bearer ${CONFIG.NOTION_API_KEY}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    const data = JSON.parse(response.getContentText());
    if (data.status && data.status !== 200) { Logger.log('Notion API 錯誤：' + response.getContentText()); return result; }
    const todayTime = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    data.results.forEach(page => {
      const props = page.properties;
      const caseName = getNotionTitle(props['案件簡稱']);
      if (!caseName) return;
      const todoText = getNotionRichText(props['待辦事項']);
      const nextCourtDate = getNotionDate(props['下次庭期']);
      if (todoText && nextCourtDate) {
        const daysUntilCourt = Math.ceil((new Date(nextCourtDate).getTime() - todayTime) / (1000 * 60 * 60 * 24));
        if (daysUntilCourt <= 3 && daysUntilCourt >= 0) {
          result.todos.push({ caseName, todo: todoText.substring(0, 50) + (todoText.length > 50 ? '...' : '') });
        }
      }
      const deadlineDate = getNotionDate(props['時效截止']);
      if (deadlineDate) {
        const daysLeft = Math.ceil((new Date(deadlineDate).getTime() - todayTime) / (1000 * 60 * 60 * 24));
        if (daysLeft <= 30 && daysLeft >= 0) {
          let emoji = '⚠️';
          if (daysLeft <= 1) emoji = '🔴'; else if (daysLeft <= 3) emoji = '🟠'; else if (daysLeft <= 7) emoji = '🟡';
          result.deadlines.push({ caseName, deadline: deadlineDate, daysLeft, emoji });
        }
        if (daysLeft < 0) result.deadlines.push({ caseName, deadline: deadlineDate, daysLeft, emoji: '❌' });
      }
    });
    result.deadlines.sort((a, b) => a.daysLeft - b.daysLeft);
  } catch (error) { Logger.log('Notion API 錯誤：' + error.message); }
  return result;
}

function getNotionTitle(prop) { if (!prop || !prop.title || prop.title.length === 0) return ''; return prop.title.map(t => t.plain_text).join(''); }
function getNotionRichText(prop) { if (!prop || !prop.rich_text || prop.rich_text.length === 0) return ''; return prop.rich_text.map(t => t.plain_text).join(''); }
function getNotionDate(prop) { if (!prop || !prop.date || !prop.date.start) return null; return prop.date.start; }

// ======================== LINE Messaging API 模組（v2.24 重構） ========================

function buildTextMessages_(text) {
  const MAX_LENGTH = 4500;
  const messages = [];
  if (text.length <= MAX_LENGTH) {
    messages.push({ type: 'text', text: text });
  } else {
    const lines = text.split('\n');
    let current = '';
    lines.forEach(line => {
      if ((current + '\n' + line).length > MAX_LENGTH) {
        messages.push({ type: 'text', text: current });
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    });
    if (current) messages.push({ type: 'text', text: current });
  }
  return messages.slice(0, 4);
}

function sendLinePush_(messageObjects) {
  const payload = {
    to: CONFIG.LINE_USER_ID,
    messages: messageObjects.slice(0, 5)
  };
  try {
    const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONFIG.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) Logger.log('LINE 推播失敗：' + response.getContentText());
    else Logger.log('LINE 推播成功（共 ' + messageObjects.length + ' 則訊息）');
  } catch (error) {
    Logger.log('LINE 推播錯誤：' + error.message);
  }
}

function sendLineMessage(text) {
  const messages = buildTextMessages_(text);
  sendLinePush_(messages);
}

function doPost(e) { return ContentService.createTextOutput('OK'); }

function testBriefing() { sendMorningBriefing(); }

function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(trigger => { if (trigger.getHandlerFunction() === 'sendMorningBriefing') ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('sendMorningBriefing').timeBased().atHour(8).everyDays(1).inTimezone('Asia/Taipei').create();
  Logger.log('✅ 已設定每日 08:00 觸發器');
}

function removeAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(trigger => ScriptApp.deleteTrigger(trigger));
  Logger.log('已移除所有觸發器');
}

function testHealthStatus() {
  const result = getHealthStatus(new Date());
  Logger.log('display:\n' + result.display);
  Logger.log('prompt:\n' + result.prompt);
}

function testFamilyEvents() {
  const today = new Date();
  const courtEvents = getCourtEvents(today, 0);
  const lawyerEvents = getLawyerDeadlineEvents(today);
  const familyEvents = getFamilyEvents(today, courtEvents, lawyerEvents);
  Logger.log('家庭行程（去重後）：');
  if (familyEvents.length === 0) {
    Logger.log('今日無家庭行程');
  } else {
    familyEvents.forEach(e => Logger.log(`▸ ${e.time} ${e.title}`));
  }
}
