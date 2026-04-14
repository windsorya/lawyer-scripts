/**
 * post-hearing-debrief.js
 * 庭後待辦提醒系統 v1.0
 *
 * 每天晨報時掃當日開庭行事曆中 summary 含「開庭」的事件，
 * 在 endTime + 15 分鐘建立一次性 trigger，
 * 觸發時 LINE push 提醒律師到 Claude 回報庭後待辦。
 */

var PHR_CALENDAR_ID = '9d8oj0jqrd1lf60908ol444m68@group.calendar.google.com';
var PHR_PROP_PREFIX = 'PHR_';
var PHR_KEYWORD = '開庭';
var PHR_DELAY_MIN = 15;

function setupPostHearingReminders() {
  cleanupStalePHRTriggers_();
  var cal = CalendarApp.getCalendarById(PHR_CALENDAR_ID);
  if (!cal) { console.log('[PHR] 找不到開庭行事曆，跳過'); return; }

  var now = new Date();
  var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  var todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  var events = cal.getEvents(todayStart, todayEnd);

  var hearingEvents = events.filter(function(ev) {
    return ev.getTitle().indexOf(PHR_KEYWORD) !== -1;
  });

  if (hearingEvents.length === 0) {
    console.log('[PHR] 今日無開庭事件，不建 trigger');
    return;
  }

  var props = PropertiesService.getScriptProperties();
  var createdCount = 0;

  hearingEvents.forEach(function(ev) {
    var endTime = ev.getEndTime();
    var triggerTime = new Date(endTime.getTime() + PHR_DELAY_MIN * 60 * 1000);
    if (triggerTime <= now) {
      console.log('[PHR] 跳過已結束的事件: ' + ev.getTitle());
      return;
    }
    var trigger = ScriptApp.newTrigger('firePostHearingReminder')
      .timeBased()
      .at(triggerTime)
      .create();
    var propKey = PHR_PROP_PREFIX + trigger.getUniqueId();
    props.setProperty(propKey, ev.getTitle());
    createdCount++;
    console.log('[PHR] 建立 trigger: ' + ev.getTitle() + ' → ' +
      Utilities.formatDate(triggerTime, 'Asia/Taipei', 'HH:mm'));
  });

  console.log('[PHR] 共建立 ' + createdCount + ' 個庭後提醒 trigger');
}

function firePostHearingReminder(e) {
  try {
    var triggerUid = e && e.triggerUid ? e.triggerUid : '';
    var props = PropertiesService.getScriptProperties();
    var propKey = PHR_PROP_PREFIX + triggerUid;
    var eventSummary = props.getProperty(propKey) || '（庭期）';

    var msg = '⚖️ ' + eventSummary + ' 結束了\n\n' +
      '庭後待辦回報了嗎？\n' +
      '👉 到 Claude 說「開完庭了」啟動 Debrief';

    sendLinePush_(buildTextMessages_(msg));
    console.log('[PHR] 已推播庭後提醒: ' + eventSummary);

    props.deleteProperty(propKey);
    deleteTriggerByUid_(triggerUid);
  } catch (err) {
    console.error('[PHR] firePostHearingReminder 失敗: ' + err.message);
  }
}

function cleanupStalePHRTriggers_() {
  var props = PropertiesService.getScriptProperties();
  var allProps = props.getProperties();
  var triggers = ScriptApp.getProjectTriggers();
  var cleaned = 0;

  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'firePostHearingReminder') {
      var propKey = PHR_PROP_PREFIX + trigger.getUniqueId();
      if (!allProps[propKey]) {
        ScriptApp.deleteTrigger(trigger);
        cleaned++;
      }
    }
  });

  var activeTriggerIds = triggers
    .filter(function(t) { return t.getHandlerFunction() === 'firePostHearingReminder'; })
    .map(function(t) { return t.getUniqueId(); });

  Object.keys(allProps).forEach(function(key) {
    if (key.indexOf(PHR_PROP_PREFIX) === 0) {
      var uid = key.replace(PHR_PROP_PREFIX, '');
      if (activeTriggerIds.indexOf(uid) === -1) {
        props.deleteProperty(key);
        cleaned++;
      }
    }
  });

  if (cleaned > 0) {
    console.log('[PHR] 清理了 ' + cleaned + ' 個過期 trigger/property');
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
