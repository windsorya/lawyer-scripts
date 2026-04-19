## 任務路由提醒
如果律師直接在終端機問你一個需要 Skills 方法論的任務（如撰寫書狀、案件策略分析、開庭準備、LINE 諮詢回覆等），請提醒律師：「這個任務需要 claude.ai 的 Skills 方法論，建議到 claude.ai 執行會更完整。」
CC 擅長的是：程式碼開發、GAS 修改、腳本執行、檔案批次處理、git 操作等純技術任務。

## 重要路徑
- 本地判決DB：/Users/william/JudicialData/judgments.db（221GB，1,322萬筆）
- JudicialData 資料夾：/Users/william/JudicialData/（含腳本、設定檔等共 57,223 個項目）

# lawyer-scripts 工作指引

## 自動備份規則

每次修改以下類型的檔案後，必須自動 git add + commit + push：
- .py 腳本（如 inject_page_refs.py）
- .sh 腳本
- CLAUDE.md 本身

commit message 格式：
- 新增：「add: 說明」
- 修改：「update: 說明」
- 偵測進化：「evolve: XXX案 X/Y → X/Y」

不需要問律師確認，修改完直接 push。

## 電子卷證前處理自動進化規則

每次跑完 inject_page_refs.py 並驗證通過後，必須自動執行：

1. 產出 _detection_report.json（記錄每卷自動偵測結果 vs 最終設定）
2. 如果有任何卷偵測失敗（自動偵測 ≠ 最終設定）：
   a. 分析失敗原因（封面假交替？背面雜訊高？連續誤判為隔頁？）
   b. 改進 inject_page_refs.py 的偵測邏輯
   c. 刪除該案的 _page_config.json，純靠自動偵測重跑
   d. 如果改進成功 → commit + push（message: "evolve: XXX案 X/Y → X/Y"）
   e. 如果改進後仍失敗 → 恢復 _page_config.json 作為回退，不要為了提高成功率而犧牲已正確的卷
3. 如果全部偵測成功 → 不需改進，直接完成

整個過程不問律師。

---
## 卷證筆錄摘取（Gemini 分批路線，v7）
- 大型掃描 PDF（>44MB）的筆錄摘取，優先用 gemini_pdf_extract.py
- 腳本位置：~/JudicialData/gemini_pdf_extract.py（244行，正式版）
- 舊版 gemini_batch_extract.py 在 ~/lawyer-scripts/（v1，已被 v6 取代）
- 技術限制：Gemini File API generateContent 每次約 46MB 隱性上限（70頁/46MB OK，80頁/56MB 失敗）
- 模型：gemini-2.5-flash（品質優於 pro，保留卷宗表頭，快一倍）
- 參數：MAX_BATCH_MB=23, OVERLAP_PAGES=2, max_workers=8, timeout=90s
- 中文檔名處理：操作前先 cp 到 /tmp/英文名.ext 再處理
- 產出格式：Google Doc（claude.ai 可用 readGoogleDoc 直接讀取）
- 呼叫方式（v7）：python3 ~/JudicialData/gemini_pdf_extract.py --drive-file-id <Drive file ID> --prompt-type 筆錄摘取 --case-folder-id <Drive folder ID> --doc-name "描述名"
---

## clasp (GAS 自動部署) — 2026-04-05 新增

### 晨報系統（@509ltqig，內部晨報）
- 路徑：~/lawyer-scripts/gas/morning-briefing/
- Script ID: 1MhSRWa4r5n2kGp6fTjSa7MGtkAenF7oBfatK4eRGSbzn8iodGNT0a4aX
- 檔案：程式碼.js（主檔 v2.30）、court-hearing-notify.js（v1.8）、daily-task-dispatch.js（陳律 v1.4）、business-card-reminder.js（v1.0）

### Linebot 自動回覆（@628xgdmn，對外 OA）
- 路徑：~/lawyer-scripts/gas/linebot/
- Script ID: 1Yz8IjQ6NULorCr4E-nbPK1AFrC_k_cAdLIi2yWXFrr1RLW-M8BVscuct
- Claude API 自動回覆 v2.2，含 BLOCKED_USER_IDS 黑名單

### 開庭出發提醒（court-departure v1.2）
- 路徑：~/lawyer-scripts/gas/court-departure/
- Script ID: 1EjRc50PcnyxRCsd-HyuL6qXdBsVnNIIWpVq8UVS2io-G0zAD7UziYj0w
- 功能：掃描開庭行事曆 → Routes API 計算車程（事務所+住家雙起點）→ Notion 待辦 + LINE 推播
- 觸發器：21:00 掃隔天、07:00 補漏當天、每月 1 日清理
- Script Properties：NOTION_API_KEY、MAPS_API_KEY、LINE_CHANNEL_ACCESS_TOKEN、LINE_USER_ID
- 注意：Maps 用 Routes API v2（非舊版 Directions API）；GAS Maps service 有 invalid_scope 問題，必須用 UrlFetchApp
- clasp run 對此專案不可用（未完成 Apps Script API 授權），修改只能 clasp push + GAS 編輯器手動執行

### 共用規則
- clasp 3.3.0 已安裝
- **修改流程**：clasp pull → 修改 → diff 確認 → clasp push → clasp pull 驗證 → git commit
- **安全規則**：push 前必須 diff；push 失敗從 git 恢復；每次 push 後自動 git commit

### CHANGELOG 寫入規則
每次完成以下任一事項後，必須在底部 CHANGELOG 段落新增一行：
- 新腳本部署或上線
- 現有腳本版本升級
- 新功能或新能力
- 設定變更（Script ID、參數、路徑）
- 重要 bug 修復

格式：`- YYYY-MM-DD 描述（✅已同步 2026-04-06）`
claude.ai 確認同步後會將 ⏳ 改為 ✅。

### 重大變更通知律師（強制）
完成重大變更後，除了寫 CHANGELOG，推 LINE 通知律師。
訊息格式：本文用中文詳述變更內容（律師看LINE就知道改了什麼），連結用英文短語（避免亂碼）：

```bash
cd ~/lawyer-scripts/gas/morning-briefing && clasp run sendLineMessage --params '["🔔 CC完成：[簡述]\n📋 變更內容：[具體改了什麼、影響什麼、律師需要知道什麼]\n\n👉 點此同步Claude：\nhttps://claude.ai/new?q=CC+changelog+sync"]'
```

範例：
```bash
clasp run sendLineMessage --params '["🔔 CC完成：clasp run 可遠端觸發 GAS\n📋 變更內容：修復三個問題（GCP綁定+scope重授權+setScriptProperty）。現在可以直接用 clasp run sendMorningBriefing 遠端觸發晨報推播，不需要再去 GAS 後台手動執行。\n\n👉 點此同步Claude：\nhttps://claude.ai/new?q=CC+changelog+sync"]'
```

律師看 LINE 就知道改了什麼 → 點連結 → claude.ai 自動讀 CHANGELOG 同步 Memory。

### CC prompt 複雜度控制
- CC 對複雜多步驟 prompt 不穩定，超過 3 個主要步驟必須拆成多次呼叫
- CC 報 failed 不代表全部失敗——先檢查哪些步驟已完成，從斷點繼續

### consultation-followup-notify v1.0（2026-04-05）
- 每日 08:00-09:00 掃描 Notion 諮詢追蹤 DB（7bbc6a828c1f42ef90a03b65a1ff6ba3）
- 過濾：下次追蹤日=今天 AND 狀態 NOT IN (已委任, 未委任結案)
- 推播 LINE：姓名、案件類型、狀態、下一步、距上次互動天數、Notion連結
- 觸發器自我安裝：ensureConsultationFollowupTrigger_() 由 sendMorningBriefing() 自動呼叫

### DevVault 定位（2026-04-05 重新定位）
- DevVault 是 CC 的本機筆記本（Obsidian），不同步到 Notion
- CC 自己讀 DevVault 就好，claude.ai 不需要知道 CC 的內部開發細節
- claude.ai 需要知道的只有「怎麼呼叫 CC」（版本、參數），這些在 CLAUDE.md 和 Notion 外接硬碟
- CLAUDE.md 是唯一橋樑：claude.ai 透過 CC 讀/寫 CLAUDE.md，CC 啟動時讀 CLAUDE.md
- 能力更新流程：CC 開發完成 → CC 寫 DevVault + 更新 CLAUDE.md → claude.ai 更新外接硬碟呼叫方式

### 已知 bug/限制
- daily_sync.py 有 bug（API URL 錯誤），下載用 pipeline_all.py
- pdfplumber 大量頁面極慢，用 PyMuPDF (fitz) 替代
- Google Drive FUSE 掛載不穩定（ls 就 deadlock），用 Drive API 操作
- Gemini 中文路徑：shutil.copy2 到 tempfile + display_name ASCII 化

---
## CHANGELOG（claude.ai 同步用）
claude.ai 涉及 CC 相關話題時，會讀取此段落確認有無未同步的更新。
CC 完成重大變更後在此新增一行，claude.ai 同步到外接硬碟後標記 ✅。

- 2026-04-05 clasp run 已可用：GCP綁定+scope重授權+setScriptProperty，可遠端觸發GAS函式（✅已同步）
- 2026-04-05 consultation-followup-notify v1.0 部署（✅已同步）
- 2026-04-05 clasp 安裝+login+clone（✅已同步）
- 2026-04-05 gemini_pdf_extract v7 --drive-file-id（✅已同步）
- 2026-04-05 auto-court-prep v1.1 部署（✅已同步 2026-04-06）
- 2026-04-06 晨報加錯誤通知：sendMorningBriefing 主體包 try-catch，失敗時 LINE 推播錯誤訊息（✅已同步）
- 2026-04-06 健康數據補發機制：getHealthStatus 回傳 isFallback 旗標；8:00 fallback 時自動建 09:00 一次性 trigger 呼叫 sendHealthSupplement()；有今日數據才補發，無數據靜默略過；trigger 執行後自動刪除自己（✅已同步 2026-04-06）
- 2026-04-06 假日模式 Highlight v2.31：週末/國定假日改推生活選項（大坑步道/閱讀/看劇等10項輪替）；補班日維持工作模式；標題切換【今日亮點】/【Highlight任務】（✅已同步 2026-04-06）
- 2026-04-07 sleep-knowledge-base GAS 部署：Script ID 1TtOcDQpixwJ5iqT5E7AqJRtIBWTVOUV9uR86u2vKde1QxWYMQQr_pI-T，含 extractChapterNames/updateNotionIndex/tagChapters 骨架（⏳待同步）
- 2026-04-07 LINE OA Bot v2.6 人工接管機制：律師個人LINE發 0/1/00/11 指令暫停/恢復自動回覆；律師其他訊息不再觸發 auto-reply（⏳待同步）
- 2026-04-07 晨報任務 Flex Carousel v2.33：行政待辦+Notion工作待辦改為互動卡片（✅完成/⏰+1延後/🗑刪除）；LINE輸入+任務名稱快速新增Notion待辦；訊息結構改為 text+carousel+bubble（⏳待同步）
- 2026-04-07 晨報修復 yd空值+睡眠延遲同步：getHealthStatus 同時讀 td+yd；sleepMissing 偵測；retryMorningBriefing 最多重試3次（⏳待同步）
- 2026-04-07 Highlight 過濾有固定時間行程：諮詢預約/行政行程只有全日行程才進 Highlight，有時間的不顯示（避免與晨報正文重複）（⏳待同步）
- 2026-04-07 睡眠知識庫全文灌入 Notion：inject_to_notion.py 將 236/238 筆 Drive .md 原文寫入對應 Notion 頁面（2筆Drive孤兒無法處理）；Claude 可透過 Notion MCP fetch 讀取原文（⏳待同步）
- 2026-04-08 晨報加入家庭儀式地雷掃描：getRitualReminders() 掃描 8 個家庭日期，🔴當天/🟡7天內/⚪其餘，leadDays 30天預警；插入晨報最前面（⏳待同步）
- 2026-04-08 量刑分析系統 GAS Web App v1.0 部署：Script ID 1igCTjiCgVS2aN6ZCs9Q8Eto1x-to75mV1salDUcSR2G5jjlVhi2uC_Eb；Deployment ID AKfycbzvEANMBuZ1UFBbrYlA95YTJgfQyx31JiQTtfbdVD8z38V8NHWwvA_yHuXD5zzU8Bdg0A；含法官傾向查詢（judge-stats）、FTS全文搜尋、量刑因子調整（減輕/加重事由），需設定 ngrok URL 連線本機 DB（⏳待同步）
- 2026-04-09 daily-task-dispatch v1.5 陳律特休攔截：sendDailyTaskDispatch() 前段加特休偵測，掃律師行事曆今日事件，有「陳律」+LEAVE_KEYWORDS → 跳過工作分配，改推「俊銘早，今天特休，好好休息！有急事再聯繫 😊」；王律師晨報不受影響（⏳待同步）
- 2026-04-10 auto-court-prep 修復 Claude API 未回傳內容：根本原因是 ANTHROPIC_API_KEY 未設定於 morning-briefing Script Properties（已補設）；同步修 max_tokens 8000→4096 + deadline 55→60 + Notion context 3500→2000 chars + 加強 error log + retry 邏輯分流（⏳待同步）
- 2026-04-11 MCP 健康監控 + 自動重啟：health-check.sh 每 30 分鐘巡邏 4 個 ngrok endpoint；LaunchAgent 常駐；失敗→launchctl kickstart -k 重啟，二次失敗寫 flag（⏳待同步）
- 2026-04-11 auto-court-prep 法官統計注入 Claude prompt v2.0：processCourtPrepEvent_ 查本機 DB → _buildJudgeStatsBlock_ 產緩刑率/均刑/量刑分布 → 注入 buildCourtPrepPrompt_；4 個佔位符改為「請依上方法官統計數據分析」；Claude 可依實際數據校準策略（如緩刑率7%→建議聚焦易科罰金門檻）（⏳待同步）
- 2026-04-12 假日 Highlight 候選 v2.32：取代舊版10項固定生活選項輪替，改從 5 個 Notion DB（📥Inbox/👨‍💼個人待辦/👨‍👩‍👧家庭雜務/♻️慣例.模版/😎Someday）撈真實未完成任務；排序：逾期>優先級>有日期優先（⏳待同步）
- 2026-04-12 notionHighlightSync 廢棄移除：嘗試 Notion 工作待辦↔GCal Highlight 雙向同步，因 TickTick Highlight 已 native 連 GCal 且無法同時連 Notion，架構根本不可行；已刪除檔案、清除觸發器（⏳待同步）
- 2026-04-12 晨報 v2.33 四問題修復：(1)重複觸發器清除機制（ensureMorningBriefingTrigger_ 自動刪多餘）；(2)移除 Gmail 通知呼叫（耗時過長）；(3)新增 testCourtEventsMonday/testHolidayNotionDBs 診斷函式；(4)假日 Highlight Notion 全失敗時 fallback 固定選項（⏳待同步）
- 2026-04-13 晨報 v2.34 自訂 Highlight：Flex Message 加「✏️ 自訂 Highlight」按鈕（postback），點後回「📝 請輸入你要加入 Highlight 的內容：」，下一則訊息自動建立 GCal 全日事件（同現有 Highlight 機制，10 分鐘超時失效）（⏳待同步）
- 2026-04-15 開庭出發提醒系統 v1.2 上線：court-departure GAS 專案，掃開庭行事曆→Routes API 雙起點車程→Notion 待辦+LINE 推播；含 API key 外洩事件處理（git history 清除、Maps/Notion key 輪換）（⏳待同步）
- 2026-04-19 王律行政系統 v2.3 LINE Bot 上線：GAS Web App，Deployment ID AKfycbxh0kpw8u3eXj5pM__nvQypfx9nws1XGR1iDA6s0G3Nq1zQ_dFj5lICvB5JWDVM5vlt；假別查詢/打卡/請假/提醒/月報/週報/沉默警報功能完整；王律師假別查詢驗收通過（74.8h=9.35天）；待設定：陳律userId/Notion DBs/GAS Triggers（需GAS編輯器手動執行 installTriggers）（⏳待同步）
