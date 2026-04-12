#!/usr/bin/env python3
"""
批次更新 Notion DB 所有頁面，加上「領域」欄位值為 ["睡眠"]
DB ID: b1be855c33b3401b993a4a2458adb94e
"""

import os
import time
import requests

NOTION_VERSION = "2022-06-28"
DB_ID = "b1be855c33b3401b993a4a2458adb94e"
INTERVAL = 0.35  # 350ms


def load_token():
    token = os.environ.get("NOTION_TOKEN") or os.environ.get("NOTION_API_KEY")
    if not token:
        config_path = os.path.expanduser("~/JudicialData/config.env")
        if os.path.exists(config_path):
            with open(config_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("NOTION_API_KEY="):
                        token = line.split("=", 1)[1]
                        break
    if not token:
        raise RuntimeError("找不到 Notion token")
    return token


def query_all_pages(token):
    url = f"https://api.notion.com/v1/databases/{DB_ID}/query"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    pages = []
    cursor = None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        resp = requests.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()
        pages.extend(data.get("results", []))
        print(f"  已取得 {len(pages)} 筆...")
        if data.get("has_more"):
            cursor = data["next_cursor"]
            time.sleep(INTERVAL)
        else:
            break
    return pages


def update_page(token, page_id):
    url = f"https://api.notion.com/v1/pages/{page_id}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    body = {
        "properties": {
            "領域": {
                "multi_select": [{"name": "睡眠"}]
            }
        }
    }
    resp = requests.patch(url, headers=headers, json=body)
    return resp.status_code, resp.text


def main():
    token = load_token()
    print("Step 1：取得所有頁面...")
    pages = query_all_pages(token)
    total = len(pages)
    print(f"共 {total} 筆頁面，開始更新...\n")

    success = 0
    failed = []

    for i, page in enumerate(pages, 1):
        page_id = page["id"]
        status_code, body = update_page(token, page_id)
        if status_code == 200:
            success += 1
        else:
            failed.append((page_id, status_code, body[:200]))
        if i % 20 == 0 or i == total:
            print(f"  進度 {i}/{total}｜成功 {success}｜失敗 {len(failed)}")
        time.sleep(INTERVAL)

    print(f"\n完成！成功 {success} 筆 / 失敗 {len(failed)} 筆")
    if failed:
        print("\n失敗清單：")
        for pid, code, msg in failed:
            print(f"  {pid}  HTTP {code}  {msg}")


if __name__ == "__main__":
    main()
