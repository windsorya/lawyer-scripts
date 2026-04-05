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

### 共用規則
- clasp 3.3.0 已安裝
- **修改流程**：clasp pull → 修改 → diff 確認 → clasp push → clasp pull 驗證 → git commit
- **安全規則**：push 前必須 diff；push 失敗從 git 恢復；每次 push 後自動 git commit

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
