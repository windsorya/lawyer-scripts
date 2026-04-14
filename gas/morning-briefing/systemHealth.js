// ===== 系統健康監控 =====

function getSystemHealth() {
  var props = PropertiesService.getScriptProperties();
  var results = {};

  // 1. ngrok / 本地判決DB
  try {
    var res = UrlFetchApp.fetch('https://aceofbase.ngrok.app/sse', {
      method: 'GET',
      muteHttpExceptions: true,
      followRedirects: false
    });
    var code = res.getResponseCode();
    // 200=正常, 406=server在但拒絕非SSE請求(視為正常), 其他=異常
    results.ngrok = (code === 200 || code === 406) ? '🟢 正常' : '🔴 斷線(' + code + ')';
  } catch(e) {
    results.ngrok = '🔴 無法連線';
  }

  // 2. Notion API
  try {
    var notionKey = props.getProperty('NOTION_API_KEY');
    var res2 = UrlFetchApp.fetch('https://api.notion.com/v1/users/me', {
      method: 'GET',
      muteHttpExceptions: true,
      headers: {
        'Authorization': 'Bearer ' + notionKey,
        'Notion-Version': '2022-06-28'
      }
    });
    results.notion = (res2.getResponseCode() === 200) ? '🟢 正常' : '🔴 異常(' + res2.getResponseCode() + ')';
  } catch(e) {
    results.notion = '🔴 無法連線';
  }

  // 3. Anthropic API（LINE Bot 依賴）
  try {
    var apiKey = props.getProperty('ANTHROPIC_API_KEY');
    var res3 = UrlFetchApp.fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      muteHttpExceptions: true,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    });
    results.anthropic = (res3.getResponseCode() === 200) ? '🟢 正常' : '🔴 異常(' + res3.getResponseCode() + ')';
  } catch(e) {
    results.anthropic = '🔴 無法連線';
  }

  // 4. 晨報上次成功時間
  var lastSuccess = props.getProperty('LAST_BRIEFING_SUCCESS') || '⚠️ 無記錄';
  results.lastBriefing = lastSuccess;

  // 5. LINE Bot 上次回應時間
  var lastLineBot = props.getProperty('LAST_LINEBOT_RESPONSE') || '⚠️ 無記錄';
  results.lineBot = lastLineBot;

  return results;
}

function buildHealthFlexMessage(health) {
  var hasIssue = [health.ngrok, health.notion, health.anthropic].some(function(v) { return v.includes('🔴'); });
  var statusIcon = hasIssue ? '🚨' : '✅';

  var lines = [
    statusIcon + ' 系統健康',
    '判決DB(ngrok)：' + health.ngrok,
    'Notion API：' + health.notion,
    'LINE Bot(Anthropic)：' + health.anthropic,
    '晨報上次成功：' + health.lastBriefing,
    'LINE Bot上次回應：' + health.lineBot
  ];

  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      contents: lines.map(function(line, i) {
        return {
          type: 'text',
          text: line,
          size: i === 0 ? 'sm' : 'xs',
          weight: i === 0 ? 'bold' : 'regular',
          color: i === 0 ? (hasIssue ? '#FF3B30' : '#34C759') : '#666666',
          wrap: true
        };
      })
    }
  };
}

function recordBriefingSuccess() {
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'MM/dd HH:mm');
  PropertiesService.getScriptProperties().setProperty('LAST_BRIEFING_SUCCESS', now);
}
