#!/usr/bin/env python3
"""
setup_liff_richmenu.py
用法：python3 setup_liff_richmenu.py <LIFF_ID> [<GAS_WEB_APP_URL>]

步驟：
1. LINE Developers → 選 Messaging API channel → LIFF 頁籤 → Add
   - Size: Tall
   - Endpoint URL: <GAS Web App URL>?page=liff
   - Scopes: profile, openid
2. 取得 LIFF ID（格式 liff.XXXXXXXXXX）
3. 執行本腳本：python3 setup_liff_richmenu.py liff.XXXXXXXXXX
"""
import sys, json, subprocess, os

LINE_TOKEN = 'jlUaHynLqf/u1MMcCpijOmGm9Wy8HXqWg0jPMSex1rLl9To5deZlWs5wIJFWrngDqD2LSRbtZgWb7kk/u2p3cuKpia0TdsShzFlATPOV2zFUoSegh1k/vMY6aA/fx02n9TfaBwEZTfLu3gz1dfBUwgdB04t89/1O/w1cDnyilFU='
GAS_URL = 'https://windsorya.github.io/lawyer-scripts/liff/'
IMAGE_PATH = '/tmp/richmenu2.png'
HEADERS = ['-H', f'Authorization: Bearer {LINE_TOKEN}', '-H', 'Content-Type: application/json']

def curl(method, url, data=None, extra_headers=None):
    cmd = ['curl', '-s', '-X', method, url] + HEADERS
    if extra_headers:
        for h in extra_headers:
            cmd += ['-H', h]
    if data:
        cmd += ['-d', json.dumps(data)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return json.loads(r.stdout) if r.stdout.strip() else {}

if len(sys.argv) < 2:
    print(__doc__)
    sys.exit(1)

LIFF_ID = sys.argv[1]
if len(sys.argv) >= 3:
    GAS_URL = sys.argv[2]

print(f'LIFF_ID: {LIFF_ID}')
print(f'GAS_URL: {GAS_URL}')

# ── 1. 刪除舊 Rich Menu ───────────────────────────────────────
print('\n[1] 取得現有 Rich Menu 清單...')
menus = curl('GET', 'https://api.line.me/v2/bot/richmenu/list')
for m in (menus.get('richmenus') or []):
    mid = m['richMenuId']
    print(f'    刪除 {mid}')
    curl('DELETE', f'https://api.line.me/v2/bot/richmenu/{mid}')

# ── 2. 建立新 Rich Menu（上排 LIFF，下排 message）──────────────
print('\n[2] 建立 Rich Menu（LIFF GPS 打卡）...')
body = {
  'size': {'width': 2500, 'height': 1686},
  'selected': True,
  'name': '王律行政系統 v2.3',
  'chatBarText': '功能選單',
  'areas': [
    {'bounds':{'x':0,   'y':0,   'width':833,'height':843},'action':{'type':'uri','uri':f'https://liff.line.me/{LIFF_ID}?type=checkin', 'label':'上班打卡'}},
    {'bounds':{'x':833, 'y':0,   'width':834,'height':843},'action':{'type':'uri','uri':f'https://liff.line.me/{LIFF_ID}?type=checkout','label':'下班打卡'}},
    {'bounds':{'x':1667,'y':0,   'width':833,'height':843},'action':{'type':'uri','uri':f'https://liff.line.me/{LIFF_ID}?type=field',   'label':'外勤打卡'}},
    {'bounds':{'x':0,   'y':843, 'width':833,'height':843},'action':{'type':'message','text':'請假',    'label':'請假'}},
    {'bounds':{'x':833, 'y':843, 'width':834,'height':843},'action':{'type':'message','text':'假別查詢','label':'假別查詢'}},
    {'bounds':{'x':1667,'y':843, 'width':833,'height':843},'action':{'type':'message','text':'補打卡',  'label':'補打卡'}},
  ]
}
result = curl('POST', 'https://api.line.me/v2/bot/richmenu', body)
menu_id = result.get('richMenuId')
if not menu_id:
    print(f'❌ 建立失敗：{result}')
    sys.exit(1)
print(f'    Rich Menu ID: {menu_id}')

# ── 3. 上傳圖片 ───────────────────────────────────────────────
if not os.path.exists(IMAGE_PATH):
    print(f'\n⚠️  圖片不存在：{IMAGE_PATH}')
    print('    請先執行 make_richmenu.py 重新生成圖片，或手動上傳')
else:
    print(f'\n[3] 上傳 Rich Menu 圖片...')
    img_cmd = [
        'curl', '-s', '-X', 'POST',
        f'https://api-data.line.me/v2/bot/richmenu/{menu_id}/content',
        '-H', f'Authorization: Bearer {LINE_TOKEN}',
        '-H', 'Content-Type: image/png',
        '--data-binary', f'@{IMAGE_PATH}',
    ]
    r = subprocess.run(img_cmd, capture_output=True, text=True)
    print(f'    回應：{r.stdout.strip() or "(空=成功)"}')

# ── 4. 設為預設選單 ───────────────────────────────────────────
print(f'\n[4] 設為預設 Rich Menu...')
r = curl('POST', f'https://api.line.me/v2/bot/user/all/richmenu/{menu_id}',
         extra_headers=['Content-Length: 0'])
print(f'    回應：{r}')

print(f'\n✅ 完成！Rich Menu ID: {menu_id}')
print(f'\n⚠️  記得更新 code.gs CONFIG.LIFF_ID = \'{LIFF_ID}\'，然後 clasp push + clasp deploy')
