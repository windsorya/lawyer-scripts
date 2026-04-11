// billing-stats v1.0
// Gmail 帳單統計工具
// 功能：搜尋收據 Email → 提取金額 → 寫入 Google Sheet

// ===== 寄件者對照表 =====
var SENDER_MAP = {
  "anthropic": "from:invoice+statements@mail.anthropic.com",
  "apple":     "from:noreply@email.apple.com subject:receipt",
  "openai":    "from:noreply@tm.openai.com",
  "cursor":    "from:billing@cursor.sh",
  "github":    "from:noreply@github.com subject:receipt",
  "notion":    "from:notify@notion.so subject:invoice",
  "google":    "from:googleplay-noreply@google.com subject:receipt"
};

// ===== 函式 1：搜尋收據 Email =====
function searchBillingEmails(senderQuery, dateFrom, dateTo) {
  var query = senderQuery;

  if (dateFrom) {
    // 格式轉換：2026/01/01 → 2026/01/01（Gmail 支援 YYYY/MM/DD）
    query += " after:" + dateFrom.replace(/-/g, "/");
  }
  if (dateTo) {
    query += " before:" + dateTo.replace(/-/g, "/");
  }

  Logger.log("Gmail 搜尋條件: " + query);

  var threads = GmailApp.search(query, 0, 500);
  var messages = [];

  for (var i = 0; i < threads.length; i++) {
    var threadMessages = threads[i].getMessages();
    for (var j = 0; j < threadMessages.length; j++) {
      messages.push(threadMessages[j]);
    }
  }

  Logger.log("找到 " + messages.length + " 封郵件（" + threads.length + " 個對話串）");
  return messages;
}

// ===== 函式 2：提取金額 =====
function extractAmounts(messages) {
  var results = [];

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var body = msg.getPlainBody();
    var subject = msg.getSubject();
    var date = msg.getDate();

    var extracted = extractTotalFromEmail(body, subject);

    results.push({
      date:     Utilities.formatDate(date, "Asia/Taipei", "yyyy/MM/dd"),
      subject:  subject,
      amount:   extracted.amount,
      currency: extracted.currency,
      rawLine:  extracted.rawLine
    });
  }

  return results;
}

// ===== 內部輔助：從 Email 提取 Total 金額 =====
function extractTotalFromEmail(body, subject) {
  // 策略：優先找 Total / Amount due / Amount paid 後面的金額
  // 避免抓到 subtotal、tax 等中間金額

  var lines = body.split("\n");

  // 第一優先：找「Total」「Amount due」「Amount paid」「Charge」相關行
  var totalPatterns = [
    /^total[:\s]+/i,
    /amount\s+due[:\s]+/i,
    /amount\s+paid[:\s]+/i,
    /total\s+amount[:\s]+/i,
    /total\s+charge[:\s]+/i,
    /total\s+billed[:\s]+/i,
    /grand\s+total[:\s]+/i,
    /^charge[:\s]+/i,
    /您的帳單[：:]\s*/,
    /應付金額[：:]\s*/,
    /實收金額[：:]\s*/
  ];

  // USD / USD-like 金額格式
  var usdPattern = /\$\s*([\d,]+\.?\d{0,2})/;
  var usdWordPattern = /USD\s*([\d,]+\.?\d{0,2})/i;

  // TWD 金額格式
  var twdPattern1 = /NT\$\s*([\d,]+)/;
  var twdPattern2 = /TWD\s*([\d,]+\.?\d{0,2})/i;
  var twdPattern3 = /新台幣\s*([\d,]+)/;

  // 嘗試從「total」相關行提取
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    var isTotalLine = false;
    for (var p = 0; p < totalPatterns.length; p++) {
      if (totalPatterns[p].test(line)) {
        isTotalLine = true;
        break;
      }
    }

    if (!isTotalLine) continue;

    // 在當前行及後兩行尋找金額
    var searchLines = [line];
    if (i + 1 < lines.length) searchLines.push(lines[i+1].trim());
    if (i + 2 < lines.length) searchLines.push(lines[i+2].trim());

    for (var s = 0; s < searchLines.length; s++) {
      var sl = searchLines[s];

      var m;
      m = sl.match(usdPattern);
      if (m) return { amount: parseFloat(m[1].replace(/,/g, "")), currency: "USD", rawLine: sl };

      m = sl.match(usdWordPattern);
      if (m) return { amount: parseFloat(m[1].replace(/,/g, "")), currency: "USD", rawLine: sl };

      m = sl.match(twdPattern1);
      if (m) return { amount: parseFloat(m[1].replace(/,/g, "")), currency: "TWD", rawLine: sl };

      m = sl.match(twdPattern2);
      if (m) return { amount: parseFloat(m[1].replace(/,/g, "")), currency: "TWD", rawLine: sl };

      m = sl.match(twdPattern3);
      if (m) return { amount: parseFloat(m[1].replace(/,/g, "")), currency: "TWD", rawLine: sl };
    }
  }

  // 第二優先（fallback）：全文找最後一個金額（通常 total 在最後）
  var allAmounts = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    // 排除常見非 total 行（subtotal、tax、discount、promo）
    if (/subtotal|sub-total|tax|vat|gst|discount|promo|credit|refund/i.test(line)) continue;

    var m;
    m = line.match(usdPattern);
    if (m) allAmounts.push({ amount: parseFloat(m[1].replace(/,/g, "")), currency: "USD", rawLine: line });

    m = line.match(twdPattern1);
    if (m) allAmounts.push({ amount: parseFloat(m[1].replace(/,/g, "")), currency: "TWD", rawLine: line });
  }

  if (allAmounts.length > 0) {
    // 取最後一個金額（通常是 total）
    return allAmounts[allAmounts.length - 1];
  }

  return { amount: null, currency: null, rawLine: "(無法提取金額)" };
}

// ===== 函式 3：寫入 Google Sheet =====
function writeBillingReport(data, sheetName, searchQuery) {
  var ss;
  var spreadsheetName = sheetName || "帳單統計";

  // 搜尋是否已存在同名 Sheet
  var files = DriveApp.getFilesByName(spreadsheetName);
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
    Logger.log("使用既有試算表：" + spreadsheetName);
  } else {
    ss = SpreadsheetApp.create(spreadsheetName);
    Logger.log("建立新試算表：" + spreadsheetName);
  }

  // 在試算表裡建立以查詢條件命名的工作表
  var tabName = (searchQuery || "結果").substring(0, 30);
  var sheet = ss.getSheetByName(tabName);
  if (sheet) {
    sheet.clearContents();
  } else {
    sheet = ss.insertSheet(tabName);
  }

  // 寫入表頭
  var headers = ["日期", "主旨", "金額", "幣別", "備註（原始行）"];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");

  if (data.length === 0) {
    sheet.getRange(2, 1).setValue("（無資料）");
    return ss.getUrl();
  }

  // 分幣別統計
  var usdTotal = 0;
  var twdTotal = 0;
  var rows = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    rows.push([
      row.date,
      row.subject,
      row.amount !== null ? row.amount : "(無法提取)",
      row.currency || "-",
      row.rawLine || ""
    ]);
    if (row.currency === "USD" && row.amount) usdTotal += row.amount;
    if (row.currency === "TWD" && row.amount) twdTotal += row.amount;
  }

  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

  // 加總列
  var totalRow = data.length + 2;
  sheet.getRange(totalRow, 1).setValue("【加總】");
  sheet.getRange(totalRow, 1).setFontWeight("bold");

  if (usdTotal > 0) {
    sheet.getRange(totalRow, 2).setValue("USD 總計：$" + usdTotal.toFixed(2));
  }
  if (twdTotal > 0) {
    sheet.getRange(totalRow + 1, 2).setValue("TWD 總計：NT$" + twdTotal.toFixed(0));
  }
  if (usdTotal === 0 && twdTotal === 0) {
    sheet.getRange(totalRow, 2).setValue("（無有效金額）");
  }

  // 加總列背景色
  sheet.getRange(totalRow, 1, 1, headers.length).setBackground("#f3f3f3");

  // 自動調整欄寬
  sheet.autoResizeColumns(1, headers.length);

  var url = ss.getUrl();
  Logger.log("Sheet URL: " + url);
  return url;
}

// ===== 函式 4：主入口（預設 Anthropic，最近 90 天） =====
function runBillingStats() {
  var senderQuery = "from:invoice+statements@mail.anthropic.com";
  var dateFrom = getDateNDaysAgo(90);

  Logger.log("===== billing-stats 開始 =====");
  Logger.log("搜尋條件: " + senderQuery);
  Logger.log("起始日期: " + dateFrom);

  var messages = searchBillingEmails(senderQuery, dateFrom, null);

  if (messages.length === 0) {
    Logger.log("未找到符合的郵件");
    return;
  }

  var data = extractAmounts(messages);

  // 統計
  var usdTotal = 0;
  var failCount = 0;
  for (var i = 0; i < data.length; i++) {
    if (data[i].currency === "USD" && data[i].amount) {
      usdTotal += data[i].amount;
    } else {
      failCount++;
    }
  }

  var sheetUrl = writeBillingReport(data, "帳單統計", "Anthropic " + dateFrom + "~");

  var summary = {
    found: messages.length,
    extracted: messages.length - failCount,
    failed: failCount,
    usdTotal: usdTotal.toFixed(2),
    sheetUrl: sheetUrl
  };

  Logger.log("===== 結果摘要 =====");
  Logger.log(JSON.stringify(summary));
  Logger.log("===== 完成 =====");

  return summary;
}

// ===== 函式 5：自定義搜尋入口 =====
function runCustomBillingStats(sender, dateFrom, dateTo) {
  // sender 可以是預設對照表的 key，或直接的 Gmail query
  var senderQuery = SENDER_MAP[sender.toLowerCase()] || sender;

  // 預設時間範圍：最近 90 天
  if (!dateFrom) {
    dateFrom = getDateNDaysAgo(90);
  }

  Logger.log("===== billing-stats（自定義）開始 =====");
  Logger.log("sender 輸入: " + sender);
  Logger.log("解析為 query: " + senderQuery);
  Logger.log("日期範圍: " + dateFrom + " ~ " + (dateTo || "今天"));

  var messages = searchBillingEmails(senderQuery, dateFrom, dateTo || null);

  if (messages.length === 0) {
    Logger.log("未找到符合的郵件");
    return;
  }

  var data = extractAmounts(messages);

  var usdTotal = 0, twdTotal = 0, failCount = 0;
  for (var i = 0; i < data.length; i++) {
    if (data[i].currency === "USD" && data[i].amount) usdTotal += data[i].amount;
    if (data[i].currency === "TWD" && data[i].amount) twdTotal += data[i].amount;
    if (!data[i].amount) failCount++;
  }

  var tabName = sender + " " + dateFrom + "~" + (dateTo || "今");
  var sheetUrl = writeBillingReport(data, "帳單統計", tabName);

  Logger.log("===== 結果摘要 =====");
  Logger.log("找到郵件: " + messages.length + " 封");
  Logger.log("成功提取: " + (messages.length - failCount) + " 筆");
  Logger.log("提取失敗: " + failCount + " 筆");
  if (usdTotal > 0) Logger.log("USD 總計: $" + usdTotal.toFixed(2));
  if (twdTotal > 0) Logger.log("TWD 總計: NT$" + twdTotal.toFixed(0));
  Logger.log("Sheet URL: " + sheetUrl);
  Logger.log("===== 完成 =====");
}

// ===== 輔助：取得 N 天前的日期（格式 YYYY/MM/DD） =====
function getDateNDaysAgo(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return Utilities.formatDate(d, "Asia/Taipei", "yyyy/MM/dd");
}
