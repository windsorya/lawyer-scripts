#!/usr/bin/env python3
"""
卷證頁碼驗證工具
================
抽樣比對 _REF.txt 的頁碼標記與 PDF 實際頁面文字，確認頁碼對齊。

使用方式：
  python3 verify_page_refs.py /path/to/卷冊名_REF.txt /path/to/卷冊名.pdf
  python3 verify_page_refs.py /path/to/卷冊名_REF.txt /path/to/卷冊名.pdf --samples 10
"""

import pdfplumber
import os
import sys
import re
import random


def parse_ref_txt(txt_path):
    """解析 _REF.txt，提取每個 [REF:] 標記及其對應文字"""
    ref_pattern = re.compile(r'\[REF:(.+?)\|p\.(\d+)\]')

    entries = []  # [(volume_name, court_page, text_snippet)]
    current_ref = None
    current_text_lines = []

    with open(txt_path, 'r', encoding='utf-8') as f:
        for line in f:
            m = ref_pattern.match(line.strip())
            if m:
                # 儲存前一筆
                if current_ref is not None:
                    text = '\n'.join(current_text_lines).strip()
                    entries.append((current_ref[0], current_ref[1], text))
                current_ref = (m.group(1), int(m.group(2)))
                current_text_lines = []
            elif current_ref is not None:
                # 遇到其他標記就結束當前 entry
                if line.strip().startswith('[') and not line.strip().startswith('[REF:'):
                    text = '\n'.join(current_text_lines).strip()
                    entries.append((current_ref[0], current_ref[1], text))
                    current_ref = None
                    current_text_lines = []
                else:
                    current_text_lines.append(line.rstrip())

    # 最後一筆
    if current_ref is not None:
        text = '\n'.join(current_text_lines).strip()
        entries.append((current_ref[0], current_ref[1], text))

    return entries


def extract_pdf_page_text(pdf_path, pdf_page_num):
    """從 PDF 萃取指定頁面的文字（pdf_page_num 從 1 開始）"""
    with pdfplumber.open(pdf_path) as pdf:
        if pdf_page_num < 1 or pdf_page_num > len(pdf.pages):
            return None
        text = pdf.pages[pdf_page_num - 1].extract_text() or ''
        return text.strip()


def text_similarity(text_a, text_b):
    """簡易文字相似度：共同行數比例"""
    if not text_a or not text_b:
        return 0.0
    lines_a = set(line.strip() for line in text_a.split('\n') if line.strip())
    lines_b = set(line.strip() for line in text_b.split('\n') if line.strip())
    if not lines_a or not lines_b:
        return 0.0
    common = lines_a & lines_b
    return len(common) / max(len(lines_a), len(lines_b))


def guess_pdf_page(court_page, mode, court_start):
    """根據模式推算法院頁碼對應的 PDF 頁碼"""
    if mode == 'consecutive':
        return court_start + court_page - 1
    else:  # interleaved
        return court_start + (court_page - 1) * 2


def verify(txt_path, pdf_path, num_samples=5):
    """主驗證流程"""
    print(f"📄 TXT：{os.path.basename(txt_path)}")
    print(f"📕 PDF：{os.path.basename(pdf_path)}")

    entries = parse_ref_txt(txt_path)
    if not entries:
        print("❌ 未在 TXT 中找到任何 [REF:] 標記")
        return

    print(f"📊 TXT 中共有 {len(entries)} 個 [REF:] 頁碼標記")
    print(f"   法院頁碼範圍：p.{entries[0][1]} ~ p.{entries[-1][1]}")

    # 檢查頁碼連續性
    pages = [e[1] for e in entries]
    gaps = []
    for i in range(1, len(pages)):
        if pages[i] != pages[i-1] + 1:
            gaps.append((pages[i-1], pages[i]))

    if gaps:
        print(f"\n⚠️  頁碼有 {len(gaps)} 處不連續：")
        for a, b in gaps[:10]:
            print(f"   p.{a} → p.{b}（跳了 {b - a - 1} 頁）")
    else:
        print(f"✅ 頁碼連續遞增，無跳號")

    # 取得 PDF 總頁數
    with pdfplumber.open(pdf_path) as pdf:
        total_pdf_pages = len(pdf.pages)
    print(f"📕 PDF 共 {total_pdf_pages} 頁")

    # 嘗試推算模式和起始頁：用第一頁的文字去 PDF 各頁比對
    print(f"\n{'='*50}")
    print(f"🔍 抽樣比對（{num_samples} 頁）")
    print(f"{'='*50}")

    # 先用第1頁找出起始頁和模式
    first_entry = entries[0]
    first_text = first_entry[2][:200]  # 取前200字比對

    best_match_page = None
    best_match_score = 0
    for pdf_page in range(1, min(total_pdf_pages + 1, 40)):
        pdf_text = extract_pdf_page_text(pdf_path, pdf_page)
        if pdf_text and first_text:
            score = text_similarity(first_entry[2], pdf_text)
            if score > best_match_score:
                best_match_score = score
                best_match_page = pdf_page

    if best_match_page is None or best_match_score < 0.3:
        print("⚠️  無法自動定位第1頁在 PDF 中的位置，改用全頁掃描比對")
        best_match_page = 1

    court_start = best_match_page
    # 判斷模式：看第2頁在 PDF 的哪裡
    detected_mode = 'consecutive'
    if len(entries) >= 2:
        second_text = entries[1][2]
        # 嘗試 consecutive: 下一頁
        consec_page = court_start + 1
        # 嘗試 interleaved: 隔一頁
        interleaved_page = court_start + 2

        score_c = 0
        score_i = 0
        if consec_page <= total_pdf_pages:
            pdf_text_c = extract_pdf_page_text(pdf_path, consec_page)
            score_c = text_similarity(second_text, pdf_text_c) if pdf_text_c else 0
        if interleaved_page <= total_pdf_pages:
            pdf_text_i = extract_pdf_page_text(pdf_path, interleaved_page)
            score_i = text_similarity(second_text, pdf_text_i) if pdf_text_i else 0

        if score_i > score_c and score_i > 0.3:
            detected_mode = 'interleaved'

    mode_label = "連續" if detected_mode == "consecutive" else "隔頁"
    print(f"\n   推測模式：{mode_label}，起始 PDF 頁：{court_start}")

    # 抽樣比對
    sample_indices = sorted(random.sample(
        range(len(entries)),
        min(num_samples, len(entries))
    ))

    match_count = 0
    mismatch_count = 0

    for idx in sample_indices:
        vol, court_page, txt_text = entries[idx]
        pdf_page = guess_pdf_page(court_page, detected_mode, court_start)

        if pdf_page < 1 or pdf_page > total_pdf_pages:
            print(f"\n   ❌ p.{court_page} → PDF 第 {pdf_page} 頁（超出範圍）")
            mismatch_count += 1
            continue

        pdf_text = extract_pdf_page_text(pdf_path, pdf_page)
        score = text_similarity(txt_text, pdf_text)

        # 取文字前80字作預覽
        txt_preview = txt_text[:80].replace('\n', ' ') if txt_text else '(空)'
        pdf_preview = pdf_text[:80].replace('\n', ' ') if pdf_text else '(空)'

        if score >= 0.5:
            status = "✅"
            match_count += 1
        elif score >= 0.3:
            status = "⚠️ "
            match_count += 1
        else:
            status = "❌"
            mismatch_count += 1

        print(f"\n   {status} 法院 p.{court_page} → PDF 第 {pdf_page} 頁（相似度 {score:.0%}）")
        print(f"      TXT：{txt_preview}")
        print(f"      PDF：{pdf_preview}")

    # 結論
    print(f"\n{'='*50}")
    total_checked = match_count + mismatch_count
    if mismatch_count == 0:
        print(f"✅ 驗證通過！{total_checked}/{total_checked} 頁比對一致")
    else:
        print(f"⚠️  {mismatch_count}/{total_checked} 頁比對不一致，頁碼可能有偏移")
    print(f"{'='*50}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("卷證頁碼驗證工具")
        print()
        print("用法：")
        print("  python3 verify_page_refs.py <卷冊_REF.txt> <卷冊.pdf>")
        print("  python3 verify_page_refs.py <卷冊_REF.txt> <卷冊.pdf> --samples 10")
        sys.exit(0)

    txt_file = sys.argv[1]
    pdf_file = sys.argv[2]

    num_samples = 5
    if '--samples' in sys.argv:
        idx = sys.argv.index('--samples')
        if idx + 1 < len(sys.argv):
            num_samples = int(sys.argv[idx + 1])

    if not os.path.exists(txt_file):
        print(f"❌ 找不到 TXT 檔：{txt_file}")
        sys.exit(1)
    if not os.path.exists(pdf_file):
        print(f"❌ 找不到 PDF 檔：{pdf_file}")
        sys.exit(1)

    try:
        import pdfplumber
    except ImportError:
        print("❌ pdfplumber 未安裝。請執行：")
        print("   pip3 install pdfplumber --break-system-packages")
        sys.exit(1)

    verify(txt_file, pdf_file, num_samples)
