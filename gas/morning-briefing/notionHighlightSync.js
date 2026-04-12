// notionHighlightSync.js
// 定時掃 Notion 工作待辦 DB，勾選完成 → GCal Highlight 事件改綠色

const HIGHLIGHT_NOTION_DB_ID_ = '6e2e22f21ca4824ab71f0757cca88f8c';
const HIGHLIGHT_GCAL_ID_ = 'a61f3iiaiejbd7t5tcqvpsab2k@group.calendar.google.com';
const HIGHLIGHT_SYNC_KEY_ = 'HIGHLIGHT_LAST_SYNC';

function syncNotionCompletedToHighlight() {
  const props = PropertiesService.getScriptProperties();
  const notionKey = props.getProperty('NOTION_API_KEY');
  if (!notionKey) { console.error('NOTION_API_KEY not set'); return; }

  // 上次同步時間（預設 10 分鐘前）
  const lastSyncStr = props.getProperty(HIGHLIGHT_SYNC_KEY_);
  const lastSync = lastSyncStr
    ? new Date(lastSyncStr)
    : new Date(Date.now() - 10 * 60 * 1000);
  const now = new Date();

  // 查 Notion：Checkbox=true 且 last_edited_time > lastSync
  const url = 'https://api.notion.com/v1/databases/' + HIGHLIGHT_NOTION_DB_ID_ + '/query';
  const payload = {
    filter: {
      and: [
        { property: 'Checkbox', checkbox: { equals: true } },
        { timestamp: 'last_edited_time',
          last_edited_time: { after: lastSync.toISOString() } }
      ]
    }
  };
  const res = UrlFetchApp.fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + notionKey,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  props.setProperty(HIGHLIGHT_SYNC_KEY_, now.toISOString());
  if (!data.results || data.results.length === 0) return;

  // 撈 GCal Highlight 行事曆近 14 天全日事件
  const cal = CalendarApp.getCalendarById(HIGHLIGHT_GCAL_ID_);
  if (!cal) { console.error('Highlight calendar not found'); return; }
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 昨天
  const end   = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const events = cal.getEvents(start, end);

  data.results.forEach(function(page) {
    const title = (page.properties.Title &&
      page.properties.Title.title &&
      page.properties.Title.title[0] &&
      page.properties.Title.title[0].plain_text) || '';
    if (!title) return;

    // 擷取案件關鍵詞：冒號或括號前的文字（最多前 10 字）
    const keyword = title.split(/[：:（(]/)[0].trim().substring(0, 10);
    if (!keyword) return;

    // 找 GCal 事件標題含此關鍵詞的
    const matched = events.filter(function(e) {
      return e.getTitle().indexOf(keyword) !== -1 &&
             e.getColor() !== CalendarApp.EventColor.SAGE;
    });
    matched.forEach(function(e) {
      try {
        e.setColor(CalendarApp.EventColor.SAGE);
        console.log('✅ 綠色: ' + e.getTitle());
      } catch(err) {
        console.error('setColor error: ' + err);
      }
    });
  });
}

function ensureHighlightSyncTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some(function(t) {
    return t.getHandlerFunction() === 'syncNotionCompletedToHighlight';
  });
  if (!exists) {
    ScriptApp.newTrigger('syncNotionCompletedToHighlight')
      .timeBased().everyMinutes(5).create();
    console.log('✅ Trigger created: every 5 min');
  } else {
    console.log('ℹ️ Trigger already exists');
  }
}
