/**
 * post-hearing-debrief.js
 * 庭後待辦提醒系統 v2.0
 *
 * 每天晨報掃當日開庭行事曆 summary 含「開庭」的事件，
 * 每場建 4 個 trigger（endTime +15/+45/+75/+105 分鐘），
 * 直到律師點「✅ 已回報」連結 ack 才停止提醒。
 * 超過 2 小時（第 4 次）後自動停止。
 */

var PHR_CAL_ID = '9d8oj0jqrd1lf60908ol444m68@group.calendar.google.com';
var PHR_PREFIX = 'PHR_';
var PHR_ACK_PREFIX = 'PHR_ACK_';
var PHR_KEYWORD = '開庭';
var PHR_OFFSETS_MIN = [15, 45, 75, 105];

// ========== 晨報 hook ==========

function setupPostHearingReminders() {
  cleanupStalePHRTriggers_();

  var cal = CalendarApp.getCalendarById(PHR_CAL_ID);
  if (!cal) { console.log('[PHR] 找不到開庭行事曆'); return; }

  var now = new Date();
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  var todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  var events = cal.getEvents(todayStart, todayEnd);

  var hearings = events.filter(function(ev) {
    return ev.getTitle().indexOf(PHR_KEYWORD) !== -1;
  });

  if (hearings.length === 0) {
    console.log('[PHR] 今日無開庭事件');
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var totalCreated = 0;

  hearings.forEach(function(ev) {
    var endTime = ev.getEndTime().getTime();
    var eventKey = ev.getId().replace(/@.*/, '');  // 去除 @google.com 後綴
    var eventTitle = ev.getTitle();

    // 清除該事件的舊 ack（新的一天重新開始）
    props.deleteProperty(PHR_ACK_PREFIX + eventKey);

    PHR_OFFSETS_MIN.forEach(function(offsetMin, idx) {
      var triggerTime = new Date(endTime + offsetMin * 60 * 1000);
      if (triggerTime <= now) {
        console.log('[PHR] 跳過已過時間: ' + eventTitle + ' +' + offsetMin + 'min');
        return;
      }

      // 22:00 截止
      var cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22, 0, 0);
      if (triggerTime > cutoff) {
        console.log('[PHR] 超過 22:00 截止: ' + eventTitle + ' +' + offsetMin + 'min');
        return;
      }

      var trigger = ScriptApp.newTrigger('firePostHearingReminder')
        .timeBased()
        .at(triggerTime)
        .create();

      var propKey = PHR_PREFIX + trigger.getUniqueId();
      props.setProperty(propKey, JSON.stringify({
        title: eventTitle,
        key: eventKey,
        round: idx + 1,
        totalRounds: PHR_OFFSETS_MIN.length
      }));

      totalCreated++;
      console.log('[PHR] trigger: ' + eventTitle + ' → ' +
        Utilities.formatDate(triggerTime, 'Asia/Taipei', 'HH:mm') +
        ' (第' + (idx + 1) + '次)');
    });
  });

  console.log('[PHR] 共建立 ' + totalCreated + ' 個庭後提醒 trigger');
}

// ========== Trigger handler ==========

function firePostHearingReminder(e) {
  try {
    var triggerUid = e && e.triggerUid ? e.triggerUid : '';
    var props = PropertiesService.getScriptProperties();
    var propKey = PHR_PREFIX + triggerUid;
    var raw = props.getProperty(propKey);

    if (!raw) {
      console.log('[PHR] 找不到 trigger 資料，跳過');
      deleteTriggerByUid_(triggerUid);
      return;
    }

    var data = JSON.parse(raw);

    // 檢查是否已 ack
    if (props.getProperty(PHR_ACK_PREFIX + data.key)) {
      console.log('[PHR] 已回報，跳過: ' + data.title);
      props.deleteProperty(propKey);
      deleteTriggerByUid_(triggerUid);
      return;
    }

    // 組 LINE 訊息
    var ackUrl = getAckUrl_(data.key);
    var roundInfo = '(' + data.round + '/' + data.totalRounds + ')';
    var msg = '⚖️ ' + data.title + ' 結束了 ' + roundInfo + '\n\n' +
      '庭後待辦回報了嗎？\n' +
      '👉 到 Claude 說「開完庭了」啟動 Debrief\n\n' +
      '已回報？點此停止提醒 👇\n' + ackUrl;

    sendLinePush_(buildTextMessages_(msg));
    console.log('[PHR] 已推播: ' + data.title + ' ' + roundInfo);

    // 清理此 trigger
    props.deleteProperty(propKey);
    deleteTriggerByUid_(triggerUid);

  } catch (err) {
    console.error('[PHR] firePostHearingReminder 失敗: ' + err.message);
    // 仍嘗試清理
    try {
      if (triggerUid) deleteTriggerByUid_(triggerUid);
    } catch(e2) {}
  }
}

// ========== ACK web endpoint ==========

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  var key = e && e.parameter && e.parameter.key;

  if (action === 'phr_ack' && key) {
    PropertiesService.getScriptProperties().setProperty(PHR_ACK_PREFIX + key, '1');
    console.log('[PHR] ACK 收到: ' + key);

    // 清理該事件的所有剩餘 triggers
    cleanupTriggersForEvent_(key);

    return HtmlService.createHtmlOutput(
      '<html><body style="font-family:sans-serif;text-align:center;padding:40px;">' +
      '<h2>✅ 已收到回報確認</h2>' +
      '<p>後續提醒已取消。</p>' +
      '<p style="color:#888;margin-top:20px;">可以關閉此頁面</p>' +
      '</body></html>'
    );
  }

  // 非 PHR 請求，回傳空白
  return HtmlService.createHtmlOutput('OK');
}

// ========== Helper functions ==========

function getAckUrl_(eventKey) {
  var url = ScriptApp.getService().getUrl();
  return url + '?action=phr_ack&key=' + encodeURIComponent(eventKey);
}

function cleanupTriggersForEvent_(eventKey) {
  var props = PropertiesService.getScriptProperties();
  var allProps = props.getProperties();
  var cleaned = 0;

  Object.keys(allProps).forEach(function(k) {
    if (k.indexOf(PHR_PREFIX) !== 0 || k.indexOf(PHR_ACK_PREFIX) === 0) return;
    try {
      var data = JSON.parse(allProps[k]);
      if (data.key === eventKey) {
        var uid = k.replace(PHR_PREFIX, '');
        deleteTriggerByUid_(uid);
        props.deleteProperty(k);
        cleaned++;
      }
    } catch(e) {}
  });

  if (cleaned > 0) {
    console.log('[PHR] 清理事件 ' + eventKey + ' 的 ' + cleaned + ' 個剩餘 trigger');
  }
}

function cleanupStalePHRTriggers_() {
  var props = PropertiesService.getScriptProperties();
  var allProps = props.getProperties();
  var triggers = ScriptApp.getProjectTriggers();
  var cleaned = 0;

  // 刪除孤立 triggers（prop 不存在）
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'firePostHearingReminder') {
      var propKey = PHR_PREFIX + trigger.getUniqueId();
      if (!allProps[propKey]) {
        ScriptApp.deleteTrigger(trigger);
        cleaned++;
      }
    }
  });

  // 刪除孤立 properties（trigger 不存在）
  var activeUids = triggers
    .filter(function(t) { return t.getHandlerFunction() === 'firePostHearingReminder'; })
    .map(function(t) { return t.getUniqueId(); });

  Object.keys(allProps).forEach(function(k) {
    if (k.indexOf(PHR_PREFIX) === 0 && k.indexOf(PHR_ACK_PREFIX) !== 0) {
      var uid = k.replace(PHR_PREFIX, '');
      if (activeUids.indexOf(uid) === -1) {
        props.deleteProperty(k);
        cleaned++;
      }
    }
  });

  // 清理過期 ack flags（超過 1 天的）
  Object.keys(allProps).forEach(function(k) {
    if (k.indexOf(PHR_ACK_PREFIX) === 0) {
      // ack flags 每天晨報重建時會清，這裡額外清理殘留
      props.deleteProperty(k);
    }
  });

  if (cleaned > 0) {
    console.log('[PHR] 清理 ' + cleaned + ' 個過期項目');
  }
}

function deleteTriggerByUid_(uid) {
  if (!uid) return;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getUniqueId() === uid) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
