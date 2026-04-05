// 諮詢追蹤自動提醒 v1.0
// 每日 08:30 掃描 Notion 諮詢追蹤 DB，下次追蹤日=今天的推播 LINE 提醒
// Trigger: Time-driven, daily, 08:30-09:00

/**
 * 諮詢追蹤提醒主函式
 * 查詢 Notion 諮詢追蹤 DB，找出今天需要追蹤的潛在委託人，推播 LINE 提醒
 */
function checkConsultationFollowups() {
  var today = new Date();
  var todayStr = Utilities.formatDate(today, 'Asia/Taipei', 'yyyy-MM-dd');

  var followups = queryConsultationFollowups_(todayStr);
  if (followups.length === 0) {
    Logger.log('今天（' + todayStr + '）沒有需要追蹤的諮詢');
    return;
  }

  var message = buildFollowupMessage_(followups, todayStr);
  sendFollowupLineMessage_(message);
  Logger.log('已推播 ' + followups.length + ' 筆諮詢追蹤提醒');
}

// ======================== Notion 查詢 ========================

/**
 * 查詢 Notion 諮詢追蹤 DB
 * 過濾條件：下次追蹤日 = 今天 AND 狀態 NOT IN (已委任, 未委任結案)
 */
function queryConsultationFollowups_(todayStr) {
  var results = [];
  var CONSULTATION_DB_ID = '7bbc6a828c1f42ef90a03b65a1ff6ba3';

  try {
    var payload = {
      filter: {
        and: [
          {
            property: '下次追蹤日',
            date: { equals: todayStr }
          },
          {
            property: '狀態',
            select: { does_not_equal: '已委任' }
          },
          {
            property: '狀態',
            select: { does_not_equal: '未委任結案' }
          }
        ]
      },
      page_size: 50
    };

    var response = UrlFetchApp.fetch(
      'https://api.notion.com/v1/databases/' + CONSULTATION_DB_ID + '/query',
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
      Logger.log('Notion 諮詢追蹤查詢錯誤：' + response.getContentText());
      return results;
    }

    var today = new Date();
    data.results.forEach(function(page) {
      var props = page.properties;

      // 諮詢者姓名（title）
      var name = '';
      if (props['諮詢者姓名'] && props['諮詢者姓名'].title && props['諮詢者姓名'].title.length > 0) {
        name = props['諮詢者姓名'].title.map(function(t) { return t.plain_text; }).join('');
      }

      // 案件類型（select）
      var caseType = '';
      if (props['案件類型'] && props['案件類型'].select && props['案件類型'].select.name) {
        caseType = props['案件類型'].select.name;
      }

      // 狀態（select）
      var status = '';
      if (props['狀態'] && props['狀態'].select && props['狀態'].select.name) {
        status = props['狀態'].select.name;
      }

      // 下一步（rich_text）
      var nextStep = '';
      if (props['下一步'] && props['下一步'].rich_text && props['下一步'].rich_text.length > 0) {
        nextStep = props['下一步'].rich_text.map(function(t) { return t.plain_text; }).join('').trim();
      }

      // 最後互動日（date）→ 計算距今天數
      var daysSinceLast = null;
      if (props['最後互動日'] && props['最後互動日'].date && props['最後互動日'].date.start) {
        var lastDate = new Date(props['最後互動日'].date.start);
        var diffMs = today.getTime() - lastDate.getTime();
        daysSinceLast = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      }

      // Notion 頁面連結
      var pageUrl = page.url || '';

      results.push({
        name: name,
        caseType: caseType,
        status: status,
        nextStep: nextStep,
        daysSinceLast: daysSinceLast,
        pageUrl: pageUrl
      });
    });

    Logger.log('查到 ' + results.length + ' 筆今日待追蹤諮詢');

  } catch (error) {
    Logger.log('Notion 諮詢追蹤查詢錯誤：' + error.message);
  }

  return results;
}

// ======================== 訊息組裝 ========================

/**
 * 組裝 LINE 推播訊息
 */
function buildFollowupMessage_(followups, todayStr) {
  var dateDisplay = todayStr.replace(/-/g, '/');
  var msg = '【諮詢追蹤提醒】' + dateDisplay + '\n';
  msg += '━━━━━━━━━━━━━\n';
  msg += '今天有 ' + followups.length + ' 位諮詢者需要追蹤\n\n';

  for (var i = 0; i < followups.length; i++) {
    var f = followups[i];
    msg += '📋 ' + (f.name || '（未填姓名）') + '\n';

    if (f.caseType) {
      msg += '案件類型：' + f.caseType + '\n';
    }
    if (f.status) {
      msg += '狀態：' + f.status + '\n';
    }
    if (f.nextStep) {
      msg += '下一步：' + f.nextStep + '\n';
    }
    if (f.daysSinceLast !== null) {
      msg += '距上次互動：' + f.daysSinceLast + ' 天\n';
    }
    if (f.pageUrl) {
      msg += f.pageUrl + '\n';
    }

    if (i < followups.length - 1) {
      msg += '─────────────\n';
    }
  }

  return msg;
}

// ======================== LINE 推播 ========================

/**
 * 推播單則 LINE 訊息
 */
function sendFollowupLineMessage_(text) {
  var payload = {
    to: CONFIG.LINE_USER_ID,
    messages: [{ type: 'text', text: text }]
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
      Logger.log('LINE 諮詢追蹤推播成功');
    }
  } catch (error) {
    Logger.log('LINE 推播錯誤：' + error.message);
  }
}
