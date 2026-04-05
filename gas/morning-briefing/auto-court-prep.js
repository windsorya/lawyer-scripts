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
 * 07:00 觸發：今天開庭提醒
 */
function runTodayCourtReminder() {
  var today = new Date();
  var events = getCourtPrepEvents_(today);
  if (events.length === 0) {
    Logger.log('[todayReminder] 今天沒有庭期');
    return;
  }
  sendTodayCourtReminderLine_(events, today);
  Logger.log('[todayReminder] 已推播今日庭期提醒（' + events.length + ' 筆）');
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

  // 3. 呼叫 Claude 生成準備
  var prepContent = generateCourtPrep_(caseType, caseInfo, notionContent);
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
function generateCourtPrep_(caseType, caseInfo, notionContent) {
  var ANTHROPIC_API_KEY = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!ANTHROPIC_API_KEY) {
    Logger.log('[claude] 未設定 ANTHROPIC_API_KEY');
    return null;
  }

  var prompt = buildCourtPrepPrompt_(caseType, caseInfo, notionContent);
  var payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    system: '你是一位台灣律師的法律助理，專精台灣法院實務與訴訟程序。請以繁體中文、簡潔可直接使用的格式生成開庭準備文件。避免廢話，著重實際可操作的準備事項。',
    messages: [{ role: 'user', content: prompt }]
  };

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
        muteHttpExceptions: true
      });
      var code = response.getResponseCode();
      var data = JSON.parse(response.getContentText());
      if (code === 200 && data.content && data.content.length > 0) {
        return data.content[0].text;
      }
      Logger.log('[claude] 錯誤 ' + code + '：' + response.getContentText().substring(0, 300));
      if (attempt < 2) Utilities.sleep(4000);
    } catch (e) {
      Logger.log('[claude] 例外 attempt ' + attempt + '：' + e);
      if (attempt < 2) Utilities.sleep(4000);
    }
  }
  return null;
}

/**
 * 依案件類型建構 Claude 開庭準備 Prompt
 * 通用六大模組 A-F 依類型調整重點
 */
function buildCourtPrepPrompt_(caseType, caseInfo, notionContent) {
  var header = '## 庭期資訊\n'
    + '- 案件：' + (caseInfo.caseName || '（未知）') + '\n'
    + '- 案號：' + (caseInfo.caseNumber || '（未知）') + '\n'
    + '- 庭期：' + caseInfo.date + ' ' + caseInfo.time + '\n'
    + '- 地點：' + (caseInfo.location || '（未填）') + '\n'
    + '- 法官/承辦：' + (caseInfo.judge || caseInfo.division || '（未知）') + '\n'
    + '- 庭期類型：' + caseInfo.hearingType + '\n\n';

  var notionSection = '';
  if (notionContent && notionContent.trim()) {
    notionSection = '## Notion 案件現況（以下為案件頁內容，請據此分析）\n'
      + notionContent.substring(0, 3000) + '\n\n';
  } else {
    notionSection = '（Notion 案件頁無可讀內容，請依案號與案件類型提供通用準備要點）\n\n';
  }

  var templates = {
    刑偵: '請依以下六大模組為本件**刑事偵查**案件生成開庭準備文件：\n\n'
      + '## A.【案件現況確認】\n'
      + '偵查進度、目前已知事實、當事人立場摘要\n\n'
      + '## B.【本次傳訊重點】\n'
      + '推測本次傳訊目的、檢察官可能詢問方向\n\n'
      + '## C.【當事人到庭準備】\n'
      + '應攜帶文件、到庭注意事項（如偵查不公開規定）\n\n'
      + '## D.【預期偵訊問題與建議回應】\n'
      + '列出 3–5 個可能問題與建議應對方式（簡短具體）\n\n'
      + '## E.【辯護策略重點】\n'
      + '辯護切入點、需釐清疑點、可補充有利陳述\n\n'
      + '## F.【後續待辦】\n'
      + '庭後需完成事項、可能的聲請或書狀期限',

    刑審: '請依以下六大模組為本件**刑事審理**案件生成開庭準備文件：\n\n'
      + '## A.【案件現況確認】\n'
      + '審理進度、已解決事項、目前待解決爭點\n\n'
      + '## B.【本次庭期目標】\n'
      + '本次開庭要達成的目標、法官可能詢問方向\n\n'
      + '## C.【辯護論點與策略】\n'
      + '主要辯護論點、需強調重點、目前需補強之處\n\n'
      + '## D.【量刑有利條件整理】\n'
      + '自首、坦承、和解、賠償、初犯、品行等有利事實\n\n'
      + '## E.【預期法官問題與回應方向】\n'
      + '列出 3–5 個可能問題與建議回應方式\n\n'
      + '## F.【後續待辦】\n'
      + '庭後需完成事項、書狀期限、下次庭前準備方向',

    民事: '請依以下六大模組為本件**民事**案件生成開庭準備文件：\n\n'
      + '## A.【案件現況確認】\n'
      + '訴訟進度、主要爭點、已確認與待確認事項\n\n'
      + '## B.【本次庭期目標】\n'
      + '本次庭期預期程序（準備程序/言詞辯論/調解）與目標\n\n'
      + '## C.【攻防重點】\n'
      + '己方論點補強、對方可能主張及反駁策略\n\n'
      + '## D.【証據清單確認】\n'
      + '本次應提出或確認的証據、書証，需補充者\n\n'
      + '## E.【調解評估】\n'
      + '（如有調解可能）調解空間、底線、可接受條件分析\n\n'
      + '## F.【後續待辦】\n'
      + '庭後待辦、答辯書狀期限、下次庭前準備',

    行政: '請依以下六大模組為本件**行政訴訟**案件生成開庭準備文件：\n\n'
      + '## A.【案件現況確認】\n'
      + '訴訟進度、行政處分主要問題、已爭執事項\n\n'
      + '## B.【本次庭期目標】\n'
      + '本次庭期預期進行事項與目標\n\n'
      + '## C.【主要法律論點】\n'
      + '適用法規、違法性論點、比例原則、程序瑕疵等\n\n'
      + '## D.【事實論點補充】\n'
      + '重要事實確認、需補充的陳述或書証\n\n'
      + '## E.【預期法官問題與回應方向】\n'
      + '列出 3–5 個可能問題與建議回應方式\n\n'
      + '## F.【後續待辦】\n'
      + '庭後待辦、補充書狀期限'
  };

  var template = templates[caseType] || templates['刑審'];
  return header + notionSection + template;
}

// ======================== LINE 通知 ========================

/**
 * 開庭準備生成完成通知（含 Notion 連結）
 */
function notifyLineCourtPrepDone_(caseInfo, notionPageUrl, isChen) {
  var typeLabel = { 刑偵: '刑事偵查', 刑審: '刑事審理', 民事: '民事', 行政: '行政訴訟' };
  var label = typeLabel[caseInfo.caseType] || caseInfo.caseType;

  var msg = '📋 開庭準備已自動生成\n';
  msg += '━━━━━━━━━━━━━\n';
  msg += '📌 ' + (caseInfo.caseName || caseInfo.caseNumber || '（未知案件）') + '\n';
  msg += '⚖️ ' + label + '\n';
  msg += '📅 ' + caseInfo.date + ' ' + caseInfo.time;
  if (caseInfo.location) msg += '\n📍 ' + caseInfo.location;
  if (caseInfo.judge) msg += '\n👨‍⚖️ ' + caseInfo.judge;
  else if (caseInfo.division) msg += '\n👨‍⚖️ ' + caseInfo.division;
  if (notionPageUrl) msg += '\n\n📖 ' + notionPageUrl;
  else msg += '\n\n⚠️ Notion 頁面建立失敗（找不到案件頁），請手動處理';

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
