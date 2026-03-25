/**
 * 案件進度查詢 Web App
 * 版本：v1.2（Log 改為直接寫入 Notion）
 * 用途：當事人透過查詢碼查看案件進度
 * 技術：Google Apps Script + Notion API
 * 
 * 部署前請設定 Script Properties：
 * - NOTION_API_KEY：Notion Internal Integration Token
 * - NOTION_DB_ID：案件追蹤資料庫 ID
 * - NOTION_LOG_DB_ID：案件查詢 Log 資料庫 ID
 */

function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    NOTION_API_KEY: props.getProperty('NOTION_API_KEY'),
    NOTION_DB_ID: props.getProperty('NOTION_DB_ID') || 'YOUR_CASE_DB_ID',
    NOTION_LOG_DB_ID: props.getProperty('NOTION_LOG_DB_ID') || 'YOUR_LOG_DB_ID',
    NOTION_VERSION: '2022-06-28'
  };
}

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('王志文律師｜案件進度查詢系統')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function queryCaseByCode(queryCode) {
  if (!queryCode || queryCode.trim() === '') {
    return { success: false, error: '請輸入查詢碼' };
  }
  queryCode = queryCode.trim();
  if (!/^W\d{4}-\d{3}-[A-Za-z0-9]{3}$/.test(queryCode)) {
    return { success: false, error: '查詢碼格式不正確' };
  }
  try {
    const config = getConfig();
    if (!config.NOTION_API_KEY) {
      return { success: false, error: '系統設定錯誤，請聯繫律師事務所' };
    }
    const dbResult = queryNotionDB(config, queryCode);
    if (!dbResult || dbResult.results.length === 0) {
      writeLog(config, queryCode, '', '查無此案件', null);
      return { success: false, error: '查無此案件，請確認查詢碼是否正確' };
    }
    const page = dbResult.results[0];
    const props = page.properties;
    const caseData = {
      caseName: getTitle(props['案件簡稱']),
      caseNumber: getRichText(props['案號']),
      court: getSelect(props['法院']),
      stage: getSelect(props['目前階段']),
      status: getSelect(props['狀態']),
      nextHearing: getDate(props['下次庭期']),
      hearingType: getSelect(props['庭期類型']),
      lastUpdated: getDate(props['最後更新'])
    };
    const pageContent = fetchNotionPageContent(config, page.id);
    const visibleRecords = extractVisibleRecords(pageContent);
    writeLog(config, queryCode, caseData.caseName, '成功', page.id);
    return { success: true, caseData: caseData, records: visibleRecords };
  } catch (err) {
    Logger.log('queryCaseByCode error: ' + err.toString());
    try { writeLog(getConfig(), queryCode, '', '失敗', null); } catch(e) {}
    return { success: false, error: '系統暫時無法使用，請稍後再試' };
  }
}

function queryNotionDB(config, queryCode) {
  const url = 'https://api.notion.com/v1/databases/' + config.NOTION_DB_ID + '/query';
  const payload = { filter: { property: '查詢碼', rich_text: { equals: queryCode } }, page_size: 1 };
  const options = {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + config.NOTION_API_KEY, 'Notion-Version': config.NOTION_VERSION, 'Content-Type': 'application/json' },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) { throw new Error('Notion API error: ' + response.getResponseCode()); }
  return JSON.parse(response.getContentText());
}

function fetchNotionPageContent(config, pageId) {
  const url = 'https://api.notion.com/v1/blocks/' + pageId + '/children?page_size=100';
  const options = {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + config.NOTION_API_KEY, 'Notion-Version': config.NOTION_VERSION },
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) return [];
  return JSON.parse(response.getContentText()).results || [];
}

function getTitle(prop) { if (!prop || !prop.title || prop.title.length === 0) return ''; return prop.title.map(t => t.plain_text).join(''); }
function getRichText(prop) { if (!prop || !prop.rich_text || prop.rich_text.length === 0) return ''; return prop.rich_text.map(t => t.plain_text).join(''); }
function getSelect(prop) { if (!prop || !prop.select) return ''; return prop.select.name || ''; }
function getDate(prop) { if (!prop || !prop.date || !prop.date.start) return ''; return prop.date.start; }

function extractVisibleRecords(blocks) {
  const records = [];
  let capturing = false;
  for (const block of blocks) {
    if (block.type === 'heading_2') {
      const text = block.heading_2.rich_text.map(t => t.plain_text).join('');
      if (text === '當事人可見紀錄') { capturing = true; continue; }
      else if (capturing) { break; }
    }
    if (capturing && (block.type === 'heading_1' || block.type === 'heading_3')) { break; }
    if (capturing && block.type === 'bulleted_list_item') {
      const text = block.bulleted_list_item.rich_text.map(t => t.plain_text).join('');
      const parts = text.split('｜');
      if (parts.length >= 2) { records.push({ date: parts[0].trim(), event: parts.slice(1).join('｜').trim() }); }
      else { records.push({ date: '', event: text.trim() }); }
    }
  }
  return records;
}

function writeLog(config, queryCode, caseName, result, casePageId) {
  try {
    var logDbId = config.NOTION_LOG_DB_ID;
    if (!logDbId) return;
    var now = new Date();
    var timestamp = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss');
    var properties = {
      '查詢時間': { title: [{ text: { content: timestamp } }] },
      '查詢碼': { rich_text: [{ text: { content: queryCode } }] },
      '案件名稱': { rich_text: [{ text: { content: caseName || '' } }] },
      '結果': { select: { name: result } }
    };
    if (casePageId) { properties['關聯案件'] = { relation: [{ id: casePageId }] }; }
    var payload = { parent: { database_id: logDbId }, properties: properties };
    var options = {
      method: 'post',
      headers: { 'Authorization': 'Bearer ' + config.NOTION_API_KEY, 'Notion-Version': config.NOTION_VERSION, 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload), muteHttpExceptions: true
    };
    UrlFetchApp.fetch('https://api.notion.com/v1/pages', options);
  } catch (e) { Logger.log('writeLog error: ' + e.toString()); }
}

function setupNotionLog() {
  var config = getConfig();
  if (!config.NOTION_API_KEY) { Logger.log('❌ NOTION_API_KEY 未設定'); return; }
  if (!config.NOTION_LOG_DB_ID) { Logger.log('❌ NOTION_LOG_DB_ID 未設定'); return; }
  var url = 'https://api.notion.com/v1/databases/' + config.NOTION_LOG_DB_ID;
  var options = { method: 'get', headers: { 'Authorization': 'Bearer ' + config.NOTION_API_KEY, 'Notion-Version': config.NOTION_VERSION }, muteHttpExceptions: true };
  var response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() === 200) {
    var db = JSON.parse(response.getContentText());
    Logger.log('✅ Notion Log 資料庫連線成功：' + db.title.map(function(t) { return t.plain_text; }).join(''));
    writeLog(config, 'TEST-000-000', '系統測試', '成功', null);
    Logger.log('✅ 測試紀錄已寫入');
  } else { Logger.log('❌ 連線失敗（HTTP ' + response.getResponseCode() + '）'); }
}

function testQuery() { const result = queryCaseByCode('W2026-001-MIL'); Logger.log(JSON.stringify(result, null, 2)); }
