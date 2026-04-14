// post-hearing-debrief.js — 庭後待辦提醒 v1.0
// 在 sendMorningBriefing() 中由 setupPostHearingReminders() 統一呼叫

var PHR_CALENDAR_ID = '9d8oj0jqrd1lf60908ol444m68@group.calendar.google.com';
var PHR_KEY_PREFIX = 'PHR_';

/**
 * 清理已過期或已觸發的 firePostHearingReminder triggers。
 * 條件：trigger 函式名為 firePostHearingReminder，但 ScriptProperties 中已無對應的 key。
 */
function cleanupStalePHRTriggers_() {
  var props = PropertiesService.getScriptProperties();
  var triggers = ScriptApp.getProjectTriggers();
  var deleted = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'firePostHearingReminder') {
      var key = PHR_KEY_PREFIX + t.getUniqueId();
      if (!props.getProperty(key)) {
        ScriptApp.deleteTrigger(t);
        deleted++;
      }
    }
  });
  if (deleted > 0) console.log('cleanupStalePHRTriggers_: 清除 ' + deleted + ' 個過期 PHR trigger');
}

/**
 * 掃今天開庭行事曆，對每場 summary 含「開庭」的事件在 endTime+15min 建一次性 trigger。
 * 由 sendMorningBriefing() 呼叫。
 */
function setupPostHearingReminders() {
  cleanupStalePHRTriggers_();

  var cal = CalendarApp.getCalendarById(PHR_CALENDAR_ID);
  if (!cal) {
    console.error('setupPostHearingReminders: 找不到開庭行事曆 ' + PHR_CALENDAR_ID);
    return;
  }

  var now = new Date();
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  var todayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  var events = cal.getEvents(todayStart, todayEnd);

  var props = PropertiesService.getScriptProperties();
  var created = 0;
  var skipped = 0;

  events.forEach(function(ev) {
    var summary = ev.getTitle() || '';
    if (summary.indexOf('開庭') === -1) return;

    var fireAt = new Date(ev.getEndTime().getTime() + 15 * 60 * 1000);
    if (fireAt <= now) {
      skipped++;
      console.log('setupPostHearingReminders: 跳過已過時間的事件「' + summary + '」(fireAt=' + fireAt + ')');
      return;
    }

    var trigger = ScriptApp.newTrigger('firePostHearingReminder')
      .timeBased()
      .at(fireAt)
      .create();

    var key = PHR_KEY_PREFIX + trigger.getUniqueId();
    props.setProperty(key, summary);
    created++;
    console.log('setupPostHearingReminders: 已建 trigger「' + summary + '」→ ' + fireAt);
  });

  console.log('setupPostHearingReminders: 建立 ' + created + ' 個，跳過 ' + skipped + ' 個');
}

/**
 * 庭後 trigger 觸發時執行：推 LINE 提醒律師回報庭後待辦，然後清理自己。
 */
function firePostHearingReminder(e) {
  try {
    var triggerUid = e && e.triggerUid ? e.triggerUid : null;
    var props = PropertiesService.getScriptProperties();
    var eventSummary = triggerUid ? props.getProperty(PHR_KEY_PREFIX + triggerUid) : null;

    if (!eventSummary) {
      console.log('firePostHearingReminder: 無法取得 event summary（triggerUid=' + triggerUid + '），略過推播');
    } else {
      var text = '⚖️ ' + eventSummary + ' 結束了\n\n庭後待辦回報了嗎？\n👉 到 Claude 說「開完庭了」啟動 Debrief';
      sendLinePush_(buildTextMessages_(text));
      console.log('firePostHearingReminder: 已推播「' + eventSummary + '」');
    }

    // 清理 ScriptProperties key
    if (triggerUid) {
      props.deleteProperty(PHR_KEY_PREFIX + triggerUid);
    }

    // 刪除自己的 trigger
    var triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(function(t) {
      if (t.getUniqueId() === triggerUid) {
        ScriptApp.deleteTrigger(t);
      }
    });
  } catch (err) {
    console.error('firePostHearingReminder error: ' + err.message);
  }
}
