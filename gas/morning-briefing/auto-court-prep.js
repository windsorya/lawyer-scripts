/**
 * 自動開庭準備系統 v1.0
 * ─────────────────────────────────────────────
 * 08:00 觸發 runAutoCourtPrep()
 *   掃描「下一個工作日（台灣假日感知）」的庭期
 *   → 查 Notion 案件頁 → 呼叫 Claude 生成準備 → 建 Notion 子頁面
 *   → 標記 Calendar prep_done → LINE 推播
 *
 * 07:00 觸發 runTodayCourtReminder()
 *   掃描今天庭期 → 推播「今天開庭提醒」
 *
 * 觸發器安裝：ensureAutoCourtPrepTrigger_()
 *   由 sendMorningBriefing() 開頭呼叫，自我安裝
 *
 * 依賴：程式碼.js 的 CONFIG（含 NOTION_API_KEY、LINE_CHANNEL_ACCESS_TOKEN、
 *        COURT_CALENDAR_ID、LINE_USER_ID、DONE_COLORS）
 * ─────────────────────────────────────────────
 */

// 案件追蹤 DB（d63c9983）
var COURT_PREP_CASE_DB_ID = 'd63c9983-e51c-45a5-a725-76ed816d6034';

// ======================== 主觸發函式 ========================

/**
 * 08:00 觸發：生成開庭準備
 * 找出「今天是其前一個工作日」的庭期，逐一生成準備文件
 */
function runAutoCourtPrep() {
  var today = new Date();
  var targetDate = getNextCourtDate_(today);
  var dateStr = Utilities.formatDate(targetDate, 'Asia/Taipei', 'yyyy-MM-dd');
  Logger.log('[autoCourtPrep] 目標庭期日：' + dateStr);

  var events = getCourtPrepEvents_(targetDate);
  if (events.length === 0) {
    Logger.log('[autoCourtPrep] 無需準備的庭期（' + dateStr + '）');
    return;
  }
  Logger.log('[autoCourtPrep] 找到 ' + events.length + ' 個庭期');

  var successCount = 0;
  var failCount = 0;
  for (var i = 0; i < events.length; i++) {
    try {
      if (processCourtPrepEvent_(events[i], targetDate)) successCount++;
    } catch (e) {
      failCount++;
      Logger.log('[autoCourtPrep] 處理失敗：' + events[i].getTitle() + ' — ' + e);
      notifyLinePrepError_(events[i].getTitle(), e.toString());
    }
  }
  Logger.log('[autoCourtPrep] 完成：成功 ' + successCount + '，失敗 ' + failCount);
}

/**
 * 07:00 觸發：今天開庭提醒 + 補救昨晚未產出的開庭準備
 * 規格：推播今天開庭提醒 + 補救未產出的開庭準備
 */
function runTodayCourtReminder() {
  var today = new Date();
  var events = getCourtPrepEvents_(today);

  if (events.length === 0) {
    Logger.log('[todayReminder] 今天沒有庭期');
    return;
  }

  // 1. 推播今天開庭提醒
  sendTodayCourtReminderLine_(events, today);
  Logger.log('[todayReminder] 已推播今日庭期提醒（' + events.length + ' 筆）');

  // 2. 補救：對 prep_done 未標記的庭期補產開庭準備
  var rescued = 0;
  for (var i = 0; i < events.length; i++) {
    try {
      Logger.log('[todayReminder] 補救生成開庭準備：' + events[i].getTitle());
      if (processCourtPrepEvent_(events[i], today)) rescued++;
    } catch (e) {
      Logger.log('[todayReminder] 補救失敗：' + events[i].getTitle() + ' — ' + e);
      notifyLinePrepError_(events[i].getTitle(), e.toString());
    }
  }
  if (rescued > 0) Logger.log('[todayReminder] 補救完成：' + rescued + ' 筆');
}

// ======================== 觸發器管理 ========================

/**
 * 自我安裝觸發器，由 sendMorningBriefing() 呼叫
 * 安裝 08:00 runAutoCourtPrep 與 07:00 runTodayCourtReminder
 */
function ensureAutoCourtPrepTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  var hasPrepTrigger = triggers.some(function(t) {
    return t.getHandlerFunction() === 'runAutoCourtPrep';
  });
  var hasReminderTrigger = triggers.some(function(t) {
    return t.getHandlerFunction() === 'runTodayCourtReminder';
  });

  if (!hasPrepTrigger) {
    ScriptApp.newTrigger('runAutoCourtPrep')
      .timeBased()
      .everyDays(1)
      .atHour(8)
      .create();
    Logger.log('✅ 觸發器已建立：runAutoCourtPrep 每日 08:00-09:00');
  }
  if (!hasReminderTrigger) {
    ScriptApp.newTrigger('runTodayCourtReminder')
      .timeBased()
      .everyDays(1)
      .atHour(7)
      .create();
    Logger.log('✅ 觸發器已建立：runTodayCourtReminder 每日 07:00-08:00');
  }
}

// ======================== Calendar 相關 ========================

/**
 * 取得目標日期的開庭事件（已排除完成 & 已準備）
 */
function getCourtPrepEvents_(targetDate) {
  var calendar = CalendarApp.getCalendarById(CONFIG.COURT_CALENDAR_ID);
  if (!calendar) {
    Logger.log('[getCourtPrepEvents] 找不到開庭行事曆');
    return [];
  }

  var start = new Date(targetDate);
  start.setHours(0, 0, 0, 0);
  var end = new Date(targetDate);
  end.setHours(23, 59, 59, 999);

  var allEvents = calendar.getEvents(start, end);
  var filtered = [];

  for (var i = 0; i < allEvents.length; i++) {
    var ev = allEvents[i];
    var title = ev.getTitle();

    // 只處理庭期事件
    if (!title.match(/^(開庭|宣判|調解|律見)/)) continue;

    // 排除已完成（✅ 或完成色）
    if (title.indexOf('✅') !== -1) continue;
    var color = ev.getColor();
    if (color && CONFIG.DONE_COLORS.indexOf(color) !== -1) continue;

    // 排除已生成過準備文件的
    var desc = ev.getDescription() || '';
    if (desc.indexOf('prep_done: true') !== -1) continue;

    filtered.push(ev);
  }

  return filtered;
}

/**
 * 找出今天之後的下一個工作日（考慮台灣假日）
 * 即「今天 = 目標庭期的前一個工作日」
 */
function getNextCourtDate_(today) {
  var holidays = getTaiwanHolidays_();
  var next = new Date(today);
  next.setDate(next.getDate() + 1);

  for (var i = 0; i < 14; i++) {
    var day = next.getDay();
    var ds = Utilities.formatDate(next, 'Asia/Taipei', 'yyyy-MM-dd');
    if (day !== 0 && day !== 6 && holidays.indexOf(ds) === -1) return next;
    next.setDate(next.getDate() + 1);
  }
  return next;
}

/**
 * 取得未來 30 天的台灣法定假日清單
 */
function getTaiwanHolidays_() {
  var holidays = [];
  try {
    var cal = CalendarApp.getCalendarById('zh-tw.taiwan#holiday@group.v.calendar.google.com');
    if (!cal) return holidays;
    var now = new Date();
    var end = new Date(now);
    end.setDate(end.getDate() + 30);
    var evs = cal.getEvents(now, end);
    for (var i = 0; i < evs.length; i++) {
      var ds = Utilities.formatDate(evs[i].getStartTime(), 'Asia/Taipei', 'yyyy-MM-dd');
      if (holidays.indexOf(ds) === -1) holidays.push(ds);
    }
  } catch (e) {
    Logger.log('[holidays] 無法取得台灣假日：' + e);
  }
  return holidays;
}

/**
 * 在 Calendar 事件 description 加入 prep_done 標記
 */
function markCalendarEventPrepDone_(event) {
  try {
    var desc = event.getDescription() || '';
    if (desc.indexOf('prep_done: true') === -1) {
      var ts = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
      event.setDescription(desc + '\n\nprep_done: true\n準備時間：' + ts);
    }
  } catch (e) {
    Logger.log('[markDone] 標記失敗：' + e);
  }
}

/**
 * 解析庭期事件標題
 * 回傳 { caseName, hearingType, caseNumber }
 */
function parseCourtPrepTitle_(title) {
  var typeMatch = title.match(/^(開庭|宣判|調解|律見)[：:：\s]?/);
  var hearingType = typeMatch ? typeMatch[1] : '開庭';
  var rest = title.replace(/^(開庭|宣判|調解|律見)[：:：\s]?/, '').trim();

  // 嘗試從括號內取案號
  var caseNumInBracket = rest.match(/[（(]([^)）]*[\u5b57\u865f][^)）]*)[）)]/);
  var caseNumber = caseNumInBracket ? caseNumInBracket[1].trim() : '';

  var caseName = rest
    .replace(/[（(][^)）]+[）)]/g, '')
    .replace(/\d{2,3}\s*年?度?\s*[^\s\d]{1,4}字第?\d+[號号]?/g, '')
    .trim();

  return { caseName: caseName, hearingType: hearingType, caseNumber: caseNumber };
}

/**
 * 解析庭期事件 description
 * 嘗試提取案號、法官、股別
 * 格式容錯：113年度訴字第123號、113訴字第123、法官：林某某、勤股
 */
function parseCourtPrepDescription_(desc) {
  if (!desc) return { caseNumber: '', judge: '', division: '' };

  // 案號（標準格式）
  var m = desc.match(/(\d{2,3})\s*年度\s*([^\s\d]{1,6}字)\s*第?\s*(\d+)\s*[號号]/);
  // 案號（簡化格式：113訴123）
  if (!m) m = desc.match(/(\d{2,3})\s*([\u4e00-\u9fff]{1,4}字)\s*第?\s*(\d+)/);
  var caseNumber = m ? (m[1] + '年度' + m[2] + '第' + m[3] + '號') : '';

  // 法官
  var judgeM = desc.match(/(?:法官|承辦|檢察官|書記)[：:：\s]+([^\s\n,，（(]{2,4})/);
  var judge = judgeM ? judgeM[1].trim() : '';

  // 股別（如「勤股」「廉股」）
  var divM = desc.match(/([^\s]{1,3}股)/);
  var division = divM ? divM[1].trim() : '';

  return { caseNumber: caseNumber, judge: judge, division: division };
}

// ======================== 處理單一庭期 ========================

/**
 * 處理單一庭期事件：完整流程
 */
function processCourtPrepEvent_(event, hearingDate) {
  var title = event.getTitle();
  var desc = event.getDescription() || '';
  var location = event.getLocation() || '';
  var startTime = event.getStartTime();

  Logger.log('[process] 開始處理：' + title);

  var titleParsed = parseCourtPrepTitle_(title);
  var descParsed = parseCourtPrepDescription_(desc);

  var caseNumber = descParsed.caseNumber || titleParsed.caseNumber || '';
  var caseName = titleParsed.caseName;
  var judge = descParsed.judge;
  var division = descParsed.division;
  var hearingType = titleParsed.hearingType;
  var isChen = title.indexOf('(陳律)') !== -1 || title.indexOf('（陳律）') !== -1;

  var dateStr = Utilities.formatDate(hearingDate, 'Asia/Taipei', 'MM/dd(EEE)');
  var timeStr = Utilities.formatDate(startTime, 'Asia/Taipei', 'HH:mm');

  // 1. 搜尋 Notion 案件頁
  var notionPage = searchNotionCasePage_(caseName, caseNumber);
  var notionContent = '';
  var notionPageId = '';

  if (notionPage) {
    notionPageId = notionPage.id;
    notionContent = fetchNotionPageContent_(notionPageId);

    // 補充法官/股別資訊
    var props = notionPage.properties || {};
    if (!judge) {
      var jProp = props['▸法官'];
      if (jProp && jProp.rich_text && jProp.rich_text.length > 0) {
        judge = jProp.rich_text.map(function(t) { return t.plain_text; }).join('');
      }
    }
    if (!division) {
      var dProp = props['▸股別'];
      if (dProp && dProp.rich_text && dProp.rich_text.length > 0) {
        division = dProp.rich_text.map(function(t) { return t.plain_text; }).join('');
      }
    }
  }

  // 2. 判斷案件類型
  var caseType = detectCaseType_(caseNumber, notionPage);
  Logger.log('[process] 案件類型：' + caseType + '，案號：' + caseNumber);

  var caseInfo = {
    caseName: caseName,
    caseNumber: caseNumber,
    caseType: caseType,
    judge: judge,
    division: division,
    hearingType: hearingType,
    date: dateStr,
    time: timeStr,
    location: location
  };

  // 3a. 法官統計數據（注入 Claude prompt，失敗時靜默略過）
  var judgeStatsJson = null;
  if (caseInfo.judge) {
    var apiCaseTypeForStats = { '刑偵': 'M', '刑審': 'M', '民事': 'V', '行政': 'A' }[caseType] || 'M';
    judgeStatsJson = _fetchJudgeStatsJson_(caseInfo.judge, _courtCode_(caseInfo.location || ''), apiCaseTypeForStats);
    if (judgeStatsJson) {
      Logger.log('[process] 已取得法官統計：' + caseInfo.judge + ' total=' + (judgeStatsJson.total_cases || 0));
    } else {
      Logger.log('[process] 法官統計查無資料或失敗，略過');
    }
  }

  // 3b. 呼叫 Claude 生成準備
  var prepContent = generateCourtPrep_(caseType, caseInfo, notionContent, judgeStatsJson);
  if (!prepContent) {
    throw new Error('Claude API 未回傳內容');
  }

  // 4. 建立 Notion 子頁面（掛在案件頁下）
  var pageTitle = '開庭準備｜' + (caseName || caseNumber) + '｜' + dateStr;
  var newPageUrl = '';
  if (notionPageId) {
    newPageUrl = createNotionPrepPage_(notionPageId, pageTitle, prepContent, caseInfo);
  } else {
    Logger.log('[process] 找不到 Notion 案件頁，略過建立子頁面');
  }

  // 5. 標記 Calendar
  markCalendarEventPrepDone_(event);

  // 6. LINE 通知
  notifyLineCourtPrepDone_(caseInfo, newPageUrl, isChen);

  Logger.log('[process] 完成：' + title + (newPageUrl ? ' → ' + newPageUrl : ''));
  return true;
}

// ======================== 案件類型辨識 ========================

/**
 * 依案號格式辨識案件類型
 * 回傳：'刑偵' | '刑審' | '民事' | '行政'
 */
function detectCaseType_(caseNumber, notionPage) {
  if (caseNumber) {
    if (/[偵他相]字/.test(caseNumber)) return '刑偵';
    if (/易字|簡字|簡上字|金訴字|侵訴字/.test(caseNumber)) return '刑審';
    if (/訴更字|行訴字|行政/.test(caseNumber)) return '行政';
    if (/家調字|婚字|親字|家訴字|監字|養字/.test(caseNumber)) return '民事';

    // 訴字 → 靠 Notion 補充判斷
    if (/訴字/.test(caseNumber) && notionPage) {
      var props = notionPage.properties || {};
      var ctProp = props['▸案件類型'] || props['案件類型'];
      if (ctProp && ctProp.select) {
        var n = ctProp.select.name || '';
        if (/刑事偵查/.test(n)) return '刑偵';
        if (/刑/.test(n)) return '刑審';
        if (/行政/.test(n)) return '行政';
        if (/民|家事/.test(n)) return '民事';
      }
      return '刑審'; // 訴字預設刑事
    }
  }

  // Notion 案件類型 fallback
  if (notionPage) {
    var props2 = notionPage.properties || {};
    var ct2 = props2['▸案件類型'] || props2['案件類型'];
    if (ct2 && ct2.select) {
      var n2 = ct2.select.name || '';
      if (/刑事偵查/.test(n2)) return '刑偵';
      if (/刑/.test(n2)) return '刑審';
      if (/行政/.test(n2)) return '行政';
      if (/民|家事/.test(n2)) return '民事';
    }
  }

  return '刑審'; // 預設
}

// ======================== Notion 相關 ========================

/**
 * 在 Notion 案件追蹤 DB 搜尋案件頁面
 * 優先用案件簡稱，次用案號
 */
function searchNotionCasePage_(caseName, caseNumber) {
  if (caseName) {
    var r = notionQueryByTitle_(caseName);
    if (r) return r;
    r = notionQueryByTitle_(caseName + '案');
    if (r) return r;
    // 移除常見後綴再試
    var shortName = caseName.replace(/案$/, '').replace(/[（(][^)）]+[）)]/g, '').trim();
    if (shortName && shortName !== caseName) {
      r = notionQueryByTitle_(shortName);
      if (r) return r;
    }
  }
  if (caseNumber) {
    var r2 = notionSearchByQuery_(caseNumber);
    if (r2) return r2;
  }
  return null;
}

/**
 * 透過 title 欄位查詢 Notion 案件追蹤 DB
 */
function notionQueryByTitle_(caseName) {
  try {
    var payload = {
      filter: { property: '案件簡稱', title: { contains: caseName } },
      page_size: 5
    };
    var res = notionFetch_(
      'https://api.notion.com/v1/databases/' + COURT_PREP_CASE_DB_ID + '/query',
      { method: 'post', payload: JSON.stringify(payload) }
    );
    if (res && res.results && res.results.length > 0) return res.results[0];
  } catch (e) {
    Logger.log('[notionQueryByTitle] ' + e);
  }
  return null;
}

/**
 * 透過 Notion search API 搜尋
 */
function notionSearchByQuery_(query) {
  try {
    var payload = {
      query: query,
      filter: { value: 'page', property: 'object' },
      page_size: 5
    };
    var res = notionFetch_(
      'https://api.notion.com/v1/search',
      { method: 'post', payload: JSON.stringify(payload) }
    );
    if (res && res.results && res.results.length > 0) return res.results[0];
  } catch (e) {
    Logger.log('[notionSearchByQuery] ' + e);
  }
  return null;
}

/**
 * 取得 Notion 頁面完整 blocks 內容，轉純文字
 */
function fetchNotionPageContent_(pageId) {
  if (!pageId) return '';
  try {
    var res = notionFetch_(
      'https://api.notion.com/v1/blocks/' + pageId + '/children?page_size=100',
      { method: 'get' }
    );
    if (!res || !res.results) return '';
    return res.results.map(extractBlockText_).filter(Boolean).join('\n');
  } catch (e) {
    Logger.log('[fetchNotionContent] ' + e);
    return '';
  }
}

/**
 * 從 Notion block 提取純文字
 */
function extractBlockText_(block) {
  var type = block.type;
  if (!block[type]) return '';
  var rts = block[type].rich_text || [];
  var text = rts.map(function(rt) { return rt.plain_text || ''; }).join('');
  if (!text) return '';
  var prefix = { heading_1: '# ', heading_2: '## ', heading_3: '### ',
    bulleted_list_item: '• ', numbered_list_item: '• ',
    to_do: (block[type].checked ? '✓ ' : '□ ') };
  return (prefix[type] || '') + text;
}

/**
 * 建立 Notion 子頁面（開庭準備）掛在案件頁下
 * 內容超過 95 blocks 時分批 append
 */
function createNotionPrepPage_(parentPageId, title, content, caseInfo) {
  try {
    var allBlocks = buildNotionBlocks_(content, caseInfo);
    var firstBatch = allBlocks.slice(0, 95);

    var payload = {
      parent: { page_id: parentPageId },
      properties: {
        title: { title: [{ type: 'text', text: { content: title } }] }
      },
      children: firstBatch
    };

    var res = notionFetch_(
      'https://api.notion.com/v1/pages',
      { method: 'post', payload: JSON.stringify(payload) }
    );

    if (!res || !res.id) {
      Logger.log('[createPrepPage] 建立失敗');
      return '';
    }

    var newPageId = res.id;

    // 分批 append 剩餘 blocks
    if (allBlocks.length > 95) {
      for (var offset = 95; offset < allBlocks.length; offset += 95) {
        var batch = allBlocks.slice(offset, offset + 95);
        notionFetch_(
          'https://api.notion.com/v1/blocks/' + newPageId + '/children',
          { method: 'patch', payload: JSON.stringify({ children: batch }) }
        );
      }
    }

    var url = res.url || ('https://www.notion.so/' + newPageId.replace(/-/g, ''));
    Logger.log('[createPrepPage] 已建立：' + url);
    return url;
  } catch (e) {
    Logger.log('[createPrepPage] 例外：' + e);
    return '';
  }
}

/**
 * 將文字 content 轉換為 Notion blocks 陣列
 */
function buildNotionBlocks_(content, caseInfo) {
  var blocks = [];

  // 頂部 callout：庭期快覽
  var calloutText = '⚖️ ' + caseInfo.hearingType + '｜' + caseInfo.date + ' ' + caseInfo.time;
  if (caseInfo.location) calloutText += '｜' + caseInfo.location;
  if (caseInfo.judge) calloutText += '｜' + caseInfo.judge;
  else if (caseInfo.division) calloutText += '｜' + caseInfo.division;
  blocks.push({
    object: 'block', type: 'callout',
    callout: {
      rich_text: [{ type: 'text', text: { content: calloutText } }],
      icon: { type: 'emoji', emoji: '📋' },
      color: 'blue_background'
    }
  });

  blocks.push({ object: 'block', type: 'divider', divider: {} });

  // 將 Claude 輸出逐行轉 blocks（每行最多 2000 字元）
  var lines = content.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim()) {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } });
    } else if (/^# /.test(line)) {
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: [mkText_(line.slice(2))] } });
    } else if (/^## /.test(line)) {
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [mkText_(line.slice(3))] } });
    } else if (/^### /.test(line)) {
      blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: [mkText_(line.slice(4))] } });
    } else if (/^[•\-] /.test(line)) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [mkText_(line.slice(2))] } });
    } else {
      // 切割超長行
      var segments = splitLongLine_(line, 2000);
      for (var s = 0; s < segments.length; s++) {
        blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [mkText_(segments[s])] } });
      }
    }
  }
  return blocks;
}

function mkText_(s) {
  return { type: 'text', text: { content: s.substring(0, 2000) } };
}

function splitLongLine_(line, maxLen) {
  var result = [];
  for (var i = 0; i < line.length; i += maxLen) {
    result.push(line.substring(i, i + maxLen));
  }
  return result.length > 0 ? result : [''];
}

/**
 * Notion API fetch 包裝（含重試 3 次，429 時等待）
 */
function notionFetch_(url, options, retries) {
  retries = retries || 3;
  var opts = {
    method: options.method || 'get',
    headers: {
      'Authorization': 'Bearer ' + CONFIG.NOTION_API_KEY,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    muteHttpExceptions: true
  };
  if (options.payload) opts.payload = options.payload;

  for (var attempt = 1; attempt <= retries; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, opts);
      var code = response.getResponseCode();
      if (code === 200 || code === 201) return JSON.parse(response.getContentText());
      if (code === 429) {
        Utilities.sleep(2000 * attempt);
        continue;
      }
      Logger.log('[notionFetch] HTTP ' + code + '：' + response.getContentText().substring(0, 200));
      if (attempt < retries) Utilities.sleep(1000 * attempt);
    } catch (e) {
      Logger.log('[notionFetch] 例外 attempt ' + attempt + '：' + e);
      if (attempt < retries) Utilities.sleep(1000 * attempt);
    }
  }
  return null;
}

// ======================== Claude API ========================

/**
 * 呼叫 Claude API 生成開庭準備文件（重試 2 次）
 */
function generateCourtPrep_(caseType, caseInfo, notionContent, judgeStats) {
  var ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!ANTHROPIC_API_KEY) {
    Logger.log('[claude] 未設定 ANTHROPIC_API_KEY');
    return null;
  }

  var prompt = buildCourtPrepPrompt_(caseType, caseInfo, notionContent, judgeStats);
  var payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: '你是一位台灣律師的法律助理，專精台灣法院實務與訴訟程序。請以繁體中文、簡潔可直接使用的格式生成開庭準備文件。避免廢話，著重實際可操作的準備事項。',
    messages: [{ role: 'user', content: prompt }]
  };

  // 可重試的 HTTP 狀態碼（暫時性錯誤）
  var RETRYABLE_CODES = { 429: true, 500: true, 529: true };

  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
        method: 'post',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
        deadline: 60
      });
      var code = response.getResponseCode();
      var body = response.getContentText();
      if (code === 200) {
        var data = JSON.parse(body);
        if (data.content && data.content.length > 0) {
          return data.content[0].text;
        }
        Logger.log('[claude] 200 但 content 空：' + body.substring(0, 500));
        return null;
      }
      Logger.log('[claude] 錯誤 ' + code + '：' + body.substring(0, 500));
      // 不可重試的錯誤（認證/請求格式問題），直接返回
      if (!RETRYABLE_CODES[code]) return null;
      if (attempt < 2) Utilities.sleep(8000);
    } catch (e) {
      Logger.log('[claude] 例外 attempt ' + attempt + '：' + e.message);
      if (attempt < 2) Utilities.sleep(8000);
    }
  }
  return null;
}

/**
 * 最小化 Claude API 測試（clasp run 用）
 * 驗證 API Key 和連線是否正常
 */
function testClaudeApiMinimal_() {
  var ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!ANTHROPIC_API_KEY) {
    Logger.log('[test] 未設定 ANTHROPIC_API_KEY');
    return;
  }
  Logger.log('[test] API Key 長度：' + ANTHROPIC_API_KEY.length + '，前5碼：' + ANTHROPIC_API_KEY.substring(0, 5));
  var payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 50,
    messages: [{ role: 'user', content: 'say hi in Chinese' }]
  };
  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      deadline: 30
    });
    var code = response.getResponseCode();
    var body = response.getContentText();
    Logger.log('[test] HTTP ' + code);
    Logger.log('[test] body: ' + body.substring(0, 500));
    if (code === 200) {
      var data = JSON.parse(body);
      Logger.log('[test] 回覆：' + data.content[0].text);
    }
  } catch (e) {
    Logger.log('[test] 例外：' + e.message);
  }
}

/**
 * 依案件類型建構 Claude 開庭準備 Prompt
 * 通用六大模組 A-F 依類型調整重點
 */
/**
 * 依案件類型建構 Claude 開庭準備 Prompt
 * 六大通用模組 A-F（全類型必出）+ 四套模板專屬區塊
 */
function buildCourtPrepPrompt_(caseType, caseInfo, notionContent, judgeStats) {
  // ── 庭期資訊 ──
  var header = '## 庭期資訊\n'
    + '- 案件：' + (caseInfo.caseName || '（未知）') + '\n'
    + '- 案號：' + (caseInfo.caseNumber || '（未知）') + '\n'
    + '- 庭期：' + caseInfo.date + ' ' + caseInfo.time + '\n'
    + '- 地點：' + (caseInfo.location || '（未填）') + '\n'
    + '- 法官/承辦：' + (caseInfo.judge || caseInfo.division || '（未知）') + '\n'
    + '- 庭期類型：' + caseInfo.hearingType + '\n\n';

  // ── Notion 案件現況 ──
  var notionSection = notionContent && notionContent.trim()
    ? '## Notion 案件現況（請依此內容分析各模組）\n' + notionContent.substring(0, 2000) + '\n\n'
    : '（Notion 案件頁無可讀內容，請依案號與案件類型提供通用準備要點）\n\n';

  // ── 法官統計數據（從本機判決 DB 實時查詢） ──
  var judgeStatsSection = '';
  if (judgeStats) {
    var apiCaseType = { '刑偵': 'M', '刑審': 'M', '民事': 'V', '行政': 'A' }[caseType] || 'M';
    var statsBlock = _buildJudgeStatsBlock_(judgeStats, caseInfo.judge || '', apiCaseType);
    if (statsBlock) {
      judgeStatsSection = statsBlock + '\n\n';
    }
  }

  // ── 六大通用模組 A-F（依案件類型調整重點） ──
  var moduleAF = buildModulesAF_(caseType);

  // ── 四套模板專屬區塊 ──
  var typeBlock = buildTypeSpecificBlock_(caseType);

  return header + notionSection + judgeStatsSection
    + '請依下列格式生成開庭準備文件。每個模組都要輸出，資訊不足時標注「（資料不足，請補充）」而非跳過。\n\n'
    + moduleAF + '\n' + typeBlock;
}

/**
 * 六大通用模組 A-F，依案件類型調整各模組的具體重點
 */
function buildModulesAF_(caseType) {
  // 模組 A：人物關係（依類型調整視角）
  var moduleA_detail = {
    刑偵: '嫌疑人↔共犯↔被害人，標注「今日是否同時到場」「供述一致性風險」',
    刑審: '被告↔共同被告↔今日傳喚證人，標注「已認罪/否認」立場',
    民事: '原告↔被告↔訴訟代理人，標注「友軍/敵軍/中立」及授權範圍',
    行政: '原告↔處分機關↔參加人，標注「機關代理人層級」與決策權限'
  }[caseType] || '當事人、對造、法院相關人員，標注立場';

  // 模組 B：事實時間軸標注規則
  var moduleB_detail = {
    刑偵: '犯罪事實時間軸（🔴必提/🟡備用/⚪背景），標注「上次偵訊以來新增事項」',
    刑審: '程序進度+書狀往返時間軸，法官交辦未完成事項加 ⚠️',
    民事: '程序進度（起訴→答辯→準備程序→言詞辯論）+書狀往返，⚠️標注交辦未完成事項',
    行政: '行政程序時間軸（處分→訴願→行政訴訟）+ 救濟程序雙軸，⚠️標注法官交辦未完成事項'
  }[caseType] || '訴訟進度時間軸，標注重要節點';

  // 模組 C：主張 vs 證據比對角度
  var moduleC_detail = {
    刑偵: '被告說法 vs 客觀證據（偵查中已取得者）',
    刑審: '檢辯雙方主張對照表，✅/⚠️/❓/❌ 各爭點證據狀態',
    民事: '原告 vs 被告 vs 已提出證據三欄比對，❓標注尚待舉證事項',
    行政: '機關認定事實 vs 當事人主張 vs 客觀證據，❓標注需補充文件'
  }[caseType] || '主要爭點的主張與證據比對';

  // 模組 D：對造自承/不利陳述角度
  var moduleD_detail = {
    刑偵: '共犯供述中有利被告部分、證人陳述矛盾之處',
    刑審: '共犯/證人自承對被告有利的陳述，標注「是否已整理入辯護書狀」',
    民事: '對造書狀中的自認或承諾、前後矛盾之處',
    行政: '機關函文前後矛盾之處、訴願答辯中的讓步或承認'
  }[caseType] || '對造說過的有利於我方的話，標注攻防用途';

  // 模組 E：庭前確認清單（必問限 3 題）
  var moduleE_detail = {
    刑偵: '①說法一致性確認 ②共犯/被害人最新動態 ③有無新事證需提出',
    刑審: '①認罪或否認立場最終確認 ②今日傳喚證人關係 ③法官交辦事項完成度',
    民事: '①授權範圍（尤其調解底線）②新發生事實 ③對造有無釋出和解訊號',
    行政: '①機關內部立場有無變化 ②最新往來函文 ③有無新行政行為'
  }[caseType] || '①當事人最新狀況 ②新事實/新證據 ③法官交辦事項';

  // 模組 F：雷區
  var moduleF_detail = {
    刑偵: '🔴未知證據突然提示 🟡共犯翻供 🟡誘導性問題（避免陷阱）',
    刑審: '🔴法官突襲詰問（未準備的法律問題） 🟡共同被告律師立場衝突 🟢當庭播放影片',
    民事: '🔴法官詢問調解意願（暗示心證） 🟡對造當庭提出新文書 🟢法官突然指出訴訟標的問題',
    行政: '🔴法官質疑訴訟類型（如應走撤銷而非確認之訴） 🟡機關當庭改論點 🟢訴訟費用問題'
  }[caseType] || '🔴高機率雷區 🟡中機率 🟢低機率，各附具體處置話術';

  return '---\n\n'
    + '## A.【人物關係】\n'
    + moduleA_detail + '\n'
    + '格式：每人一行，「姓名／角色 → 今日狀態／立場」\n\n'

    + '## B.【事實與程序時間軸】\n'
    + moduleB_detail + '\n'
    + '格式：🔴必提 / 🟡備用 / ⚪背景，上次庭期以來新增事項請**粗體**標注\n\n'

    + '## C.【事實主張 vs 客觀證據比對】\n'
    + moduleC_detail + '\n'
    + '格式逐爭點：✅一致（證據支持我方）/ ⚠️矛盾（需解釋）/ ❓未驗證（無對應證據）/ ❌不利（證據支持對造）\n\n'

    + '## D.【對造自承／不利陳述追蹤】\n'
    + moduleD_detail + '\n'
    + '格式：每條「陳述摘要 → 攻防用途 → 本次庭期是否使用（是/否/備用）」\n\n'

    + '## E.【庭前快速確認清單】\n'
    + '必問限 3 題：' + moduleE_detail + '\n'
    + '格式：①②③ 各一行，具體問法\n\n'

    + '## F.【雷區提示】\n'
    + moduleF_detail + '\n'
    + '每條標注機率（🔴高/🟡中/🟢低）+ 具體處置話術（一句話）\n\n';
}

/**
 * 四套模板各自的專屬區塊
 * 法官傾向（本地 DB）：GAS 無法查本地 DB，標注「（需另查 judge_stats）」提醒律師
 */
function buildTypeSpecificBlock_(caseType) {
  var blocks = {
    刑偵: '---\n\n'
      + '## 【刑事偵查專屬】出庭核心策略\n'
      + '請依「看牌→護板→記錄」三步驟分析：\n'
      + '- 看牌：現階段推測偵查方向、檢察官手上可能有哪些證據\n'
      + '- 護板：當事人哪些話不能說、哪些細節易被利用\n'
      + '- 記錄：本次偵訊哪些陳述需要明確留紀錄（對日後審判有利）\n\n'
      + '## 【刑事偵查專屬】量刑備案評估\n'
      + '（請依上方【法官統計數據】的量刑分布與緩刑率，評估若移送審判後的量刑風險；若無統計數據則標注「（查無資料）」）\n'
      + '評估項目：起訴可能罪名、法定刑範圍、有利量刑因子、建議量刑目標區間',

    刑審: '---\n\n'
      + '## 【刑事審理專屬】法官傾向\n'
      + '（請依上方【法官統計數據】分析：緩刑率高低對策略的影響、均刑作為量刑錨點、是否值得積極爭取緩刑或改聚焦易科罰金門檻；若無統計數據則標注「（查無資料）」）\n\n'
      + '## 【刑事審理專屬】證據能力分析表\n'
      + '逐一列出本案關鍵證據：\n'
      + '| 證據 | 類型 | 能力爭議 | 處理建議 |\n'
      + '|------|------|----------|----------|\n'
      + '（依案件內容填入，資料不足時標注「待補」）\n\n'
      + '## 【刑事審理專屬】交互詰問準備\n'
      + '（依本次庭期類型：準備程序→爭點整理；調查程序→詰問問題清單；辯論程序→辯論要旨）\n\n'
      + '## 【刑事審理專屬】量刑分析（主力）\n'
      + '有利因子整理（自首、坦承、賠償、和解、初犯、品行、家庭狀況）\n'
      + '不利因子及應對說法\n'
      + '建議求刑區間（若 Notion 有類似判決資料，請據此分析）',

    民事: '---\n\n'
      + '## 【民事專屬】法官傾向\n'
      + '（請依上方【法官統計數據】分析：原告勝率、判賠比例，對本案攻防策略的具體影響；若無統計數據則標注「（查無資料）」）\n\n'
      + '## 【民事專屬】請求權基礎／訴訟標的\n'
      + '主位請求：（依案件填入）\n'
      + '備位請求：（如有）\n'
      + '訴訟標的法律關係確認：攻擊/防禦方法是否與訴訟標的一致\n\n'
      + '## 【民事專屬】舉證責任分配\n'
      + '| 爭點 | 舉證責任在誰 | 我方現有證據 | 缺口 |\n'
      + '|------|-------------|-------------|------|\n'
      + '（依案件填入）\n\n'
      + '## 【民事專屬】庭上發言優先序\n'
      + '1. 最重要先講（法官注意力集中在開頭）\n'
      + '2. 次要論點\n'
      + '3. 備用（法官若詢問才提）\n'
      + '各項建議發言時間控制',

    行政: '---\n\n'
      + '## 【行政訴訟專屬】法官傾向\n'
      + '（請依上方【法官統計數據】分析：撤銷率高低、對本案論點取捨的策略影響；若無統計數據則標注「（查無資料）」）\n\n'
      + '## 【行政訴訟專屬】行政處分違法性六層架構\n'
      + '逐層檢查（有問題者標 ⚠️）：\n'
      + '① 主體適法性（有無裁量權限）\n'
      + '② 程序合法性（通知、陳述意見、理由說明）\n'
      + '③ 事實認定正確性（認定事實是否有證據支撐）\n'
      + '④ 法律適用正確性（適用法條是否正確）\n'
      + '⑤ 裁量瑕疵（有無逾越、濫用或怠惰裁量）\n'
      + '⑥ 結果比例性（處分輕重與違規情節是否相當）\n\n'
      + '## 【行政訴訟專屬】行政法原則攻防\n'
      + '（依本案選用相關原則，未涉及者標「不適用」）\n'
      + '- 比例原則：\n'
      + '- 信賴保護原則：\n'
      + '- 平等原則（不當差別對待）：\n'
      + '- 法律明確性原則：\n'
      + '- 正當程序原則：\n'
      + '- 禁止不當聯結原則：\n\n'
      + '## 【行政訴訟專屬】舉證責任分配（詳版）\n'
      + '行政訴訟舉證責任分配原則（§136行訴法→民訴§277準用）\n'
      + '本案各爭點舉證責任歸屬及現有證據評估'
  };

  return blocks[caseType] || blocks['刑審'];
}

// ======================== LINE 通知 ========================

/**
 * 開庭準備生成完成通知（含 Notion 連結）
 */
function notifyLineCourtPrepDone_(caseInfo, notionPageUrl, isChen) {
  var typeLabel = { 刑偵: '刑事偵查', 刑審: '刑事審理', 民事: '民事', 行政: '行政訴訟' };

  // 從 location 提取法院名稱（去掉地址、法庭編號等）
  var courtName = '';
  if (caseInfo.location) {
    var cm = caseInfo.location.match(/([^\s,，]+(?:地院|高院|地方法院|高等法院|行政法院|高等行政法院))/);
    courtName = cm ? cm[1] : caseInfo.location.split(/[,，\s]/)[0];
  }

  var msg = '📋 開庭準備已產出\n\n';
  msg += '案件：' + (caseInfo.caseName || caseInfo.caseNumber || '（未知）') + '\n';
  msg += '庭期：' + caseInfo.date + ' ' + caseInfo.time + '\n';
  msg += '法院：' + (courtName || '（未填）') + '\n';
  msg += '類型：' + (typeLabel[caseInfo.caseType] || caseInfo.caseType)
       + '｜' + caseInfo.hearingType + '\n';

  // 法官傾向摘要（從本機 DB 查詢，失敗時靜默略過）
  if (caseInfo.judge) {
    var apiCaseType = { '刑偵': 'M', '刑審': 'M', '民事': 'V', '行政': 'A' }[caseInfo.caseType] || 'M';
    var court = _courtCode_(caseInfo.location || '');
    var statsLine = _fetchInsightLine_(caseInfo.judge, court, apiCaseType);
    if (statsLine) {
      msg += '📊 ' + caseInfo.judge + '｜' + statsLine + '\n';
    }
  }

  if (notionPageUrl) {
    msg += '\n👉 ' + notionPageUrl + '\n';
  } else {
    msg += '\n⚠️ Notion 頁面建立失敗（找不到案件頁），請手動處理\n';
  }

  msg += '\n⚠️ 自動產出，開庭前請覆核';

  var msgs = [{ type: 'text', text: msg }];
  sendAutoCourtPrepLine_(CONFIG.LINE_USER_ID, msgs);

  if (isChen) {
    var chenId = PropertiesService.getScriptProperties().getProperty('CHEN_LINE_USER_ID');
    if (chenId) sendAutoCourtPrepLine_(chenId, msgs);
  }
}

/**
 * 生成失敗 LINE 通知
 */
function notifyLinePrepError_(eventTitle, errorMsg) {
  var msg = '⚠️ 開庭準備生成失敗\n'
    + '事件：' + eventTitle + '\n'
    + '錯誤：' + (errorMsg || '').substring(0, 150) + '\n'
    + '→ 請手動準備或重新觸發';
  sendAutoCourtPrepLine_(CONFIG.LINE_USER_ID, [{ type: 'text', text: msg }]);
}

/**
 * 今天開庭提醒 LINE 推播
 */
function sendTodayCourtReminderLine_(events, today) {
  var todayStr = Utilities.formatDate(today, 'Asia/Taipei', 'MM/dd(EEE)');
  var msg = '⚖️ 今日開庭提醒\n📅 ' + todayStr + '\n━━━━━━━━━━━━━\n';

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var timeStr = Utilities.formatDate(ev.getStartTime(), 'Asia/Taipei', 'HH:mm');
    var loc = ev.getLocation() || '';
    msg += '\n📌 ' + ev.getTitle() + '\n🕐 ' + timeStr;
    if (loc) msg += '｜' + loc.substring(0, 25);
    msg += '\n';
  }

  sendAutoCourtPrepLine_(CONFIG.LINE_USER_ID, [{ type: 'text', text: msg }]);
}

/**
 * LINE push message 底層工具函式
 */
function sendAutoCourtPrepLine_(userId, messages) {
  if (!userId || !messages || messages.length === 0) return;
  try {
    var response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.LINE_CHANNEL_ACCESS_TOKEN
      },
      payload: JSON.stringify({ to: userId, messages: messages }),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code !== 200) {
      Logger.log('[LINE] 推播失敗 ' + code + '：' + response.getContentText().substring(0, 200));
    }
  } catch (e) {
    Logger.log('[LINE] 推播例外：' + e);
  }
}

/**
 * 設定 Script Property（clasp run setScriptProp --params '["KEY","VALUE"]' 用）
 */
function setScriptProp(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
  return 'SET ' + key + ' (length=' + value.length + ')';
}

/**
 * 完整流程測試：模擬刑審案件，呼叫 generateCourtPrep_，回傳結果長度
 */
function testGenerateCourtPrep() {
  var start = Date.now();
  var caseInfo = {
    caseName: '測試案件',
    caseNumber: '115審金訴818',
    caseType: '刑審',
    judge: '測試法官',
    division: '測試股',
    hearingType: '準備程序',
    date: '2026-04-11',
    time: '09:30',
    location: '台灣台中地方法院'
  };
  var result = generateCourtPrep_('刑審', caseInfo, '案件進度：第一次準備程序，被告否認犯行，辯護人尚未閱卷完畢。');
  var elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!result) return 'FAIL: generateCourtPrep_ 回傳 null（' + elapsed + 's）';
  return 'OK: ' + result.length + ' chars，耗時 ' + elapsed + 's，開頭：' + result.substring(0, 80);
}

/**
 * 公開包裝：clasp run testClaudeApi 測試 API 連線
 * 回傳字串供 clasp run 顯示
 */
function testClaudeApi() {
  var ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!ANTHROPIC_API_KEY) return 'FAIL: 未設定 ANTHROPIC_API_KEY';
  var keyInfo = 'Key 長度=' + ANTHROPIC_API_KEY.length + ' 前5碼=' + ANTHROPIC_API_KEY.substring(0, 5);
  var payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 50,
    messages: [{ role: 'user', content: '用一句中文打招呼' }]
  };
  try {
    var response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      deadline: 30
    });
    var code = response.getResponseCode();
    var body = response.getContentText();
    if (code === 200) {
      var data = JSON.parse(body);
      return 'OK [' + keyInfo + '] 回覆：' + data.content[0].text;
    }
    return 'FAIL HTTP ' + code + ' [' + keyInfo + '] body: ' + body.substring(0, 300);
  } catch (e) {
    return 'EXCEPTION [' + keyInfo + '] ' + e.message;
  }
}
