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
