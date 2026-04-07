/**
 * sleep-knowledge-base — 睡眠知識庫 Notion 索引批次補正
 *
 * 功能：
 *   extractChapterNames(dryRun) — 從 Drive .md 檔提取中文章名
 *   updateNotionIndex()         — 批次更新 Notion，待補正 → 已索引
 *   tagChapters()               — 主題標籤填充（預留骨架，待實作）
 *
 * 使用前設定 Script Properties:
 *   NOTION_TOKEN  — Notion Integration Token
 */

// ─── 常數設定 ────────────────────────────────────────────────────────────────

const NOTION_DB_ID    = 'b1be855c33b3401b993a4a2458adb94e';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION  = '2022-06-28';

/** 需處理的 Drive 資料夾設定 */
const FOLDER_CONFIGS = [
  {
    id:          '1yb1mDGTtdAj8lQh6bpn6JkNGjijpa7VN',
    book:        '正念減壓自學全書',
    processAll:  true,
    targetFiles: null                               // null = 全部 .md
  },
  {
    id:          '1ryZ-1Rw1rfrpqgMjFIkQm92I79BAHVDh',
    book:        '精力管理',
    processAll:  true,
    targetFiles: null
  },
  {
    id:          '1xrwilqJoscyPPCTlxvnnOWGRnPYDggIt',
    book:        '正念療癒力',
    processAll:  false,
    targetFiles: ['01_Chapter_1.md', '02_Chapter_2.md', '52_Chapter_52.md']
  }
];

/** 版權/CIP 頁判斷 pattern — 符合此 pattern 的行跳過，不作為章名 */
const COPYRIGHT_RE = /ISBN|CIP數據|版权所有|著作權|Copyright\s*©|©\s*\d{4}|All\s+rights|定\s*[價价]|書\s*號|出版集團|印\s*[刷製]|發\s*行/i;

// ─── 主要入口 ──────────────────────────────────────────────────────────────

/**
 * 功能 1：從 Drive 資料夾讀取 .md，提取中文章名
 * @param {boolean} dryRun - true = 只 log，不寫入 Notion
 * @returns {Array<{fileId, fileName, book, extractedTitle, driveLink}>}
 */
function extractChapterNames(dryRun) {
  if (dryRun === undefined) dryRun = true;  // 預設安全模式

  const results = [];

  for (const cfg of FOLDER_CONFIGS) {
    Logger.log('=== 處理書籍：%s ===', cfg.book);
    const files = getMdFilesFromFolder(cfg.id, cfg.targetFiles);
    Logger.log('找到 %s 個目標 .md 檔案', files.length);

    for (const f of files) {
      try {
        const content = f.file.getBlob().getDataAsString('UTF-8');
        const title   = extractTitleFromContent(content);
        const entry   = {
          fileId:         f.fileId,
          fileName:       f.fileName,
          book:           cfg.book,
          extractedTitle: title || '⚠️ 無法提取',
          driveLink:      f.driveLink
        };
        results.push(entry);

        if (dryRun) {
          Logger.log('[dryRun] %s → "%s"', f.fileName, entry.extractedTitle);
        }
      } catch (e) {
        Logger.log('❌ 讀取失敗：%s — %s', f.fileName, e.message);
        results.push({
          fileId:         f.fileId,
          fileName:       f.fileName,
          book:           cfg.book,
          extractedTitle: '❌ 讀取失敗：' + e.message,
          driveLink:      f.driveLink
        });
      }
    }
  }

  Logger.log('\n===== 提取摘要 =====');
  Logger.log('總計：%s 筆', results.length);
  Logger.log('成功：%s 筆', results.filter(r => !r.extractedTitle.startsWith('⚠️') && !r.extractedTitle.startsWith('❌')).length);
  Logger.log('需人工確認：%s 筆', results.filter(r => r.extractedTitle.startsWith('⚠️') || r.extractedTitle.startsWith('❌')).length);

  if (dryRun) {
    Logger.log('\n[dryRun 模式] 未寫入 Notion。確認結果正確後，請執行 updateNotionIndex()。');
  }

  return results;
}

/**
 * 功能 2：批次更新 Notion — 將「待補正」頁面的章節名補正並改為「已索引」
 */
function updateNotionIndex() {
  Logger.log('===== Notion 批次更新開始 =====');

  // Step 1: 提取所有 Drive 章名（非 dryRun）
  const extracted = extractChapterNames(false);
  const titleMap  = {};   // driveFileId → extractedTitle
  for (const e of extracted) {
    if (!e.extractedTitle.startsWith('⚠️') && !e.extractedTitle.startsWith('❌')) {
      titleMap[e.fileId] = e.extractedTitle;
    }
  }
  Logger.log('成功提取章名：%s 筆', Object.keys(titleMap).length);

  // Step 2: 查詢 Notion — 所有「待補正」頁面（自動翻頁）
  const pendingPages = queryNotionPending();
  Logger.log('Notion 待補正頁面：%s 筆', pendingPages.length);

  // Step 3: 批次更新
  let successCount = 0;
  let skipCount    = 0;
  let failCount    = 0;
  const failLog    = [];

  for (const page of pendingPages) {
    const driveFileId = getNotionTextProp(page, 'Drive檔案ID');

    if (!driveFileId) {
      Logger.log('⚠️ 跳過（無 Drive檔案ID）：%s', page.id);
      skipCount++;
      continue;
    }

    const newTitle = titleMap[driveFileId];
    if (!newTitle) {
      Logger.log('⚠️ 跳過（Drive檔案ID 在本次提取結果中找不到）：%s', driveFileId);
      skipCount++;
      continue;
    }

    try {
      updateNotionPage(page.id, newTitle);
      Logger.log('✅ 更新成功：%s → "%s"', driveFileId, newTitle);
      successCount++;
    } catch (e) {
      Logger.log('❌ 更新失敗：%s — %s', driveFileId, e.message);
      failCount++;
      failLog.push({ driveFileId, error: e.message });
    }

    Utilities.sleep(350);  // rate limit 保護
  }

  // Step 4: 結果摘要
  Logger.log('\n===== 更新結果 =====');
  Logger.log('成功：%s 筆', successCount);
  Logger.log('跳過：%s 筆', skipCount);
  Logger.log('失敗：%s 筆', failCount);
  if (failLog.length > 0) {
    Logger.log('失敗清單：');
    failLog.forEach(f => Logger.log('  - %s: %s', f.driveFileId, f.error));
  }
}

/**
 * 功能 3：主題標籤填充（預留骨架）
 * 未來邏輯：讀取 .md 全文 → Claude API 判斷主題標籤 → 寫入 Notion
 */
function tagChapters() {
  Logger.log('tagChapters() 骨架尚未實作。');
  Logger.log('預計流程：');
  Logger.log('  1. 提取 Drive .md 全文');
  Logger.log('  2. 呼叫 Claude API 判斷主題標籤');
  Logger.log('  3. 標籤選項：入睡困難/睡眠衛生/晝夜節律/NSDR/咖啡因/CBT-I/');
  Logger.log('              正念冥想/壓力管理/能量管理/運動恢復/情緒調節/');
  Logger.log('              疼痛與睡眠/飲食與睡眠/工作效率/深度休息/自我催眠');
  Logger.log('  4. PATCH Notion pages 的「主題標籤」multi_select 欄位');

  // TODO: 實作 Claude API 呼叫與 Notion multi_select 更新
}

// ─── 章名提取邏輯 ────────────────────────────────────────────────────────────

/**
 * 從 .md 文字內容提取最佳章節名稱
 * 策略：
 *   1. 跳過 YAML frontmatter (--- ... ---)
 *   2. 優先取 Markdown heading（H1~H4）
 *   3. 其次取第一行含 ≥2 個中文字且非版權/CIP 的行
 *   4. Fallback：第一個非空行
 */
function extractTitleFromContent(content) {
  const lines = content.split('\n');

  // 找到 frontmatter 結束位置
  let fmEnd       = -1;
  let dashCount   = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      dashCount++;
      if (dashCount === 2) { fmEnd = i; break; }
    }
  }
  const bodyLines = (fmEnd >= 0) ? lines.slice(fmEnd + 1) : lines;

  // ── 優先：Markdown heading H1～H4 ──
  for (const line of bodyLines) {
    const m = line.match(/^#{1,4}\s+(.+)/);
    if (m) {
      const t = m[1].trim();
      if (t.length > 0 && t.length <= 80) return t;
    }
  }

  // ── 次要：含中文字的非版權行 ──
  for (const line of bodyLines) {
    const t = line.trim();
    if (!t)          continue;
    if (t.length > 80) continue;
    if (COPYRIGHT_RE.test(t)) continue;

    const cjkCount = (t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    if (cjkCount >= 2) return t;
  }

  // ── Fallback：第一個非空行 ──
  for (const line of bodyLines) {
    const t = line.trim();
    if (t) return t;
  }

  return null;
}

// ─── Drive 工具函式 ──────────────────────────────────────────────────────────

/**
 * 取得指定資料夾中的 .md 檔案列表
 * @param {string} folderId
 * @param {string[]|null} targetNames - 指定檔名清單（null = 全部 .md）
 * @returns {Array<{fileId, fileName, driveLink, file}>}
 */
function getMdFilesFromFolder(folderId, targetNames) {
  const results = [];
  const targetSet = targetNames ? new Set(targetNames) : null;

  const folder = DriveApp.getFolderById(folderId);
  const iter   = folder.getFiles();

  while (iter.hasNext()) {
    const file = iter.next();
    const name = file.getName();

    if (!name.endsWith('.md')) continue;
    if (targetSet && !targetSet.has(name)) continue;

    results.push({
      fileId:    file.getId(),
      fileName:  name,
      driveLink: file.getUrl(),
      file:      file
    });
  }

  // 依檔名排序（確保順序一致）
  results.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return results;
}

// ─── Notion 工具函式 ─────────────────────────────────────────────────────────

/** 取得 Script Properties 中的 Notion Token */
function getNotionToken() {
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('Script Properties 中找不到 NOTION_TOKEN，請先設定。');
  return token;
}

/**
 * 呼叫 Notion API
 * @param {string} method  - HTTP method
 * @param {string} endpoint - API path（如 /databases/xxx/query）
 * @param {Object|null} payload
 * @returns {Object} 解析後的 JSON 回應
 */
function notionRequest(method, endpoint, payload) {
  const options = {
    method:           method,
    headers: {
      'Authorization':  'Bearer ' + getNotionToken(),
      'Notion-Version': NOTION_VERSION,
      'Content-Type':   'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload) options.payload = JSON.stringify(payload);

  const res  = UrlFetchApp.fetch(NOTION_API_BASE + endpoint, options);
  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText());

  if (code < 200 || code >= 300) {
    throw new Error('Notion API ' + code + ': ' + JSON.stringify(body));
  }
  return body;
}

/**
 * 查詢 Notion DB 中所有「待補正」頁面（自動翻頁）
 * @returns {Array} Notion page objects
 */
function queryNotionPending() {
  const pages   = [];
  let cursor    = null;
  let hasMore   = true;

  while (hasMore) {
    const body = {
      filter: {
        property: '處理狀態',
        select:   { equals: '待補正' }
      },
      page_size: 100
    };
    if (cursor) body.start_cursor = cursor;

    const res = notionRequest('POST', '/databases/' + NOTION_DB_ID + '/query', body);
    pages.push(...res.results);

    hasMore = res.has_more;
    cursor  = res.next_cursor;
  }

  return pages;
}

/**
 * 更新 Notion 頁面的章節名與處理狀態
 * @param {string} pageId
 * @param {string} newTitle
 */
function updateNotionPage(pageId, newTitle) {
  notionRequest('PATCH', '/pages/' + pageId, {
    properties: {
      '章節名': {
        title: [{ text: { content: newTitle } }]
      },
      '處理狀態': {
        select: { name: '已索引' }
      }
    }
  });
}

/**
 * 從 Notion page object 讀取 text 類型屬性值
 */
function getNotionTextProp(page, propName) {
  try {
    const prop = page.properties[propName];
    if (!prop) return null;
    if (prop.type === 'rich_text' && prop.rich_text.length > 0) {
      return prop.rich_text[0].plain_text;
    }
    if (prop.type === 'title' && prop.title.length > 0) {
      return prop.title[0].plain_text;
    }
  } catch (e) { /* ignore */ }
  return null;
}

// ─── Sheets UI（可選）────────────────────────────────────────────────────────

/** 建立選單（綁定到 Google Sheets 時自動顯示） */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🧠 睡眠知識庫')
    .addItem('dryRun：預覽提取結果', 'runDryRun')
    .addSeparator()
    .addItem('執行：更新 Notion 索引', 'updateNotionIndex')
    .addSeparator()
    .addItem('（預留）主題標籤填充', 'tagChapters')
    .addToUi();
}

/** 快捷入口：dryRun 模式 */
function runDryRun() {
  extractChapterNames(true);
  SpreadsheetApp.getUi().alert('dryRun 完成，請開啟 View → Logs 查看提取結果。');
}

// ────────────────────────────────────────────────────────────────────────────
// injectToNotion — 從 Drive .md 全文灌進 Notion 頁面
// ────────────────────────────────────────────────────────────────────────────

/**
 * 從 Drive 讀取 .md 全文，寫入對應的 Notion 頁面內容
 * @param {string} driveFileId - Drive .md 檔案 ID
 * @param {string} notionPageId - Notion 頁面 ID
 */
function injectOneToNotion(driveFileId, notionPageId) {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('NOTION_TOKEN not set in Script Properties');

  var file = DriveApp.getFileById(driveFileId);
  var content = file.getBlob().getDataAsString('UTF-8');
  var fileName = file.getName();
  Logger.log('Read: ' + fileName + ' (' + content.length + ' chars)');

  var blocks = splitToNotionBlocks(content);
  var url = 'https://api.notion.com/v1/blocks/' + notionPageId + '/children';

  for (var i = 0; i < blocks.length; i += 100) {
    var batch = blocks.slice(i, i + 100);
    var response = UrlFetchApp.fetch(url, {
      method: 'patch',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      payload: JSON.stringify({ children: batch }),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      Logger.log('ERROR batch ' + (Math.floor(i / 100) + 1) + ': ' +
        response.getResponseCode() + ' ' + response.getContentText().substring(0, 500));
      return false;
    }
    Logger.log('Batch ' + (Math.floor(i / 100) + 1) + ' OK (' + batch.length + ' blocks)');
    Utilities.sleep(350);
  }

  Logger.log('✅ Injected: ' + fileName + ' → Notion ' + notionPageId);
  return true;
}

/**
 * 將 markdown 文本分割成 Notion paragraph/heading blocks
 * 每段 < 1800 chars（Notion rich_text 單段上限 2000）
 */
function splitToNotionBlocks(markdown) {
  var lines = markdown.split('\n');
  var blocks = [];
  var buffer = '';

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (buffer.length + line.length + 1 > 1800 && buffer.length > 0) {
      blocks.push(makeTextBlock(buffer));
      buffer = '';
    }

    if (line.match(/^### /)) {
      if (buffer.length > 0) { blocks.push(makeTextBlock(buffer)); buffer = ''; }
      blocks.push({ type: 'heading_3', heading_3: { rich_text: [{ type: 'text', text: { content: line.replace(/^### /, '') } }] } });
    } else if (line.match(/^## /)) {
      if (buffer.length > 0) { blocks.push(makeTextBlock(buffer)); buffer = ''; }
      blocks.push({ type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: line.replace(/^## /, '') } }] } });
    } else if (line.match(/^# /)) {
      if (buffer.length > 0) { blocks.push(makeTextBlock(buffer)); buffer = ''; }
      blocks.push({ type: 'heading_1', heading_1: { rich_text: [{ type: 'text', text: { content: line.replace(/^# /, '') } }] } });
    } else if (line.trim() === '' && buffer.length > 0) {
      blocks.push(makeTextBlock(buffer));
      buffer = '';
    } else {
      buffer += (buffer.length > 0 ? '\n' : '') + line;
    }
  }
  if (buffer.length > 0) blocks.push(makeTextBlock(buffer));

  return blocks;
}

function makeTextBlock(text) {
  if (text.length > 2000) text = text.substring(0, 1997) + '...';
  return {
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] }
  };
}

/**
 * 測試：灌 3 筆到 Notion
 * Drive ID 對應到 Notion 頁面
 */
function injectTestThree() {
  var testCases = [
    { drive: '1iaVGfHYP_Wn-FGO1RG4-lu-ziQ0QmA5l', notion: '33be22f21ca4816f999dee0ae3a6b320' },
    { drive: '1O4oUjCO84D8TnW-U5QWQSQGNj7Vlyuzk', notion: '33be22f21ca481c79693ee2a77245666' },
    { drive: '1439JNZozJauyTiG8J8OerXO3qhv86DVH', notion: '33be22f21ca481268135f411f9838894' }
  ];

  for (var i = 0; i < testCases.length; i++) {
    var tc = testCases[i];
    Logger.log('--- Test ' + (i + 1) + '/3 ---');
    try {
      injectOneToNotion(tc.drive, tc.notion);
    } catch (e) {
      Logger.log('FAIL: ' + e.message);
    }
    Utilities.sleep(500);
  }
  Logger.log('=== Test complete ===');
}

/**
 * 灌全部 238 筆（從 Notion DB 查詢所有頁面的 Drive檔案ID）
 * 每頁讀 Drive .md → append blocks 到對應 Notion 頁面
 */
function injectAll() {
  var token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  var dbId = 'b1be855c33b3401b993a4a2458adb94e';
  var hasMore = true;
  var startCursor = null;
  var total = 0, success = 0, fail = 0;

  while (hasMore) {
    var body = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;

    var resp = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + dbId + '/query', {
      method: 'post',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    var data = JSON.parse(resp.getContentText());
    var pages = data.results || [];
    hasMore = data.has_more || false;
    startCursor = data.next_cursor || null;

    for (var i = 0; i < pages.length; i++) {
      var page = pages[i];
      var driveId = '';
      try {
        driveId = page.properties['Drive檔案ID'].rich_text[0].plain_text;
      } catch (e) { continue; }
      if (!driveId) continue;

      total++;
      try {
        injectOneToNotion(driveId, page.id);
        success++;
      } catch (e) {
        Logger.log('FAIL page ' + page.id + ': ' + e.message);
        fail++;
      }
      Utilities.sleep(400);
    }
  }

  Logger.log('=== INJECT ALL COMPLETE ===');
  Logger.log('Total: ' + total + ' | Success: ' + success + ' | Fail: ' + fail);
}
