#!/usr/bin/env python3
"""刪除 Google Drive 指定檔案"""
import json
import os
import sys

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

GOOGLE_KEYS_PATH = os.path.expanduser('~/.config/google-drive-mcp/gcp-oauth.keys.json')
GOOGLE_TOKENS_PATH = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')

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
        scopes=['https://www.googleapis.com/auth/drive'],
    )
    if creds.expired:
        creds.refresh(Request())
        # Save refreshed token
        tokens['access_token'] = creds.token
        with open(GOOGLE_TOKENS_PATH, 'w') as f:
            json.dump(tokens, f)
    return creds

# Files to delete (from screenshot)
SEARCH_QUERIES = [
    "移民黎生2019.8.23",
    "西貢中銀經",
    "main-source.zip",
    "23.108_偵_001841_DOC_001",
    "EBC 東森新聞 51 頻道",
]

def main():
    creds = load_google_creds()
    drive = build('drive', 'v3', credentials=creds)

    deleted = 0
    for query in SEARCH_QUERIES:
        # Escape single quotes in query
        safe_q = query.replace("'", "\\'")
        results = drive.files().list(
            q=f"name contains '{safe_q}' and trashed = false",
            fields="files(id, name, mimeType)",
            pageSize=10,
        ).execute()
        files = results.get('files', [])
        if not files:
            print(f"[NOT FOUND] {query}")
            continue
        for f in files:
            print(f"[DELETING] {f['name']} (id={f['id']}, type={f['mimeType']})")
            drive.files().delete(fileId=f['id']).execute()
            print(f"  ✓ Deleted")
            deleted += 1

    print(f"\nDone. Deleted {deleted} file(s).")

if __name__ == '__main__':
    main()
