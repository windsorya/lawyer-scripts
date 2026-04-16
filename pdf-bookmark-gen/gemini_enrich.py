"""
gemini_enrich.py — Gemini Enrich 模組
把書籤標題補充被告姓名、日期、案號等個案資訊。

用法：
    from gemini_enrich import enrich_bookmarks
    bookmarks = enrich_bookmarks(bookmarks, page_texts, case_hint='被告王志文 114偵字5678')
"""

import json
import os

from google import genai


def enrich_bookmarks(
    bookmarks: list[dict],
    page_texts: dict,
    case_hint: str = '',
) -> list[dict]:
    """
    補充書籤標題的個案資訊。

    Args:
        bookmarks:   [{'level': int, 'title': str, 'page': int}, ...]
        page_texts:  {page_no: str} — 每頁的前 300 字
        case_hint:   律師提供的案件提示，如「被告王志文 114年偵字第5678號」

    Returns:
        enrich 後的 bookmarks list（原 list 被 in-place 修改並回傳）
    """
    if not bookmarks:
        return bookmarks

    api_key = os.environ.get('GEMINI_API_KEY', '')
    if not api_key:
        print('[Enrich] GEMINI_API_KEY 未設定，跳過 Enrich')
        return bookmarks

    # 組 payload（只傳有文字內容的書籤）
    payload = []
    for b in bookmarks:
        ctx = page_texts.get(b['page'], '') if page_texts else ''
        payload.append({
            'page': b['page'],
            'title': b['title'],
            'context': ctx[:300],
        })

    prompt = f"""你是台灣法院電子卷證書籤審核員。
任務：根據每個書籤的頁面內容，補充被告/證人姓名、日期、案號等個案資訊到書籤標題。

案件提示：{case_hint if case_hint else '請從頁面內容自行判斷'}

規則：
1. 只回 JSON array，格式嚴格，不加 markdown code block
2. 每個書籤回傳 {{"page": int, "original": str, "enriched": str}}
3. enriched 格式：「原始標題（補充資訊）」，例如「訊問筆錄（被告王志文 114/03/15）」
4. 如果找不到可補充的資訊，enriched = original（完全一致，不加括號）
5. 不要自創書籤類型，只能補充括號內的資訊
6. 日期格式用 YYY/MM/DD（民國年）

書籤列表：
{json.dumps(payload, ensure_ascii=False, indent=2)}
"""

    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model='gemini-2.0-flash',
            contents=prompt,
        )
        text = response.text.strip()

        # 移除 Gemini 有時多包的 markdown code block
        if text.startswith('```'):
            lines = text.splitlines()
            text = '\n'.join(lines[1:])
            if text.endswith('```'):
                text = text[:-3].strip()

        results = json.loads(text)
        page_to_enriched: dict[int, str] = {r['page']: r['enriched'] for r in results}

        for b in bookmarks:
            enriched = page_to_enriched.get(b['page'])
            if enriched and enriched != b['title']:
                b['title'] = enriched

    except Exception as e:
        print(f'[Enrich] 失敗，維持原始書籤：{e}')

    return bookmarks
