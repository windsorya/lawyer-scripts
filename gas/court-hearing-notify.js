/**
 * 庭期前一天通知推播 v1.7（多格版）
 * 每天上午 09:00-10:00 掃描下一個工作日庭期，擬好當事人通知訊息，
 * 透過 LINE Bot 推播給王律師
 * 第一格：庭期總覽 / 後續每格：各案件可直接轉發的訊息
 * 依賴主檔案的 CONFIG 和 getNextBusinessDay()
 *
 * v1.2 變更：改為多格架構（總覽 + 各案件獨立訊息）
 * v1.3 變更：getNotifyTomorrowRange_() 改用 getNextBusinessDay()
 * v1.4 變更：週五時客戶訊息「明天」→「下週一」動態判斷
 * v1.5 變更：從 Notion 案件資料庫查詢「▸性別」欄位，
 *           自動稱呼「先生」或「小姐」，查不到時 fallback 為「先生（小姐）」
 * v1.6 變更：庭期過濾改為寬鬆版正則（不要求冒號），避免漏抓
 *           parseNotifyTitle_ 相容有冒號和無冒號兩種格式
 * v1.7 變更：(1) 修正「您您好」bug（機關案件 greeting='您' + '您好' 重複）
 *           (2) 新增從 Notion 查詢「▸承辦窗口」欄位，機關案件可個性化稱呼
 *               （如「張小姐您好」而非「您您好」）
 *           (3) 機關案件（有承辦窗口）不附「請記得攜帶身分證正本…」固定尾巴
 */

function notifyTomorrowHearings() {
  var tomorrow = getNotifyTomorrowRange_();
  var events = getNotifyCourtEvents_(tomorrow);
  if (events.length === 0) {
    Logger.log('下一個工作日沒有需要通知的庭期');
    return;
  }

  // v1.5：批次查詢所有進行中案件的性別資料
  // v1.7：同時查詢「▸承辦窗口」欄位
  var caseDataMap = fetchCaseDataFromNotion_();

  var messages = buildNotifyMessages_(events, tomorrow, caseDataMap);
  sendNotifyLineMessages_(messages);
  Logger.log('已推播 ' + events.length + ' 筆庭期通知（' + messages.length + ' 則訊息）');
}

// ======================== v1.7 重構：Notion 案件資料查詢 ========================

/**
 * 從 Notion 案件追蹤資料庫批次查詢所有案件的「案件簡稱」→ { gender, contact } 對應
 * gender: "男"/"女"/""
 * contact: "張臻小姐"/"張小姐"/""（承辦窗口欄位值）
 * 回傳格式：{ "生管處國賠案": { gender: "...", contact: "張臻小姐" }, ... }
 */
function fetchCaseDataFromNotion_() {
  var map = {};
  try {
    var payload = {
      page_size: 100
    };

    var response = UrlFetchApp.fetch(
      'https://api.notion.com/v1/databases/' + CONFIG.CASE_DB_ID + '/query',
      {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      }
    );

    var data = JSON.parse(response.getContentText());
    if (data.status && data.status !== 200) {
      Logger.log('Notion 案件資料查詢錯誤：' + response.getContentText());
      return map;
    }

    data.results.forEach(function(page) {
      var props = page.properties;
      var caseName = '';
      var gender = '';
      var contact = '';

      // 取得案件簡稱（title 欄位）
      if (props['案件簡稱'] && props['案件簡稱'].title && props['案件簡稱'].title.length > 0) {
        caseName = props['案件簡稱'].title.map(function(t) { return t.plain_text; }).join('');
      }

      // 取得性別（select 欄位）
      if (props['▸性別'] && props['▸性別'].select && props['▸性別'].select.name) {
        gender = props['▸性別'].select.name;
      }

      // v1.7：取得承辦窗口（rich_text 欄位）
      if (props['▸承辦窗口'] && props['▸承辦窗口'].rich_text && props['▸承辦窗口'].rich_text.length > 0) {
        contact = props['▸承辦窗口'].rich_text.map(function(t) { return t.plain_text; }).join('').trim();
      }

      if (caseName) {
        map[caseName] = { gender: gender, contact: contact };
      }
    });

    Logger.log('已載入 ' + Object.keys(map).length + ' 筆案件資料');

  } catch (error) {
    Logger.log('Notion 案件資料查詢錯誤：' + error.message);
  }

  return map;
}

/**
 * v1.7：根據案件簡稱查詢承辦窗口或性別，回傳 { greeting, isOrg }
 * greeting: 稱呼文字（如「張小姐」「蘇先生」「您」）
 * isOrg: 是否為機關案件（影響訊息尾巴）
 */
function getGreetingInfo_(caseName, caseDataMap) {
  var caseData = findCaseData_(caseName, caseDataMap);

  // 有承辦窗口 → 機關案件，用承辦窗口稱呼
  if (caseData && caseData.contact) {
    return { greeting: caseData.contact, isOrg: true };
  }

  // 判斷是否為機關名稱開頭（無承辦窗口的機關案件）
  var orgPattern = /^(生管|衛生|建設|市府|台中市|臺中市|國稅|勞工|教育|環保|都發|交通|社會|民政|地政|水利|農業|經發|消防|文化|觀旅|法制|主計|人事|政風|研考)/;
  if (caseName.match(orgPattern)) {
    return { greeting: '您', isOrg: true };
  }

  // 一般案件：用姓氏 + 性別稱呼
  var nameMatch = caseName.match(/^([\u4e00-\u9fff]{1})/);
  var lastName = nameMatch ? nameMatch[1] : '';
  if (lastName) {
    var honorific = '先生（小姐）';
    if (caseData && caseData.gender) {
      honorific = caseData.gender === '女' ? '小姐' : '先生';
    }
    return { greeting: lastName + honorific, isOrg: false };
  }

  return { greeting: '您', isOrg: false };
}

/**
 * 在 caseDataMap 中模糊查找案件資料
 */
function findCaseData_(caseName, caseDataMap) {
  // 直接匹配
  if (caseDataMap[caseName]) return caseDataMap[caseName];

  // 加「案」字匹配
  if (caseDataMap[caseName + '案']) return caseDataMap[caseName + '案'];

  // 模糊匹配
  var keys = Object.keys(caseDataMap);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(caseName) !== -1 || caseName.indexOf(keys[i].replace('案', '')) !== -1) {
      return caseDataMap[keys[i]];
    }
  }

  return null;
}

// ======================== 原有函式 ========================

function getNotifyTomorrowRange_() {
  var now = new Date();
  var nextBizDay = getNextBusinessDay(now);
  var start = new Date(nextBizDay);
  start.setHours(0, 0, 0, 0);
  var end = new Date(nextBizDay);
  end.setHours(23, 59, 59, 999);

  var todayDay = now.getDay();
  var isOverWeekend = (todayDay === 5 || todayDay === 6 || todayDay === 0);
  var dayLabel = isOverWeekend ? '下週一' : '明天';

  return { date: nextBizDay, start: start, end: end, dayLabel: dayLabel };
}

function getNotifyCourtEvents_(tomorrow) {
  var calendar = CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID);
  if (!calendar) {
    Logger.log('找不到庭期行事曆');
    return [];
  }
  var events = calendar.getEvents(tomorrow.start, tomorrow.end);
  var filtered = [];
  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    var title = event.getTitle();
    if (title.match(/.律/)) {
      Logger.log('排除（含律師標記）：' + title);
      continue;
    }
    if (!title.match(/^(開庭|宣判|調解|律見)/)) {
      Logger.log('排除（非庭期事件）：' + title);
      continue;
    }
    if (title.indexOf('✅') !== -1) {
      Logger.log('排除（已完成）：' + title);
      continue;
    }
    var color = event.getColor();
    if (color && CONFIG.DONE_COLORS.indexOf(color) !== -1) {
      Logger.log('排除（綠色已完成）：' + title);
      continue;
    }
    var parsed = parseNotifyTitle_(title);
    filtered.push({
      title: title,
      caseName: parsed.caseName,
      hearingType: parsed.hearingType,
      startTime: event.getStartTime(),
      location: event.getLocation() || '',
      description: event.getDescription() || ''
    });
  }
  filtered.sort(function(a, b) { return a.startTime - b.startTime; });
  return filtered;
}

function parseNotifyTitle_(title) {
  var typeMatch = title.match(/^(開庭|宣判|調解|律見)[：:\s]?/);
  var hearingType = typeMatch ? typeMatch[1] : '開庭';
  var rest = title.replace(/^(開庭|宣判|調解|律見)[：:\s]?/, '').trim();
  var caseName = rest
    .replace(/[\(（][^)）]+[\)）]/g, '')
    .replace(/\d{2,3}[年]?[\u4e00-\u9fff]*\d+/g, '')
    .trim();
  return { caseName: caseName, hearingType: hearingType };
}

// v1.7：buildNotifyMessages_ 第 3 個參數改為 caseDataMap
function buildNotifyMessages_(events, tomorrow, caseDataMap) {
  var dateStr = (tomorrow.date.getMonth() + 1) + '/' + tomorrow.date.getDate();
  var dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][tomorrow.date.getDay()];
  var dayLabel = tomorrow.dayLabel;
  var messages = [];

  var overview = '【' + dayLabel + '庭期・轉發提醒】\n';
  overview += '📅 ' + dateStr + '（' + dayOfWeek + '）\n';
  overview += '━━━━━━━━━━━━━\n';
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    var timeStr = formatNotifyTime_(e.startTime);
    overview += '\n📌 ' + e.title + '\n';
    overview += '🕐 ' + timeStr;
    if (e.location) {
      overview += ' ｜ ' + shortenNotifyLocation_(e.location);
    }
    overview += '\n';
  }
  overview += '\n💡 以下每則訊息可直接長按轉發到對應的王律群組';
  messages.push(overview);
  for (var j = 0; j < events.length; j++) {
    var ev = events[j];
    var ts = formatNotifyTime_(ev.startTime);
    var clientMsg = buildNotifyClientMsg_(ev, dateStr, dayOfWeek, ts, dayLabel, caseDataMap);
    messages.push(clientMsg);
  }
  return messages;
}

// v1.7：重寫 buildNotifyClientMsg_，修正「您您好」bug + 機關案件個性化 + 不加固定尾巴
function buildNotifyClientMsg_(event, dateStr, dayOfWeek, timeStr, dayLabel, caseDataMap) {
  var caseName = event.caseName;
  var hearingType = event.hearingType;

  // v1.7：統一用 getGreetingInfo_ 取得稱呼和機關判斷
  var info = getGreetingInfo_(caseName, caseDataMap);
  var greeting = info.greeting;
  var isOrg = info.isOrg;

  var locationNote = '';
  if (event.location) {
    locationNote = '\n📍 地點：' + shortenNotifyLocation_(event.location);
  }

  // v1.7：機關案件的尾巴不同
  var personalTail = '請記得攜帶身分證正本，並提早 10~15 分鐘到場與律師會合。\n'
    + '有任何問題請隨時與律師聯繫。';
  var orgTail = '如有任何問題，請與律師保持聯繫，謝謝。';

  var tail = isOrg ? orgTail : personalTail;

  var clientMsg = '';
  var dateTimeStr = dayLabel + ' ' + dateStr + '（' + dayOfWeek + '）' + timeStr;

  if (isOrg) {
    // ★ v1.7：機關案件格式——緊湊正式，加「本案」，不空行
    var orgAction = '開庭';
    if (hearingType === '宣判') orgAction = '宣判';
    else if (hearingType === '調解') orgAction = '進行調解';
    clientMsg = greeting + '您好，提醒您\n\n'
      + '本案' + dateTimeStr + ' ' + orgAction + '。'
      + locationNote + '\n\n'
      + orgTail;
  } else if (hearingType === '宣判') {
    clientMsg = greeting + '您好，\n\n'
      + '提醒您' + dateTimeStr + '，案件將進行宣判。'
      + locationNote + '\n\n'
      + '宣判不一定需要到庭，如果需要您出席會另行通知。\n'
      + '律師會在宣判後第一時間告知您結果。';
  } else if (hearingType === '調解') {
    clientMsg = greeting + '您好，\n\n'
      + '提醒您' + dateTimeStr + ' 要進行調解。'
      + locationNote + '\n\n'
      + personalTail;
  } else {
    clientMsg = greeting + '您好，\n\n'
      + '提醒您' + dateTimeStr + ' 要開庭。'
      + locationNote + '\n\n'
      + personalTail;
  }
  return clientMsg;
}

function sendNotifyLineMessages_(messages) {
  var lineMessages = [];
  for (var i = 0; i < messages.length && i < 5; i++) {
    lineMessages.push({ type: 'text', text: messages[i] });
  }
  var payload = {
    to: CONFIG.LINE_USER_ID,
    messages: lineMessages
  };
  try {
    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code !== 200) {
      Logger.log('LINE API 錯誤：' + code + ' ' + response.getContentText());
    } else {
      Logger.log('LINE 推播成功（' + lineMessages.length + ' 則訊息）');
    }
  } catch (error) {
    Logger.log('LINE 推播錯誤：' + error.message);
  }
}

function shortenNotifyLocation_(location) {
  return location
    .replace(/,?\s*\d{3}台灣.*$/g, '')
    .replace(/,?\s*\d{3}Taiwan.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatNotifyTime_(date) {
  var h = date.getHours();
  var m = date.getMinutes();
  var period = h < 12 ? '上午' : '下午';
  var h12 = h <= 12 ? h : h - 12;
  return period + ' ' + h12 + ':' + (m < 10 ? '0' : '') + m;
}

function testNotifySpecificDate() {
  var targetDate = new Date('2026-03-26T00:00:00+08:00');
  var start = new Date(targetDate);
  start.setHours(0, 0, 0, 0);
  var end = new Date(targetDate);
  end.setHours(23, 59, 59, 999);
  var fakeTomorrow = { date: targetDate, start: start, end: end, dayLabel: '明天' };
  var events = getNotifyCourtEvents_(fakeTomorrow);
  Logger.log('找到 ' + events.length + ' 筆庭期');
  if (events.length > 0) {
    var caseDataMap = fetchCaseDataFromNotion_();
    var messages = buildNotifyMessages_(events, fakeTomorrow, caseDataMap);
    for (var i = 0; i < messages.length; i++) {
      Logger.log('===== 訊息 ' + (i + 1) + ' =====\n' + messages[i]);
    }
  }
}
