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
## 卷證筆錄摘取（Gemini 分批路線）
- 大型掃描 PDF（>44MB）的筆錄摘取，優先用 gemini_batch_extract.py
- 腳本位置：~/lawyer-scripts/gemini_batch_extract.py
- 技術限制：Gemini File API generateContent 每次約 46MB 隱性上限（70頁/46MB OK，80頁/56MB 失敗）
- 中文檔名處理：操作前先 cp 到 /tmp/英文名.ext 再處理
- 產出格式：結構化 .md，含頁碼、日期、受詢問人、詢問機關
---
