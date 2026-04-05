#!/usr/bin/env python3
"""
Gemini 影音證據分析腳本（台灣法律用途）
作者：Claude Code（2026-04-05）

用法（影片）：
  python3 gemini_evidence_analyzer.py \\
    --mode video --file /path/to/cctv.mp4 \\
    --prompt-type 監視器 \\
    --case-folder-id <Drive folder ID> \\
    --doc-name "114_偵_010238_監視器分析"

用法（圖片批次）：
  python3 gemini_evidence_analyzer.py \\
    --mode images --files /path/to/img1.jpg /path/to/img2.jpg \\
    --prompt-type 傷勢 \\
    --case-folder-id <Drive folder ID> \\
    --doc-name "114_偵_010238_傷勢分析"

用法（本地輸出，不建 Google Doc）：
  python3 gemini_evidence_analyzer.py \\
    --mode video --file /path/to/video.mp4 \\
    --prompt-type 行車紀錄器 --local-only

Prompt 類型對應：
  video  模式：通用 / 監視器 / 行車紀錄器
  images 模式：通用 / 傷勢 / 現場
"""
import argparse
import glob as glob_module
import json
import os
import subprocess
import sys
import time

# Google API 套件（建立 Doc 用，與 gemini_pdf_extract.py 完全一致）
try:
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    GOOGLE_API_AVAILABLE = True
except ImportError:
    GOOGLE_API_AVAILABLE = False

# Gemini genai 套件（File API 上傳用）
try:
    from google import genai as _genai_module
    from google.genai import types as genai_types
    GENAI_AVAILABLE = True
except ImportError:
    GENAI_AVAILABLE = False

_genai_client = None  # 延遲初始化

API_KEY = os.environ.get("GEMINI_API_KEY")
if not API_KEY:
    raise ValueError("請設定環境變數 GEMINI_API_KEY，例如：export GEMINI_API_KEY=你的金鑰")

DEFAULT_MODEL = "gemini-2.5-flash"
MAX_RETRIES = 4

GOOGLE_KEYS_PATH = os.path.expanduser('~/.config/google-drive-mcp/gcp-oauth.keys.json')
GOOGLE_TOKENS_PATH = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')

VIDEO_EXTS = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'}
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp', '.tiff'}

VIDEO_MIME = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.m4v': 'video/x-m4v',
    '.3gp': 'video/3gpp',
}
IMAGE_MIME = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
}

# ── Prompt 範本 ──────────────────────────────────────────────

PROMPTS_VIDEO = {
    "通用": """\
你是一位台灣法律案件的證據分析專家。請仔細觀看這段影片，產出以下分析：
1.【時間軸摘要】逐一列出每個關鍵事件，格式為 [MM:SS] 事件描述
2.【人物辨識】描述影片中出現的人物特徵（衣著、體型、動作），不猜測身分
3.【環境描述】拍攝地點、光線條件、天氣、可見地標或標示
4.【證據價值評估】哪些畫面對法律案件有證據價值，為什麼
5.【影片品質】解析度、清晰度、是否有中斷或遮蔽、時間戳是否可見
請用繁體中文回答。每個時間標記精確到秒。""",

    "監視器": """\
你是一位台灣法律案件的證據分析專家，正在分析監視器錄影畫面。
1.【時間軸摘要】[MM:SS]格式。特別注意人物進出、接觸/衝突時間點、物品移動、異常行為。
2.【人物追蹤】每人編號（人物A、B...），記錄首次出現時間、外觀特徵、行動軌跡、互動。
3.【環境與攝影機資訊】攝影機位置推斷、拍攝角度、覆蓋範圍、畫面時間戳。
4.【關鍵畫面標記】最具證據價值的3-5個時間點。
5.【缺漏分析】有無死角、遮蔽、中斷或可疑跳切。
繁體中文，時間標記精確到秒。""",

    "行車紀錄器": """\
你是一位台灣法律案件的證據分析專家，正在分析行車紀錄器影片。
1.【時間軸摘要】逐秒描述事故前後關鍵畫面。注意車速變化、方向燈、煞車燈、車道變換、號誌。
2.【事故重建】事故前雙方位置/車速/方向→事故瞬間碰撞點/角度/先後動作→事故後停止位置/人員反應。
3.【道路環境】道路類型、車道數、路面狀況、標線標誌、天候光線。
4.【其他車輛/行人】周圍用路人動態。
5.【證據價值】對肇責歸屬最關鍵的畫面時間點。
6.【GPS/速度資訊】如有嵌入GPS座標或速度，摘錄。
繁體中文，時間標記精確到秒。""",
}

PROMPTS_IMAGES = {
    "通用": """\
你是一位台灣法律案件的證據分析專家。
1.【逐張描述】每張照片詳細客觀描述（場景、人物、物品、文字、時間線索）。
2.【照片關聯】多張照片關聯性分析。
3.【證據價值評估】哪些照片有重要證據價值。
4.【拍攝資訊】時間戳、浮水印、拍攝角度。
繁體中文。""",

    "傷勢": """\
你是台灣法律案件證據分析專家，分析傷勢照片。⚠️你是分析照片，不是醫療診斷。
1.【逐張傷勢描述】部位（精確到左/右/上/下/內/外側）、外觀（瘀青/紅腫/擦傷/裂傷/腫脹）、估計大小、顏色（深紫/暗紅/淡黃）。
2.【嚴重程度推斷】輕微/中度/嚴重。
3.【成因推斷】可能成因方向（鈍器/銳器/跌倒/撞擊），不做確定判斷。
4.【照片品質】是否足以作法律證據（清晰度、比例尺、時間戳）。
5.【建議補充】建議律師要求補拍的資料。
繁體中文，傷勢描述客觀精確。""",

    "現場": """\
你是台灣法律案件證據分析專家，分析案發現場照片。
1.【現場全貌】地點類型、空間大小、佈局。
2.【逐張描述】物品位置、損壞痕跡、門窗狀態、地面狀況。
3.【空間關係】多張照片的空間關係重建。
4.【異常發現】可能與案件相關的異常細節。
5.【證據保全評估】有無被移動或破壞跡象。
6.【建議補充】建議律師補拍的角度或細節。
繁體中文。""",
}

# ── Google API 工具（與 gemini_pdf_extract.py 完全一致）──────

def load_google_creds():
    """載入 Google OAuth 憑證並自動 refresh token"""
    if not GOOGLE_API_AVAILABLE:
        raise ImportError(
            "需要 google-api-python-client：\n"
            "pip install --break-system-packages google-api-python-client "
            "google-auth-httplib2 google-auth-oauthlib"
        )
    if not os.path.exists(GOOGLE_KEYS_PATH) or not os.path.exists(GOOGLE_TOKENS_PATH):
        raise FileNotFoundError(
            f"找不到 Google OAuth 憑證，需要：\n"
            f"  {GOOGLE_KEYS_PATH}\n  {GOOGLE_TOKENS_PATH}"
        )
    with open(GOOGLE_KEYS_PATH) as f:
        keys = json.load(f)
    with open(GOOGLE_TOKENS_PATH) as f:
        tokens = json.load(f)
    installed = keys.get('installed', keys.get('web', {}))
    creds = Credentials(
        token=tokens['access_token'],
        refresh_token=tokens['refresh_token'],
        token_uri='https://oauth2.googleapis.com/token',
        client_id=installed['client_id'],
        client_secret=installed['client_secret'],
        scopes=['https://www.googleapis.com/auth/drive'],
    )
    if creds.expired:
        creds.refresh(Request())
    return creds


def create_google_doc(folder_id: str, doc_name: str, content: str) -> tuple:
    """
    在 Google Drive 指定資料夾建立 Google Doc 並寫入 content。
    回傳 (doc_id, webViewLink)。
    文字分批插入（每批 50,000 字元），避免超過 API 單次請求限制。
    """
    creds = load_google_creds()
    drive = build('drive', 'v3', credentials=creds)
    docs = build('docs', 'v1', credentials=creds)

    f = drive.files().create(
        body={
            'name': doc_name,
            'mimeType': 'application/vnd.google-apps.document',
            'parents': [folder_id],
        },
        fields='id,webViewLink',
    ).execute()
    doc_id = f['id']
    print(f"  建立 Google Doc：{doc_name}（id={doc_id}）", flush=True)

    CHUNK = 50_000
    cursor = 1
    chunks = [content[i:i + CHUNK] for i in range(0, len(content), CHUNK)]
    for i, chunk_text in enumerate(chunks, 1):
        docs.documents().batchUpdate(
            documentId=doc_id,
            body={'requests': [{'insertText': {'location': {'index': cursor}, 'text': chunk_text}}]},
        ).execute()
        cursor += len(chunk_text)
        if len(chunks) > 1:
            print(f"  寫入進度 {i}/{len(chunks)}（{cursor:,} 字元）", flush=True)

    return doc_id, f['webViewLink']


# ── Gemini File API ──────────────────────────────────────────

def _ensure_genai():
    """確認 google.genai 可用，否則提示安裝並退出；回傳 client"""
    global _genai_client
    if not GENAI_AVAILABLE:
        sys.exit(
            "需要 google-genai 套件：\n"
            "pip install --break-system-packages google-genai"
        )
    if _genai_client is None:
        _genai_client = _genai_module.Client(api_key=API_KEY)
    return _genai_client


def upload_file(path: str, mime_type: str, display_name: str):
    """用 client.files.upload 上傳檔案，回傳 File 物件"""
    client = _ensure_genai()
    size_mb = os.path.getsize(path) / 1024 / 1024
    print(f"  上傳中：{os.path.basename(path)}（{size_mb:.1f}MB）...", flush=True)
    t0 = time.time()
    file_obj = client.files.upload(
        file=path,
        config=genai_types.UploadFileConfig(mime_type=mime_type, display_name=display_name),
    )
    print(f"  上傳完成（{time.time()-t0:.0f}s），等待 Gemini 處理...", flush=True)
    return file_obj


def wait_until_active(file_obj, timeout: int = 600):
    """Polling 直到 file state 為 ACTIVE，逾時則 raise"""
    client = _ensure_genai()
    start = time.time()
    while True:
        state = str(file_obj.state)
        if "ACTIVE" in state:
            print(f"  檔案就緒（state=ACTIVE）", flush=True)
            return file_obj
        if "FAILED" in state:
            raise RuntimeError(f"Gemini 檔案處理失敗（state={state}）：{file_obj.name}")
        if time.time() - start > timeout:
            raise TimeoutError(f"等待 ACTIVE 逾時（>{timeout}s），目前 state={state}")
        elapsed = int(time.time() - start)
        print(f"  處理中（{elapsed}s）...", end='\r', flush=True)
        time.sleep(5)
        file_obj = client.files.get(name=file_obj.name)


def generate_with_retry(model_name: str, parts: list, retries: int = MAX_RETRIES) -> str:
    """送出推論請求，遇到錯誤自動重試（指數退避）"""
    client = _ensure_genai()
    delay = 20
    last_exc = None
    for attempt in range(retries):
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=parts,
                config=genai_types.GenerateContentConfig(temperature=0.1),
            )
            return response.text
        except Exception as exc:
            last_exc = exc
            err_str = str(exc)
            retryable = any(
                code in err_str
                for code in ['429', '500', '503', 'ResourceExhausted', 'ServiceUnavailable', 'quota']
            )
            if retryable and attempt < retries - 1:
                print(
                    f"  ↻ 錯誤（{type(exc).__name__}），{delay}s 後重試（第{attempt+1}次）",
                    flush=True,
                )
                time.sleep(delay)
                delay *= 2
            else:
                break
    raise RuntimeError(f"重試 {retries} 次後仍失敗：{last_exc}")


# ── 模式實作 ─────────────────────────────────────────────────

def run_video_mode(args) -> tuple:
    """影片模式：上傳單一影片 → 分析 → 回傳 (full_text, elapsed)"""
    if not args.file:
        sys.exit("影片模式需要 --file 參數")

    file_path = os.path.expanduser(args.file)
    if not os.path.exists(file_path):
        sys.exit(f"找不到檔案：{file_path}")

    ext = os.path.splitext(file_path)[1].lower()
    if ext not in VIDEO_EXTS:
        sys.exit(
            f"不支援的影片格式：{ext}\n"
            f"支援格式：{', '.join(sorted(VIDEO_EXTS))}"
        )

    mime_type = VIDEO_MIME[ext]
    file_name = os.path.basename(file_path)

    # 決定 prompt
    if args.custom_prompt:
        prompt = args.custom_prompt
        prompt_label = "自訂"
    else:
        pt = args.prompt_type or "通用"
        if pt not in PROMPTS_VIDEO:
            sys.exit(
                f"影片模式不支援 --prompt-type={pt!r}\n"
                f"可用：{list(PROMPTS_VIDEO.keys())}"
            )
        prompt = PROMPTS_VIDEO[pt]
        prompt_label = pt

    model_name = args.model

    print(f"\n[1/3] 上傳影片至 Gemini File API...")
    t0 = time.time()
    file_obj = upload_file(file_path, mime_type, file_name)
    file_obj = wait_until_active(file_obj)
    upload_time = time.time() - t0

    print(f"\n[2/3] 送出分析請求（模型：{model_name}）...")
    t1 = time.time()
    result_text = generate_with_retry(model_name, [file_obj, prompt])
    analyze_time = time.time() - t1
    total_time = time.time() - t0

    print(
        f"  分析完成（上傳 {upload_time:.0f}s　推論 {analyze_time:.0f}s　總計 {total_time:.0f}s）",
        flush=True,
    )

    size_mb = os.path.getsize(file_path) / 1024 / 1024
    header = (
        f"{args.doc_name}\n\n"
        f"來源：{file_name}（{size_mb:.1f}MB）\n"
        f"模式：影片分析　Prompt 類型：{prompt_label}\n"
        f"模型：{model_name}　耗時：{total_time:.0f}s\n\n"
        + "─" * 60 + "\n\n"
    )
    return header + result_text, total_time


def run_images_mode(args) -> tuple:
    """圖片批次模式：上傳多張圖片 → 一次分析 → 回傳 (full_text, elapsed)"""
    if not args.files:
        sys.exit("圖片模式需要 --files 參數")

    # 展開 glob 並去重排序
    raw_paths = []
    for pattern in args.files:
        expanded = glob_module.glob(os.path.expanduser(pattern))
        if expanded:
            raw_paths.extend(expanded)
        elif os.path.exists(os.path.expanduser(pattern)):
            raw_paths.append(os.path.expanduser(pattern))
        else:
            print(f"  ⚠ 找不到：{pattern}", flush=True)

    if not raw_paths:
        sys.exit("沒有找到任何圖片檔案")

    valid_paths = []
    for p in sorted(set(raw_paths)):
        ext = os.path.splitext(p)[1].lower()
        if ext in IMAGE_EXTS:
            valid_paths.append(p)
        else:
            print(f"  ⚠ 略過不支援格式：{os.path.basename(p)}", flush=True)

    if not valid_paths:
        sys.exit("沒有找到支援的圖片格式")

    print(f"  找到 {len(valid_paths)} 張圖片", flush=True)

    # 決定 prompt
    if args.custom_prompt:
        prompt = args.custom_prompt
        prompt_label = "自訂"
    else:
        pt = args.prompt_type or "通用"
        if pt not in PROMPTS_IMAGES:
            sys.exit(
                f"圖片模式不支援 --prompt-type={pt!r}\n"
                f"可用：{list(PROMPTS_IMAGES.keys())}"
            )
        prompt = PROMPTS_IMAGES[pt]
        prompt_label = pt

    model_name = args.model

    print(f"\n[1/3] 上傳圖片至 Gemini File API...")
    t0 = time.time()
    file_objects = []
    for i, p in enumerate(valid_paths, 1):
        ext = os.path.splitext(p)[1].lower()
        mime_type = IMAGE_MIME.get(ext, 'image/jpeg')
        print(f"  [{i}/{len(valid_paths)}] {os.path.basename(p)}", flush=True)
        fobj = upload_file(p, mime_type, os.path.basename(p))
        file_objects.append(fobj)

    print(f"  等待所有圖片就緒...", flush=True)
    active_objects = [wait_until_active(fobj) for fobj in file_objects]
    upload_time = time.time() - t0

    print(
        f"\n[2/3] 送出分析請求（模型：{model_name}，{len(active_objects)} 張圖片）...",
        flush=True,
    )
    t1 = time.time()
    result_text = generate_with_retry(model_name, active_objects + [prompt])
    analyze_time = time.time() - t1
    total_time = time.time() - t0

    print(
        f"  分析完成（上傳 {upload_time:.0f}s　推論 {analyze_time:.0f}s　總計 {total_time:.0f}s）",
        flush=True,
    )

    file_list = "\n".join(
        f"  {i+1}. {os.path.basename(p)}" for i, p in enumerate(valid_paths)
    )
    header = (
        f"{args.doc_name}\n\n"
        f"來源：{len(valid_paths)} 張圖片\n"
        f"{file_list}\n\n"
        f"模式：圖片批次分析　Prompt 類型：{prompt_label}\n"
        f"模型：{model_name}　耗時：{total_time:.0f}s\n\n"
        + "─" * 60 + "\n\n"
    )
    return header + result_text, total_time


# ── 主程式 ───────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="Gemini 影音證據分析腳本（台灣法律用途）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Prompt 類型對應：
  --mode video  ：通用 / 監視器 / 行車紀錄器
  --mode images ：通用 / 傷勢 / 現場

範例：
  # 監視器影片分析 → Google Doc
  python3 gemini_evidence_analyzer.py \\
    --mode video --file cctv.mp4 --prompt-type 監視器 \\
    --case-folder-id <ID> --doc-name "114_偵_010238_監視器"

  # 傷勢照片批次分析 → Google Doc
  python3 gemini_evidence_analyzer.py \\
    --mode images --files *.jpg \\
    --prompt-type 傷勢 \\
    --case-folder-id <ID> --doc-name "114_偵_010238_傷勢"

  # 本地輸出（不建 Google Doc）
  python3 gemini_evidence_analyzer.py \\
    --mode video --file dashcam.mp4 \\
    --prompt-type 行車紀錄器 --local-only
""",
    )
    ap.add_argument(
        "--mode", required=True, choices=["video", "images"],
        help="分析模式：video（影片）或 images（圖片批次）",
    )
    ap.add_argument(
        "--file", default=None,
        help="影片路徑（--mode video 用，支援 .mp4 .mov .avi .mkv .webm .m4v .3gp）",
    )
    ap.add_argument(
        "--files", nargs="+", default=None,
        help="圖片路徑，支援多個或 glob（--mode images 用）",
    )
    ap.add_argument(
        "--prompt-type", default="通用",
        choices=["通用", "監視器", "行車紀錄器", "傷勢", "現場"],
        help="分析模板（預設：通用）",
    )
    ap.add_argument(
        "--custom-prompt", default=None,
        help="自訂提示詞（覆蓋 --prompt-type）",
    )
    ap.add_argument(
        "--case-folder-id", default=None,
        help="Google Drive 案件資料夾 ID（輸出 Google Doc 用）",
    )
    ap.add_argument(
        "--doc-name", default=None,
        help="輸出 Google Doc 或 Markdown 的名稱（省略時自動產生）",
    )
    ap.add_argument(
        "--model", default=DEFAULT_MODEL,
        help=f"Gemini 模型（預設：{DEFAULT_MODEL}）",
    )
    ap.add_argument(
        "--local-only", action="store_true",
        help="僅輸出本地 Markdown 檔案，不建 Google Doc",
    )
    args = ap.parse_args()

    # 驗證輸出設定
    if not args.local_only and not args.case_folder_id:
        ap.error("需要 --case-folder-id，或加上 --local-only 改為本地輸出")

    # 自動產生文件名
    if not args.doc_name:
        if args.mode == "video" and args.file:
            base = os.path.splitext(os.path.basename(args.file))[0]
            args.doc_name = f"{base}_{args.prompt_type}_分析"
        else:
            args.doc_name = f"影音分析_{time.strftime('%Y%m%d_%H%M%S')}"

    # 確認 genai 可用（同時初始化 client）
    _ensure_genai()

    print(f"=== Gemini 影音證據分析 ===", flush=True)
    print(
        f"模式：{args.mode}　Prompt：{args.prompt_type}　模型：{args.model}",
        flush=True,
    )

    # 執行分析
    if args.mode == "video":
        full_text, elapsed = run_video_mode(args)
    else:
        full_text, elapsed = run_images_mode(args)

    # 輸出
    print(f"\n[3/3] 輸出結果...", flush=True)
    print(f"  總字元數：{len(full_text):,}", flush=True)

    if args.local_only:
        out_path = os.path.join(os.getcwd(), f"{args.doc_name}.md")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(full_text)
        print(f"\n  ✓ 已存 Markdown：{out_path}")
    else:
        print(f"  建立 Google Doc（folder: {args.case_folder_id}）", flush=True)
        doc_id, link = create_google_doc(args.case_folder_id, args.doc_name, full_text)
        print(f"\n  ✓ Google Doc 建立成功")
        print(f"  文件名：{args.doc_name}")
        print(f"  連結：{link}")

    # 完成音效
    subprocess.run(
        ["afplay", "/System/Library/Sounds/Hero.aiff"],
        capture_output=True,
    )
    print(f"\n=== 完成！總耗時 {elapsed:.0f}s ===", flush=True)


if __name__ == "__main__":
    main()
