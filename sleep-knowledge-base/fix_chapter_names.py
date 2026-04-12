#!/usr/bin/env python3
"""
睡眠知識庫 Chapter_N 章名補正腳本
從 Google Drive .md 檔案提取真正的章節名稱，更新到 Notion 資料庫。

用法：
  python3 fix_chapter_names.py --dry-run   # 先跑 dry run 確認提取結果
  python3 fix_chapter_names.py             # 確認後實際更新 Notion
"""

import os
import sys
import json
import time
import argparse
import re
from pathlib import Path

import requests
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# ─── 設定 ──────────────────────────────────────────────────────────────────────

GOOGLE_KEYS_PATH = os.path.expanduser('~/.config/google-drive-mcp/gcp-oauth.keys.json')
GOOGLE_TOKENS_PATH = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')

NOTION_CONFIG_PATH = os.path.expanduser('~/JudicialData/config.env')
NOTION_DB_ID = 'b1be855c33b3401b993a4a2458adb94e'
NOTION_VERSION = '2022-06-28'

# 三個來源資料夾
FOLDERS = [
    {
        'name': '正念減壓自學全書',
        'folder_id': '1yb1mDGTtdAj8lQh6bpn6JkNGjijpa7VN',
        'filter': None,  # 處理全部
    },
    {
        'name': '精力管理',
        'folder_id': '1ryZ-1Rw1rfrpqgMjFIkQm92I79BAHVDh',
        'filter': None,  # 處理全部
    },
    {
        'name': '正念療癒力',
        'folder_id': '1xrwilqJoscyPPCTlxvnnOWGRnPYDggIt',
        'filter': {'01_Chapter_1.md', '02_Chapter_2.md', '52_Chapter_52.md'},  # 只處理這三個
    },
]

# ─── Google Auth ────────────────────────────────────────────────────────────────

def load_google_creds():
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
        scopes=['https://www.googleapis.com/auth/drive.readonly'],
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        # 更新儲存的 token
        tokens['access_token'] = creds.token
        with open(GOOGLE_TOKENS_PATH, 'w') as f:
            json.dump(tokens, f)
    return creds


def load_notion_token():
    token = os.environ.get('NOTION_TOKEN') or os.environ.get('NOTION_API_KEY')
    if token:
        return token
    if os.path.exists(NOTION_CONFIG_PATH):
        with open(NOTION_CONFIG_PATH) as f:
            for line in f:
                line = line.strip()
                if line.startswith('NOTION_API_KEY='):
                    return line.split('=', 1)[1].strip()
    raise RuntimeError('找不到 Notion API Key，請設定 NOTION_TOKEN 環境變數或確認 ~/JudicialData/config.env')


# ─── Drive 操作 ────────────────────────────────────────────────────────────────

def list_md_files(drive_service, folder_id, name_filter=None):
    """列出資料夾內所有 .md 檔案"""
    files = []
    page_token = None
    while True:
        query = f"'{folder_id}' in parents and name contains '.md' and trashed = false"
        resp = drive_service.files().list(
            q=query,
            fields='nextPageToken, files(id, name)',
            pageToken=page_token,
            pageSize=200,
        ).execute()
        for f in resp.get('files', []):
            if name_filter is None or f['name'] in name_filter:
                files.append(f)
        page_token = resp.get('nextPageToken')
        if not page_token:
            break
    return files


def read_file_head(drive_service, file_id, max_bytes=2000):
    """下載檔案前 max_bytes 位元組"""
    request = drive_service.files().get_media(fileId=file_id)
    import io
    from googleapiclient.http import MediaIoBaseDownload

    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request, chunksize=max_bytes)
    done = False
    while not done:
        _, done = downloader.next_chunk()
        if buf.tell() >= max_bytes:
            break
    buf.seek(0)
    raw = buf.read(max_bytes)
    try:
        return raw.decode('utf-8', errors='replace')
    except Exception:
        return raw.decode('latin-1', errors='replace')


# ─── 章名提取 ──────────────────────────────────────────────────────────────────

def extract_chapter_title(content: str, filename: str) -> str:
    """
    從 .md 內容提取章節名稱。

    檔案結構：
    ---
    book: xxx
    chapter: N
    title: "Chapter_N"   ← 佔位符，不用
    source_file: xxx.epub
    ---

    第一行有意義的內容  ← 我們要這個

    策略：
    1. 跳過 YAML frontmatter（兩個 --- 之間）
    2. 優先取 frontmatter 裡的 `book_chapter_title:` 欄位（若存在）
    3. 找 frontmatter 後的第一個 `# ` H1
    4. 否則取 frontmatter 後第一個非空行
    5. fallback：用檔名
    """
    lines = content.split('\n')

    # Step 1: 解析 YAML frontmatter
    frontmatter = {}
    content_start = 0
    if lines and lines[0].strip() == '---':
        for i in range(1, len(lines)):
            if lines[i].strip() == '---':
                content_start = i + 1
                break
            # 解析 frontmatter 的 key: value
            m = re.match(r'^(\w+)\s*:\s*"?(.*?)"?\s*$', lines[i])
            if m:
                frontmatter[m.group(1)] = m.group(2).strip()

    # Step 2: 找 frontmatter 後內容
    body_lines = lines[content_start:]

    def has_chinese(s: str) -> bool:
        """判斷字串是否含有中文字元"""
        return bool(re.search(r'[\u4e00-\u9fff\u3400-\u4dbf]', s))

    # 判斷一行是否為「無意義的」佔位行
    def is_junk_line(s: str) -> bool:
        if not s:
            return True
        # --- 分隔線
        if re.match(r'^-{3,}$', s):
            return True
        # 純英文章節標籤：Chaper N、Chapter N（可能有拼錯）
        if re.match(r'^Chap(?:ter|er)\s+\d+\s*$', s, re.IGNORECASE):
            return True
        # 出版資訊行：野人家NNN
        if re.match(r'^野人家\d+', s):
            return True
        # CIP / 版權頁
        if re.match(r'^(ISBN|CIP|圖書在版編目)', s):
            return True
        # 以 / 結尾的書目資料行（如「精力管理：... /」）
        if s.endswith('/'):
            return True
        # 純 ASCII 行（沒有中文）—— 英文 section header、英文副標題
        # 例：「fully engaged: energy, not time,」「Physical Energy:」
        if not has_chinese(s):
            return True
        return False

    # Step 3: 優先找 Markdown 標題（# 到 ######）
    for line in body_lines:
        stripped = line.strip()
        if re.match(r'^#{1,6}\s', stripped):
            return re.sub(r'^#+\s*', '', stripped).strip()

    # Step 4: 跳過垃圾行，取第一個有意義的行
    for line in body_lines:
        stripped = line.strip()
        if not is_junk_line(stripped):
            return stripped

    # Step 5: fallback — 用檔名
    name = Path(filename).stem  # e.g. "01_Chapter_1"
    m = re.match(r'^\d+_(.+)$', name)
    if m:
        return m.group(1).replace('_', ' ')
    return name


# ─── Notion 操作 ────────────────────────────────────────────────────────────────

def notion_headers(token):
    return {
        'Authorization': f'Bearer {token}',
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    }


def query_pending_pages(token, db_id):
    """查詢處理狀態為「待補正」的所有頁面"""
    url = f'https://api.notion.com/v1/databases/{db_id}/query'
    pages = []
    cursor = None

    while True:
        body = {
            'filter': {
                'property': '處理狀態',
                'select': {'equals': '待補正'},
            },
            'page_size': 100,
        }
        if cursor:
            body['start_cursor'] = cursor

        resp = requests.post(url, headers=notion_headers(token), json=body)
        resp.raise_for_status()
        data = resp.json()
        pages.extend(data.get('results', []))

        if not data.get('has_more'):
            break
        cursor = data.get('next_cursor')
        time.sleep(0.35)

    return pages


def update_notion_page(token, page_id, new_title, dry_run=False):
    """更新頁面的章節名（title）和處理狀態"""
    if dry_run:
        print(f'  [DRY RUN] 會更新 page_id={page_id} → 章節名="{new_title}", 處理狀態=已索引')
        return True

    url = f'https://api.notion.com/v1/pages/{page_id}'
    body = {
        'properties': {
            '章節名': {
                'title': [{'text': {'content': new_title}}],
            },
            '處理狀態': {
                'select': {'name': '已索引'},
            },
        }
    }
    resp = requests.patch(url, headers=notion_headers(token), json=body)
    if resp.status_code != 200:
        print(f'  ERROR: HTTP {resp.status_code} — {resp.text[:200]}')
        return False
    return True


# ─── 主流程 ────────────────────────────────────────────────────────────────────

def build_drive_file_index(drive_service):
    """從所有來源資料夾收集 Drive 檔案清單"""
    results = []  # [{folder_name, file_id, filename}]

    for folder in FOLDERS:
        print(f'[Drive] 列出資料夾：{folder["name"]} ...')
        files = list_md_files(drive_service, folder['folder_id'], folder['filter'])
        files.sort(key=lambda f: f['name'])
        print(f'  → {len(files)} 個 .md 檔案')
        for f in files:
            results.append({
                'folder_name': folder['name'],
                'file_id': f['id'],
                'filename': f['name'],
            })

    return results


def extract_all_titles(drive_service, file_index):
    """讀取每個檔案的前 500 字並提取章名"""
    total = len(file_index)
    for i, item in enumerate(file_index, 1):
        print(f'  [{i}/{total}] {item["filename"]}', end=' ... ', flush=True)
        try:
            content = read_file_head(drive_service, item['file_id'], max_bytes=2000)
            title = extract_chapter_title(content, item['filename'])
            item['extracted_title'] = title
            print(f'→ {title}')
        except HttpError as e:
            item['extracted_title'] = None
            item['error'] = str(e)
            print(f'ERROR: {e}')
        time.sleep(0.1)  # 避免觸發 rate limit

    return file_index


def main():
    parser = argparse.ArgumentParser(description='睡眠知識庫 Chapter_N 章名補正')
    parser.add_argument('--dry-run', action='store_true', help='只列出結果，不寫入 Notion')
    args = parser.parse_args()

    dry_run = args.dry_run

    print('=' * 60)
    print('睡眠知識庫章名補正腳本 v2（Notion-first 策略）')
    print(f'模式：{"DRY RUN（不寫入）" if dry_run else "實際更新 Notion"}')
    print('=' * 60)

    # 初始化
    print('\n[1] 載入認證 ...')
    creds = load_google_creds()
    drive_service = build('drive', 'v3', credentials=creds)
    notion_token = load_notion_token()
    print(f'  ✓ Google Drive + Notion 已連線')

    # Step 1: 查 Notion 取得所有待補正頁面
    print('\n[2] 查詢 Notion 待補正頁面 ...')
    pending_pages = query_pending_pages(notion_token, NOTION_DB_ID)
    print(f'  → {len(pending_pages)} 筆待補正')

    # 整理：只處理有 Drive檔案ID 的頁面
    tasks = []
    for page in pending_pages:
        props = page.get('properties', {})
        rt = props.get('Drive檔案ID', {}).get('rich_text', [])
        drive_file_id = rt[0]['plain_text'].strip() if rt else ''
        if not drive_file_id:
            continue
        title_prop = props.get('章節名', {}).get('title', [])
        current_title = title_prop[0]['plain_text'] if title_prop else ''
        book = (props.get('書名', {}).get('select') or {}).get('name', '')
        tasks.append({
            'page_id': page['id'],
            'drive_file_id': drive_file_id,
            'current_title': current_title,
            'book': book,
        })

    print(f'  → {len(tasks)} 筆有 Drive 檔案 ID，將讀取並提取章名')

    # Step 2: 對每個 Notion 頁面，讀取對應 Drive 檔案
    print('\n[3] 讀取 Drive 檔案並提取章名 ...')
    total = len(tasks)
    errors = []
    ok_tasks = []

    for i, task in enumerate(tasks, 1):
        print(f'  [{i}/{total}] [{task["book"]}] {task["current_title"]!r} ... ', end='', flush=True)
        try:
            content = read_file_head(drive_service, task['drive_file_id'], max_bytes=2000)
            title = extract_chapter_title(content, task['current_title'])
            task['extracted_title'] = title
            print(f'→ {title}')
            ok_tasks.append(task)
        except Exception as e:
            task['error'] = str(e)
            errors.append(task)
            print(f'ERROR: {e}')
        time.sleep(0.1)

    print(f'\n共 {len(ok_tasks)} 筆正常，{len(errors)} 筆錯誤')

    if dry_run:
        print('\n[DRY RUN 完成] 確認無誤後，請用 python3 fix_chapter_names.py 執行實際更新。')
        return

    # Step 3: 更新 Notion
    print('\n[4] 更新 Notion ...')
    success = 0
    fail = 0
    fail_details = []

    for task in ok_tasks:
        new_title = task['extracted_title']
        page_id = task['page_id']
        print(f'  [{task["book"]}] {task["current_title"]!r} → "{new_title}"')
        ok = update_notion_page(notion_token, page_id, new_title, dry_run=False)
        if ok:
            success += 1
        else:
            fail += 1
            fail_details.append(f'{task["current_title"]}: 更新失敗')
        time.sleep(0.35)

    # 統計
    print('\n' + '=' * 60)
    print('更新結果摘要：')
    print(f'  成功更新：{success} 筆')
    print(f'  失敗：{fail} 筆')
    if errors:
        print(f'  Drive 讀取錯誤：{len(errors)} 筆')

    # 查詢剩餘待補正
    print('\n[5] 確認剩餘待補正數量 ...')
    time.sleep(1)
    remaining = query_pending_pages(notion_token, NOTION_DB_ID)
    print(f'  仍為「待補正」：{len(remaining)} 筆')

    if fail_details:
        print('\n失敗清單：')
        for d in fail_details:
            print(f'  {d}')


if __name__ == '__main__':
    main()
