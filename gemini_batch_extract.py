#!/usr/bin/env python3
"""
動態分批：依檔案大小切割 PDF，每批 < 45MB，用 Gemini 萃取筆錄
"""
import io, requests, json, time, os
from pypdf import PdfWriter, PdfReader

API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    raise ValueError("請設定環境變數 GEMINI_API_KEY，例如：export GEMINI_API_KEY=你的新key")
PDF_PATH = "/tmp/114_偵_010238_DOC_001_1150129155707.pdf"
OUTPUT_DIR = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-wjv@lawyerwjv.com/共用雲端硬碟/王律共用雲端/110.律師/2.案件-進行中/刑事/劉懷仁/_output/")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "114_偵_010238_筆錄摘取_gemini.md")
MAX_BATCH_MB = 44  # 安全閾值
MODEL = "gemini-2.5-pro"

os.makedirs(OUTPUT_DIR, exist_ok=True)

PROMPT = """你正在閱讀一份台灣刑事偵查卷宗的部分頁面。
請摘取這些頁面中所有筆錄內容（包含警詢筆錄、偵訊筆錄）。
每份筆錄格式如下：

### 筆錄 N
- 頁碼：第 X 頁（本批內頁碼）
- 筆錄類型：警詢筆錄 / 偵訊筆錄
- 受詢問人：姓名
- 詢問機關/檢察官：XXX
- 日期：YYYY年MM月DD日

【筆錄內容原文】
（保留原始用語，不要摘要或改寫，完整抄錄問答）

---

如果這些頁面中沒有筆錄，回答「本批無筆錄內容」。"""


def pdf_pages_to_bytes(reader, page_indices):
    writer = PdfWriter()
    for i in page_indices:
        writer.add_page(reader.pages[i])
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def upload_pdf_bytes(pdf_bytes, display_name):
    metadata = json.dumps({"file": {"display_name": display_name, "mime_type": "application/pdf"}})
    r = requests.post(
        f"https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key={API_KEY}",
        files={"metadata": (None, metadata, "application/json"),
               "file": ("batch.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["file"]["uri"]


def generate_with_pdf(file_uri, prompt):
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}",
        json={"contents": [{"parts": [
            {"file_data": {"mime_type": "application/pdf", "file_uri": file_uri}},
            {"text": prompt},
        ]}], "generationConfig": {"temperature": 0.1}},
        timeout=300,
    )
    if r.status_code != 200:
        print(f"      ERROR {r.status_code}: {r.text[:200]}")
        r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


# 動態分批：貪婪法，把頁面一頁一頁加入，超過閾值就切批
reader = PdfReader(PDF_PATH)
total_pages = len(reader.pages)
print(f"總頁數: {total_pages}，目標每批 < {MAX_BATCH_MB} MB")

batches = []  # list of (start_page_0indexed, end_page_exclusive)
current_start = 0
while current_start < total_pages:
    # 二分法找本批最多能放幾頁
    lo, hi = 1, min(total_pages - current_start, 100)
    # 先快速估算：如果整批都 ok，直接用
    data = pdf_pages_to_bytes(reader, range(current_start, current_start + hi))
    if len(data) / 1024 / 1024 <= MAX_BATCH_MB:
        batches.append((current_start, current_start + hi))
        current_start += hi
        continue
    # 二分法
    while lo < hi:
        mid = (lo + hi + 1) // 2
        data = pdf_pages_to_bytes(reader, range(current_start, current_start + mid))
        if len(data) / 1024 / 1024 <= MAX_BATCH_MB:
            lo = mid
        else:
            hi = mid - 1
    if lo == 0:
        lo = 1  # 單頁也要處理
    batches.append((current_start, current_start + lo))
    current_start += lo

print(f"共 {len(batches)} 批：{[(s+1, e) for s,e in batches]}")

all_results = []
t_total = time.time()

for batch_idx, (p_start, p_end) in enumerate(batches):
    batch_label = f"第{batch_idx+1}/{len(batches)}批（p{p_start+1}–p{p_end}）"
    print(f"\n[{batch_idx+1}/{len(batches)}] {batch_label}", flush=True)

    data = pdf_pages_to_bytes(reader, range(p_start, p_end))
    mb = len(data) / 1024 / 1024
    print(f"      {p_end - p_start} 頁，{mb:.1f} MB", flush=True)

    t0 = time.time()
    file_uri = upload_pdf_bytes(data, f"batch_{batch_idx+1}")
    print(f"      上傳 {time.time()-t0:.0f}s，{file_uri.split('/')[-1]}", flush=True)

    t1 = time.time()
    result = generate_with_pdf(file_uri, PROMPT)
    print(f"      Gemini {time.time()-t1:.0f}s", flush=True)
    print(f"      預覽: {result[:120].replace(chr(10), ' ')}", flush=True)

    all_results.append((batch_label, p_start + 1, p_end, result))

elapsed = time.time() - t_total
print(f"\n全部完成，總耗時 {elapsed:.0f}s")

with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    f.write("# 114偵010238 筆錄全文摘取（Gemini 2.5 Pro）\n\n")
    f.write(f"> 來源：114_偵_010238_DOC_001_1150129155707.pdf（{total_pages} 頁）\n")
    f.write(f"> 模型：{MODEL}\n")
    f.write(f"> 分批數：{len(batches)}\n")
    f.write(f"> 總耗時：{elapsed:.0f}s\n\n")
    f.write("---\n\n")
    for label, p_start, p_end, content in all_results:
        f.write(f"## {label}（原始頁 {p_start}–{p_end}）\n\n")
        f.write(content)
        f.write("\n\n---\n\n")

print(f"輸出：{OUTPUT_FILE}")
print(f"總字元數：{sum(len(r) for _, _, _, r in all_results):,}")
