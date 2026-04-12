// notionHighlightSync.js v2.0
// 雙向同步：Notion Checkbox ↔ GCal Highlight 綠色
// 防循環：每個方向先檢查目標狀態，已達成就 skip

const HL_NOTION_DB_ID_ = '6e2e22f21ca4824ab71f0757cca88f8c';
const HL_GCAL_ID_ = 'a61f3iiaiejbd7t5tcqvpsab2k@group.calendar.google.com';
const HL_NOTION_LAST_SYNC_KEY_ = 'HL_NOTION_LAST_SYNC';
const HL_GCAL_LAST_SYNC_KEY_  = 'HL_GCAL_LAST_SYNC';
const SAGE_COLOR_ = CalendarApp.EventColor.SAGE; // colorId=2

// ─────────────────────────────────────────
// 方向A：Notion Checkbox=true → GCal 改綠
// 防循環：GCal 已是綠色 → skip
// ─────────────────────────────────────────
function syncNotionToGcal() {
  var props = PropertiesService.getScriptProperties();
  var notionKey = props.getProperty('NOTION_API_KEY');
  if (!notionKey) { console.error('NOTION_API_KEY not set'); return; }

  var lastSyncStr = props.getProperty(HL_NOTION_LAST_SYNC_KEY_);
  var lastSync = lastSyncStr ? new Date(lastSyncStr) : new Date(Date.now() - 6 * 60 * 1000);
  var now = new Date();

  // 查 Notion：Checkbox=true 且 last_edited_time > lastSync
  var url = 'https://api.notion.com/v1/databases/' + HL_NOTION_DB_ID_ + '/query';
  var payload = {
    filter: {
      and: [
        { property: 'Checkbox', checkbox: { equals: true } },
        { timestamp: 'last_edited_time', last_edited_time: { after: lastSync.toISOString() } }
      ]
    }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + notionKey, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  props.setProperty(HL_NOTION_LAST_SYNC_KEY_, now.toISOString());
  var data = JSON.parse(res.getContentText());
  if (!data.results || data.results.length === 0) return;

  // 取 GCal 近 14 天事件
  var cal = CalendarApp.getCalendarById(HL_GCAL_ID_);
  if (!cal) { console.error('Highlight calendar not found'); return; }
  var events = cal.getEvents(new Date(now - 86400000), new Date(now.getTime() + 14 * 86400000));

  data.results.forEach(function(page) {
    var title = (page.properties.Title && page.properties.Title.title &&
      page.properties.Title.title[0] && page.properties.Title.title[0].plain_text) || '';
    if (!title) return;
    var keyword = title.split(/[：:（(]/)[0].trim().substring(0, 10);
    if (!keyword) return;

    events.filter(function(e) {
      return e.getTitle().indexOf(keyword) !== -1;
    }).forEach(function(e) {
      if (e.getColor() === SAGE_COLOR_) {
        console.log('⏭ 已是綠色，skip: ' + e.getTitle());
        return; // 防循環
      }
      try { e.setColor(SAGE_COLOR_); console.log('✅ 改綠: ' + e.getTitle()); }
      catch(err) { console.error('setColor error: ' + err); }
    });
  });
}

// ─────────────────────────────────────────
// 方向B：GCal 事件改綠 → Notion Checkbox 打勾
// 防循環：Notion 已是 true → skip
// ─────────────────────────────────────────
function syncGcalToNotion() {
  var props = PropertiesService.getScriptProperties();
  var notionKey = props.getProperty('NOTION_API_KEY');
  if (!notionKey) { console.error('NOTION_API_KEY not set'); return; }

  var cal = CalendarApp.getCalendarById(HL_GCAL_ID_);
  if (!cal) { console.error('Highlight calendar not found'); return; }

  var now = new Date();
  var events = cal.getEvents(new Date(now - 86400000), new Date(now.getTime() + 14 * 86400000));

  // 找綠色事件
  var greenEvents = events.filter(function(e) {
    return e.getColor() === SAGE_COLOR_;
  });
  if (greenEvents.length === 0) return;

  // 查 Notion 全部未完成的 Highlight 任務
  var url = 'https://api.notion.com/v1/databases/' + HL_NOTION_DB_ID_ + '/query';
  var payload = { filter: { property: 'Checkbox', checkbox: { equals: false } } };
  var res = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + notionKey, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var data = JSON.parse(res.getContentText());
  if (!data.results || data.results.length === 0) return;

  greenEvents.forEach(function(e) {
    var eTitle = e.getTitle();
    var keyword = eTitle.split(/[：:（(]/)[0].trim().substring(0, 10);
    if (!keyword) return;

    data.results.forEach(function(page) {
      var title = (page.properties.Title && page.properties.Title.title &&
        page.properties.Title.title[0] && page.properties.Title.title[0].plain_text) || '';
      if (title.indexOf(keyword) === -1) return;

      // Notion Checkbox 已是 true → skip（防循環）
      var checked = page.properties.Checkbox && page.properties.Checkbox.checkbox;
      if (checked) { console.log('⏭ Notion 已勾，skip: ' + title); return; }

      // 打勾
      var patchUrl = 'https://api.notion.com/v1/pages/' + page.id;
      UrlFetchApp.fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + notionKey, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
        payload: JSON.stringify({ properties: { Checkbox: { checkbox: true } } }),
        muteHttpExceptions: true
      });
      console.log('✅ Notion 打勾: ' + title);
    });
  });
}

// ─────────────────────────────────────────
// 觸發器安裝（每 5 分鐘）
// installHighlightTriggers：public wrapper，供 clasp run 呼叫
// ensureHighlightSyncTriggers_：供 sendMorningBriefing() 內部呼叫
// ─────────────────────────────────────────
function installHighlightTriggers() {
  ensureHighlightSyncTriggers_();
}

function ensureHighlightSyncTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  var hasNotion = triggers.some(function(t) { return t.getHandlerFunction() === 'syncNotionToGcal'; });
  var hasGcal   = triggers.some(function(t) { return t.getHandlerFunction() === 'syncGcalToNotion'; });
  if (!hasNotion) {
    ScriptApp.newTrigger('syncNotionToGcal').timeBased().everyMinutes(5).create();
    console.log('✅ Trigger created: syncNotionToGcal every 5 min');
  } else { console.log('ℹ️ syncNotionToGcal trigger already exists'); }
  if (!hasGcal) {
    ScriptApp.newTrigger('syncGcalToNotion').timeBased().everyMinutes(5).create();
    console.log('✅ Trigger created: syncGcalToNotion every 5 min');
  } else { console.log('ℹ️ syncGcalToNotion trigger already exists'); }
}

// 公開入口（clasp run 用）
function setupHighlightSync() {
  ensureHighlightSyncTriggers_();
}
