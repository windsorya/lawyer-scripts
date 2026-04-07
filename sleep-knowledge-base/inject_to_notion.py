#!/usr/bin/env python3
"""
睡眠知識庫全文灌入 Notion
從 Google Drive .md 檔案讀取全文，寫入對應的 Notion 頁面內容（children blocks）。

用法：
  python3 inject_to_notion.py --test          # 測試 3 筆
  python3 inject_to_notion.py --all           # 灌全部 238 筆
  python3 inject_to_notion.py --all --resume  # 跳過已有內容的頁面（續跑）
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
from googleapiclient.http import MediaIoBaseDownload
import io

# ─── 設定 ──────────────────────────────────────────────────────────────────────

GOOGLE_KEYS_PATH = os.path.expanduser('~/.config/google-drive-mcp/gcp-oauth.keys.json')
GOOGLE_TOKENS_PATH = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')
NOTION_CONFIG_PATH = os.path.expanduser('~/JudicialData/config.env')

NOTION_DB_ID = 'b1be855c33b3401b993a4a2458adb94e'

# 測試用 3 筆（Drive ID → Notion 頁面 ID）
TEST_CASES = [
    ('1iaVGfHYP_Wn-FGO1RG4-lu-ziQ0QmA5l', '33be22f21ca4816f999dee0ae3a6b320'),
    ('1O4oUjCO84D8TnW-U5QWQSQGNj7Vlyuzk', '33be22f21ca481c79693ee2a77245666'),
    ('1439JNZozJauyTiG8J8OerXO3qhv86DVH',  '33be22f21ca481268135f411f9838894'),
]

# ─── 認證 ──────────────────────────────────────────────────────────────────────

def load_google_creds():
    with open(GOOGLE_KEYS_PATH) as f:
        keys = json.load(f)
    installed = keys.get('installed') or keys.get('web')
    with open(GOOGLE_TOKENS_PATH) as f:
        token_data = json.load(f)
    creds = Credentials(
        token=token_data.get('access_token'),
        refresh_token=token_data.get('refresh_token'),
        token_uri=installed['token_uri'],
        client_id=installed['client_id'],
        client_secret=installed['client_secret'],
        scopes=token_data.get('scope', '').split(),
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token_data['access_token'] = creds.token
        with open(GOOGLE_TOKENS_PATH, 'w') as f:
            json.dump(token_data, f)
    return creds

def load_notion_token():
    token = os.environ.get('NOTION_TOKEN') or os.environ.get('NOTION_API_KEY')
    if token:
        return token
    if os.path.exists(NOTION_CONFIG_PATH):
        with open(NOTION_CONFIG_PATH) as f:
            for line in f:
                m = re.match(r'^NOTION_(?:TOKEN|API_KEY)\s*=\s*(.+)', line.strip())
                if m:
                    return m.group(1).strip().strip('"\'')
    raise RuntimeError('找不到 Notion API Key')

def notion_headers(token):
    return {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
    }

# ─── Drive 讀檔 ────────────────────────────────────────────────────────────────

def read_drive_file(drive_service, file_id):
    """下載 Drive .md 檔案全文"""
    request = drive_service.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue().decode('utf-8')

# ─── Markdown → Notion blocks ─────────────────────────────────────────────────

def make_text_block(text):
    if len(text) > 2000:
        text = text[:1997] + '...'
    return {
        'type': 'paragraph',
        'paragraph': {'rich_text': [{'type': 'text', 'text': {'content': text}}]}
    }

def split_to_notion_blocks(markdown):
    """將 markdown 分割成 Notion blocks（paragraph/heading）"""
    lines = markdown.split('\n')
    blocks = []
    buffer = ''

    for line in lines:
        # buffer 快滿時先 flush
        if len(buffer) + len(line) + 1 > 1800 and buffer:
            blocks.append(make_text_block(buffer))
            buffer = ''

        if line.startswith('### '):
            if buffer:
                blocks.append(make_text_block(buffer))
                buffer = ''
            text = line[4:].strip()
            if text:
                blocks.append({'type': 'heading_3', 'heading_3': {
                    'rich_text': [{'type': 'text', 'text': {'content': text}}]}})
        elif line.startswith('## '):
            if buffer:
                blocks.append(make_text_block(buffer))
                buffer = ''
            text = line[3:].strip()
            if text:
                blocks.append({'type': 'heading_2', 'heading_2': {
                    'rich_text': [{'type': 'text', 'text': {'content': text}}]}})
        elif line.startswith('# '):
            if buffer:
                blocks.append(make_text_block(buffer))
                buffer = ''
            text = line[2:].strip()
            if text:
                blocks.append({'type': 'heading_1', 'heading_1': {
                    'rich_text': [{'type': 'text', 'text': {'content': text}}]}})
        elif line.strip() == '' and buffer:
            blocks.append(make_text_block(buffer))
            buffer = ''
        else:
            buffer += ('\n' if buffer else '') + line

    if buffer:
        blocks.append(make_text_block(buffer))

    return blocks

# ─── Notion 寫入 ───────────────────────────────────────────────────────────────

def has_existing_content(token, page_id):
    """檢查 Notion 頁面是否已有 children blocks"""
    url = f'https://api.notion.com/v1/blocks/{page_id}/children?page_size=1'
    resp = requests.get(url, headers=notion_headers(token))
    if resp.status_code != 200:
        return False
    data = resp.json()
    return len(data.get('results', [])) > 0

def inject_one(drive_service, token, drive_id, notion_page_id, file_name=''):
    """從 Drive 讀 .md，append blocks 到 Notion 頁面"""
    try:
        content = read_drive_file(drive_service, drive_id)
    except Exception as e:
        print(f'  ✗ Drive 讀取失敗 ({drive_id}): {e}')
        return False

    print(f'  Drive: {file_name or drive_id} ({len(content)} chars)')

    blocks = split_to_notion_blocks(content)
    if not blocks:
        print(f'  ✗ 無有效內容可寫入')
        return False

    print(f'  分割成 {len(blocks)} blocks，開始寫入 Notion...')

    url = f'https://api.notion.com/v1/blocks/{notion_page_id}/children'
    batch_size = 100

    for i in range(0, len(blocks), batch_size):
        batch = blocks[i:i + batch_size]
        resp = requests.patch(url, headers=notion_headers(token), json={'children': batch})
        if resp.status_code != 200:
            print(f'  ✗ Batch {i//batch_size + 1} 失敗: {resp.status_code} {resp.text[:300]}')
            return False
        print(f'  ✓ Batch {i//batch_size + 1}/{(len(blocks)-1)//batch_size + 1} OK ({len(batch)} blocks)')
        if i + batch_size < len(blocks):
            time.sleep(0.35)

    return True

# ─── Notion DB 查詢 ────────────────────────────────────────────────────────────

def query_all_pages(token):
    """查詢 DB 所有頁面，回傳 [(notion_page_id, drive_file_id, title), ...]"""
    pages = []
    has_more = True
    start_cursor = None

    while has_more:
        body = {'page_size': 100}
        if start_cursor:
            body['start_cursor'] = start_cursor

        resp = requests.post(
            f'https://api.notion.com/v1/databases/{NOTION_DB_ID}/query',
            headers=notion_headers(token),
            json=body
        )
        if resp.status_code != 200:
            raise RuntimeError(f'Notion DB query 失敗: {resp.status_code} {resp.text[:300]}')

        data = resp.json()
        for page in data.get('results', []):
            drive_id = ''
            title = ''
            try:
                drive_id = page['properties']['Drive檔案ID']['rich_text'][0]['plain_text']
            except (KeyError, IndexError):
                pass
            try:
                title = page['properties']['Name']['title'][0]['plain_text']
            except (KeyError, IndexError):
                pass
            if drive_id:
                pages.append((page['id'], drive_id, title))

        has_more = data.get('has_more', False)
        start_cursor = data.get('next_cursor')

    return pages

# ─── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--test', action='store_true', help='測試 3 筆')
    parser.add_argument('--all', action='store_true', help='灌全部 238 筆')
    parser.add_argument('--resume', action='store_true', help='跳過已有內容的頁面')
    args = parser.parse_args()

    if not args.test and not args.all:
        parser.print_help()
        sys.exit(1)

    print('載入認證...')
    creds = load_google_creds()
    drive_service = build('drive', 'v3', credentials=creds)
    notion_token = load_notion_token()
    print('認證完成\n')

    if args.test:
        print('=== 測試模式：3 筆 ===')
        success = 0
        for i, (drive_id, notion_id) in enumerate(TEST_CASES, 1):
            print(f'\n[{i}/3] Drive={drive_id} → Notion={notion_id}')
            # 取得檔名
            try:
                meta = drive_service.files().get(fileId=drive_id, fields='name').execute()
                fname = meta.get('name', '')
            except Exception:
                fname = ''
            ok = inject_one(drive_service, notion_token, drive_id, notion_id, fname)
            if ok:
                print(f'  ✅ 完成')
                success += 1
            else:
                print(f'  ❌ 失敗')
            time.sleep(0.5)

        print(f'\n=== 測試完成：{success}/3 成功 ===')

    elif args.all:
        print('查詢 Notion DB...')
        pages = query_all_pages(notion_token)
        print(f'共 {len(pages)} 筆有 Drive 檔案 ID\n')

        total = len(pages)
        success = 0
        skip = 0
        fail = 0

        for i, (notion_id, drive_id, title) in enumerate(pages, 1):
            print(f'[{i}/{total}] {title or notion_id[:8]}')

            if args.resume and has_existing_content(notion_token, notion_id):
                print(f'  ⏭ 已有內容，跳過')
                skip += 1
                continue

            # 取得檔名
            try:
                meta = drive_service.files().get(fileId=drive_id, fields='name').execute()
                fname = meta.get('name', '')
            except Exception:
                fname = drive_id

            ok = inject_one(drive_service, notion_token, drive_id, notion_id, fname)
            if ok:
                print(f'  ✅ 完成')
                success += 1
            else:
                print(f'  ❌ 失敗')
                fail += 1
            time.sleep(0.4)

        print(f'\n=== 全部完成 ===')
        print(f'成功：{success} | 跳過：{skip} | 失敗：{fail} | 總計：{total}')

if __name__ == '__main__':
    main()
