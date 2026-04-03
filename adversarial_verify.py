#!/usr/bin/env python3
"""
adversarial_verify.py — 四 AI 對抗驗證系統
用法：
  python3 adversarial_verify.py --type criminal --input brief.txt
  echo "書狀內容" | python3 adversarial_verify.py -t civil
  python3 adversarial_verify.py -t admin --input brief.txt --output report.txt
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

# ─────────────────────────────────────────────
# 對抗 Prompt 模板
# ─────────────────────────────────────────────

PROMPTS = {
    "criminal": {
        "gemini": (
            "你是一位資深台灣檢察官，正在審閱辯護人提出的書狀。"
            "請逐點拆解書狀論述，針對每一個論點找出法律漏洞、事實矛盾、或舉證不足之處。"
            "格式：條列式，每點先引用書狀原文再提出攻擊論點。"
            "用語嚴謹，引用台灣刑事訴訟法、刑法及相關判決。全繁體中文。"
        ),
        "openai": (
            "你是台灣地檢署的公訴檢察官。請針對以下辯護書狀，撰寫一份結構化的論告意見書。"
            "格式：壹、案件概要 / 貳、辯護論點逐一反駁 / 參、本署立場 / 肆、結論。"
            "語氣正式，引用相關法條與最高法院見解。全繁體中文。"
        ),
        "grok": (
            "你是一個毒舌但精準的刑事訴訟專家。請用直白的語言找出這份辯護書狀的致命傷。"
            "不用客氣，哪裡最弱就打哪裡。列出 TOP 3 致命漏洞，每個漏洞說明為什麼對被告不利。"
            "最後給這份書狀打個分數（0-100）並說明扣分原因。全繁體中文。"
        ),
        "claude": (
            "你是台灣地方法院的刑事庭法官，正在審閱辯護書狀。"
            "請從法官視角評估：1) 書狀論述說服力（1-10分）2) 法律引用正確性 3) 事實主張完整性 "
            "4) 如果你是法官，書狀中哪些論點會讓你認真考量？哪些你會直接忽略？"
            "5) 最後給出整體評分與改進建議。全繁體中文、台灣法律體系。"
        ),
    },
    "civil": {
        "gemini": (
            "你是對造的台灣民事律師，正在研究原告/被告的書狀準備提出反駁。"
            "請逐點針對書狀每一個論述提出對造立場的答辯，找出邏輯矛盾、舉證瑕疵與法律適用錯誤。"
            "引用民法、民事訴訟法及相關實務見解。全繁體中文。"
        ),
        "openai": (
            "你是台灣民事訴訟的對造代理律師。請針對以下書狀，起草一份正式答辯狀。"
            "格式：壹、聲明 / 貳、陳述（逐一反駁書狀各項主張）/ 參、法律意見 / 肆、結論。"
            "語氣正式，引用民法、民事訴訟法條文。全繁體中文。"
        ),
        "grok": (
            "你是民事訴訟的犀利評論人。請用直白語言找出這份書狀的三大致命漏洞，"
            "說明為什麼法官可能不採納這些主張，並給書狀打分數（0-100）說明理由。全繁體中文。"
        ),
        "claude": (
            "你是台灣地方法院民事庭法官，審閱以下書狀。"
            "請評估：1) 書狀說服力（1-10分）2) 舉證責任是否達標 3) 法律關係建構是否完整 "
            "4) 哪些主張會被採納、哪些會被駁回 5) 整體評分與改進方向。全繁體中文。"
        ),
    },
    "admin": {
        "gemini": (
            "你是行政機關的法制單位代理人，正在研究行政訴訟原告的書狀。"
            "請逐點反駁書狀論述，從機關立場說明處分合法性、裁量正確性，"
            "引用行政程序法、相關特別法與行政法院判決。全繁體中文。"
        ),
        "openai": (
            "你是行政訴訟中代理機關的律師，請針對原告書狀起草答辯狀。"
            "格式：壹、聲明 / 貳、事實陳述 / 參、法律意見（逐點反駁）/ 肆、結論。"
            "引用行政訴訟法、行政程序法相關條文。全繁體中文。"
        ),
        "grok": (
            "你是行政法的犀利評論人。請直接指出這份行政訴訟書狀的三大罩門，"
            "說明機關答辯時如何利用這些弱點，並給書狀打分數（0-100）。全繁體中文。"
        ),
        "claude": (
            "你是台灣高等行政法院法官，審閱以下書狀。"
            "請評估：1) 書狀說服力（1-10分）2) 行政處分違法性論述是否充分 "
            "3) 程序與實體主張是否完整 4) 哪些主張有機會獲勝 5) 整體評分與改進方向。全繁體中文。"
        ),
    },
}

AI_LABELS = {
    "gemini": "Gemini 2.5 Pro",
    "openai": "GPT-5.2",
    "grok":   "Grok 4",
    "claude": "Claude Opus 4.6",
}

ROLE_LABELS = {
    "criminal": {
        "gemini": "檢察官逐點拆解",
        "openai": "結構化論告意見",
        "grok":   "致命傷分析",
        "claude": "法官評分",
    },
    "civil": {
        "gemini": "對造律師反駁",
        "openai": "答辯狀草稿",
        "grok":   "致命漏洞分析",
        "claude": "法官評分",
    },
    "admin": {
        "gemini": "機關代理人反駁",
        "openai": "答辯狀草稿",
        "grok":   "致命漏洞分析",
        "claude": "法官評分",
    },
}

# ─────────────────────────────────────────────
# API 呼叫函式（純 urllib）
# ─────────────────────────────────────────────

def _post_json(url, headers, body, timeout=120):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def call_gemini(system_prompt, brief_text):
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        return None, "GEMINI_API_KEY 未設定"
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-2.5-pro:generateContent?key={api_key}"
    )
    headers = {"Content-Type": "application/json"}
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": f"{system_prompt}\n\n【書狀內容】\n{brief_text}"}],
            }
        ],
        "generationConfig": {"temperature": 0.7},
    }
    try:
        resp = _post_json(url, headers, body)
        text = resp["candidates"][0]["content"]["parts"][0]["text"]
        return text, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:300]}"
    except Exception as e:
        return None, str(e)


def call_openai(system_prompt, brief_text):
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        return None, "OPENAI_API_KEY 未設定"
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    body = {
        "model": "gpt-5.2",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"【書狀內容】\n{brief_text}"},
        ],
        "max_completion_tokens": 4096,
        "temperature": 0.7,
    }
    try:
        resp = _post_json(url, headers, body)
        text = resp["choices"][0]["message"]["content"]
        return text, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:300]}"
    except Exception as e:
        return None, str(e)


def call_grok(system_prompt, brief_text):
    api_key = os.environ.get("XAI_API_KEY", "")
    if not api_key:
        return None, "XAI_API_KEY 未設定"
    url = "https://api.x.ai/v1/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    body = {
        "model": "grok-4",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"【書狀內容】\n{brief_text}"},
        ],
        "temperature": 0.7,
    }
    try:
        resp = _post_json(url, headers, body)
        text = resp["choices"][0]["message"]["content"]
        return text, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:300]}"
    except Exception as e:
        return None, str(e)


def call_claude(system_prompt, brief_text):
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None, "ANTHROPIC_API_KEY 未設定"
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    body = {
        "model": "claude-opus-4-6",
        "max_tokens": 4096,
        "system": system_prompt,
        "messages": [
            {"role": "user", "content": f"【書狀內容】\n{brief_text}"},
        ],
    }
    try:
        resp = _post_json(url, headers, body)
        text = resp["content"][0]["text"]
        return text, None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode()[:300]}"
    except Exception as e:
        return None, str(e)


CALLERS = {
    "gemini": call_gemini,
    "openai": call_openai,
    "grok":   call_grok,
    "claude": call_claude,
}

# ─────────────────────────────────────────────
# 威脅等級偵測（從回應文字自動標註）
# ─────────────────────────────────────────────

def detect_threat_level(text: str, ai_key: str) -> str:
    """根據 Grok 分數或關鍵字判斷威脅等級。"""
    if ai_key == "grok":
        import re
        m = re.search(r"(\d{1,3})\s*(?:分|／100|/100)", text)
        if m:
            score = int(m.group(1))
            if score < 50:
                return "🔴 致命"
            elif score < 75:
                return "🟡 中度"
            else:
                return "🟢 輕微"
    # 通用關鍵字
    fatal_kw   = ["致命", "無法採信", "嚴重瑕疵", "根本違誤", "完全不採", "直接駁回"]
    medium_kw  = ["值得注意", "仍有疑慮", "論述不足", "補強", "漏洞", "可疑"]
    for kw in fatal_kw:
        if kw in text:
            return "🔴 致命"
    for kw in medium_kw:
        if kw in text:
            return "🟡 中度"
    return "🟢 輕微"


# ─────────────────────────────────────────────
# 報告組裝
# ─────────────────────────────────────────────

TYPE_NAMES = {"criminal": "刑事", "civil": "民事", "admin": "行政訴訟"}

def build_report(brief_type: str, results: dict) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    type_name = TYPE_NAMES.get(brief_type, brief_type)
    lines = [
        "=" * 60,
        f"  四 AI 對抗驗證報告｜{type_name}書狀｜{now}",
        "=" * 60,
        "",
    ]
    order = ["gemini", "openai", "grok", "claude"]
    for key in order:
        ai_label   = AI_LABELS[key]
        role_label = ROLE_LABELS[brief_type][key]
        text, err  = results.get(key, (None, "未執行"))

        lines.append(f"{'─' * 60}")
        lines.append(f"【{ai_label}】— {role_label}")

        if err:
            lines.append(f"❌ 錯誤：{err}")
        else:
            threat = detect_threat_level(text, key)
            lines.append(f"威脅等級：{threat}")
            lines.append("")
            lines.append(text.strip())

        lines.append("")

    lines += [
        "=" * 60,
        "  報告結束",
        "=" * 60,
    ]
    return "\n".join(lines)


# ─────────────────────────────────────────────
# 主程式
# ─────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="四 AI 對抗驗證系統｜台灣法律書狀分析"
    )
    parser.add_argument(
        "-t", "--type",
        choices=["criminal", "civil", "admin"],
        required=True,
        help="書狀類型：criminal（刑事）/ civil（民事）/ admin（行政訴訟）",
    )
    parser.add_argument(
        "-i", "--input",
        help="書狀檔案路徑（.txt）；未指定則從 stdin 讀取",
    )
    parser.add_argument(
        "-o", "--output",
        help="報告輸出路徑（未指定則印到 stdout）",
    )
    args = parser.parse_args()

    # 讀取書狀內容
    if args.input:
        try:
            with open(args.input, encoding="utf-8") as f:
                brief_text = f.read().strip()
        except FileNotFoundError:
            print(f"❌ 找不到檔案：{args.input}", file=sys.stderr)
            sys.exit(1)
    else:
        if sys.stdin.isatty():
            print("請輸入書狀內容（Ctrl+D 結束）：", file=sys.stderr)
        brief_text = sys.stdin.read().strip()

    if not brief_text:
        print("❌ 書狀內容為空", file=sys.stderr)
        sys.exit(1)

    brief_type = args.type
    prompts = PROMPTS[brief_type]

    print(f"⏳ 平行呼叫四個 AI（{TYPE_NAMES[brief_type]}書狀）…", file=sys.stderr)

    results = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        future_map = {
            executor.submit(CALLERS[key], prompts[key], brief_text): key
            for key in ["gemini", "openai", "grok", "claude"]
        }
        for future in as_completed(future_map):
            key = future_map[future]
            text, err = future.result()
            results[key] = (text, err)
            label = AI_LABELS[key]
            status = "✅" if text else "❌"
            print(f"  {status} {label} 完成", file=sys.stderr)

    report = build_report(brief_type, results)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"✅ 報告已存至：{args.output}", file=sys.stderr)
    else:
        print(report)


if __name__ == "__main__":
    main()
