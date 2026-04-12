// notionHighlightSync.js v2.2
// v2.2：停用雙向同步，保留 stub 函式防止「Script function not found」錯誤
// 觸發器將由 sendMorningBriefing() 呼叫 removeHighlightSyncTriggers_() 自動清除

// ─────────────────────────────────────────
// 觸發器清理（一次性執行後這些函式就是空殼）
// ─────────────────────────────────────────
function removeHighlightSyncTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'syncNotionToGcal' || fn === 'syncGcalToNotion' || fn === 'syncNotionCompletedToHighlight') {
      ScriptApp.deleteTrigger(t);
      removed++;
      console.log('🗑 已刪除觸發器：' + fn);
    }
  });
  console.log('removeHighlightSyncTriggers_：共刪除 ' + removed + ' 個觸發器');
}

// ─────────────────────────────────────────
// 保留 stub 防止觸發器在刪除前觸發時報錯
// ─────────────────────────────────────────
function syncNotionToGcal() {
  console.log('syncNotionToGcal：此同步功能已停用');
}

function syncGcalToNotion() {
  console.log('syncGcalToNotion：此同步功能已停用');
}

function syncNotionCompletedToHighlight() {
  console.log('syncNotionCompletedToHighlight：此同步功能已停用');
}
