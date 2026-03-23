#!/usr/bin/env python3
"""
卷證頁碼標記注入工具（法院蓋印頁碼版・全自動）
==================================================
直接從 PDF 逐頁萃取文字，注入 [REF:卷冊名|p.法院頁碼] 標記。

全自動偵測：
  1. 找出「高-低文字量交替」的轉折點 → 正文起始頁
  2. 從起始頁分析奇偶頁文字量 → 連續 or 隔頁模式

使用方式：
  python3 inject_page_refs.py /path/to/卷證資料夾 [被告姓名]
"""

import pdfplumber
import os
import sys
import re
import json


def simplify_name(filename):
    """去掉副檔名和 _OCR 後綴"""
    name = os.path.splitext(filename)[0]
    name = re.sub(r'_OCR$', '', name)
    return name


def clean_watermark(text):
    """移除浮水印文字，回傳清理後的文字長度"""
    if not text:
        return 0
    clean = text
    clean = re.sub(r'王志文', '', clean)
    clean = re.sub(r'司法院線上閱卷系統作業平台', '', clean)
    clean = re.sub(r'\d{3}/\d{2}/\d{2}', '', clean)   # 日期如 115/03/12
    clean = re.sub(r'\d{2}:\d{2}:\d{2}', '', clean)   # 時間如 09:47:49
    return len(clean.strip())


def has_legal_terms(text):
    """檢查文字是否包含中文法律用語"""
    if not text:
        return False
    legal_terms = [
        '被告', '原告', '告訴人', '證人', '辯護人', '檢察官',
        '法院', '法官', '審判', '偵查', '起訴', '判決',
        '犯罪', '刑法', '刑事', '民事', '自訴', '公訴',
        '筆錄', '證據', '事實', '理由', '主文', '聲請',
        '羈押', '保釋', '傳喚', '訊問', '調查', '鑑定',
        '送達', '通知', '裁定', '上訴', '抗告', '移送',
    ]
    return any(term in text for term in legal_terms)


def detect_config(pdf_path):
    """
    多階段偵測：
    Phase 1: 掃描頁面文字量
    Phase 2: 空白頁密度與奇偶分布（跳過封面區，用 p30+ 分析）
    Phase 3: 「第X頁（共Y頁）」起始頁定位
    Phase 4: 正面文字量跳升偵測起始頁
    Phase 5: 連續模式驗證（防誤判）
    """
    page_lengths = []   # clean_watermark 後的文字量
    page_texts = []     # 原始文字

    with pdfplumber.open(pdf_path) as pdf:
        total_pages = len(pdf.pages)
        scan_count = min(120, total_pages)

        for i in range(scan_count):
            text = pdf.pages[i].extract_text() or ''
            length = clean_watermark(text)
            page_lengths.append(length)
            page_texts.append(text)

    BLANK_THRESHOLD = 30  # ≤30 chars = 純浮水印空白頁

    # ============================================================
    # Phase 1：空白頁密度與奇偶分布（用 p30+ 避開封面干擾）
    # ============================================================
    detected_mode = None
    detected_start = 1
    content_on_odd = True  # 預設：正面在奇數頁

    ANALYSIS_START = min(29, len(page_lengths) - 1)  # 從第30頁開始分析

    odd_blanks = 0   # 奇數頁中的空白頁數
    even_blanks = 0  # 偶數頁中的空白頁數
    for i in range(ANALYSIS_START, len(page_lengths)):
        if page_lengths[i] <= BLANK_THRESHOLD:
            if (i + 1) % 2 == 1:
                odd_blanks += 1
            else:
                even_blanks += 1

    total_blanks = odd_blanks + even_blanks
    analysis_pages = len(page_lengths) - ANALYSIS_START
    blank_density = total_blanks / analysis_pages if analysis_pages > 0 else 0

    # 空白頁集中度：多少比例的空白頁在同一邊
    if total_blanks >= 5:
        parity_concentration = max(odd_blanks, even_blanks) / total_blanks
        content_on_odd = even_blanks > odd_blanks
    else:
        parity_concentration = 0

    # 判定隔頁模式：空白密度 ≥ 30% 且集中在一邊 ≥ 85%
    if blank_density >= 0.30 and parity_concentration >= 0.85:
        detected_mode = 'interleaved'

    # ============================================================
    # Phase 2：「第X頁（共Y頁）」起始頁定位
    # ============================================================
    page_ref_pattern = re.compile(r'第\s*(\d+)\s*頁[（(]共\s*(\d+)\s*頁[）)]')

    if detected_mode == 'interleaved':
        # 搜尋「第1頁」標記來精確定位起始頁
        first_page_marker = None
        for i, text in enumerate(page_texts):
            m = page_ref_pattern.search(text)
            if m and int(m.group(1)) == 1:
                first_page_marker = i + 1  # PDF 頁碼
                break

        if first_page_marker is not None:
            detected_start = first_page_marker
        else:
            # 找任何有「第X頁」的頁面，回推起始頁
            for i, text in enumerate(page_texts):
                m = page_ref_pattern.search(text)
                if m:
                    page_num = int(m.group(1))
                    pdf_page = i + 1
                    # 在隔頁模式中，第 N 頁在 PDF 中的位置 = start + (N-1)*2
                    candidate_start = pdf_page - (page_num - 1) * 2
                    if candidate_start >= 1:
                        detected_start = candidate_start
                    break

    # ============================================================
    # Phase 3：正面文字量跳升偵測起始頁（無「第X頁」時的備援）
    # ============================================================
    if detected_mode == 'interleaved' and detected_start == 1:
        # 掃描正面頁（根據 content_on_odd 判斷奇偶），
        # 找「文字量明顯跳升」的轉折點
        front_pages = []  # (pdf_page, length)
        for i in range(len(page_lengths)):
            pdf_page = i + 1
            is_front = (pdf_page % 2 == 1) if content_on_odd else (pdf_page % 2 == 0)
            if is_front:
                front_pages.append((pdf_page, page_lengths[i]))

        # 用前幾頁正面的滾動平均，找跳升點
        if len(front_pages) >= 4:
            for idx in range(2, len(front_pages)):
                prev_avg = sum(fp[1] for fp in front_pages[:idx]) / idx
                curr_len = front_pages[idx][1]
                if prev_avg > 0 and curr_len > prev_avg * 2.0 and curr_len > 500:
                    detected_start = front_pages[idx][0]
                    break

    # ============================================================
    # Phase 3.5：短段乾淨交替偵測（背面≤30的嚴格匹配）
    # ============================================================
    # 有些卷的背面 OCR 雜訊很高，導致 Phase 1 的空白密度偵測失敗，
    # 但在前段（封面之後）仍有 3+ 對乾淨的「正面>150 + 背面≤30」交替。
    if detected_mode is None:
        for start_i in range(4, min(20, len(page_lengths) - 1)):
            # 嘗試 hi-lo（正面在前）
            clean_pairs = 0
            for p in range(start_i, len(page_lengths) - 1, 2):
                if page_lengths[p] > 150 and page_lengths[p + 1] <= BLANK_THRESHOLD:
                    clean_pairs += 1
                else:
                    break
            if clean_pairs >= 3:
                detected_mode = 'interleaved'
                detected_start = start_i + 1  # PDF 頁碼
                break

            # 嘗試 lo-hi（正面在後）
            clean_pairs = 0
            for p in range(start_i, len(page_lengths) - 1, 2):
                if page_lengths[p + 1] > 150 and page_lengths[p] <= BLANK_THRESHOLD:
                    clean_pairs += 1
                else:
                    break
            if clean_pairs >= 3:
                detected_mode = 'interleaved'
                detected_start = start_i + 2  # PDF 頁碼（正面在後一頁）
                break

    # ============================================================
    # Phase 4：封面區交替偵測（處理封面假交替的情況）
    # ============================================================
    # 如果 Phase 1 沒偵測到隔頁（空白密度不夠或集中度不夠），
    # 嘗試用嚴格交替偵測（需連續10對+穩定性）
    if detected_mode is None:
        LOW_THRESHOLD = 80
        MIN_CONSECUTIVE_PAIRS = 10

        best_alt_start = None
        best_alt_count = 0
        best_alt_direction = None

        for start_i in range(len(page_lengths) - 1):
            # 嘗試 hi-lo 方向
            hi_lo_count = 0
            for p in range(start_i, len(page_lengths) - 1, 2):
                a = page_lengths[p]
                b = page_lengths[p + 1]
                if a > 150 and b < LOW_THRESHOLD:
                    hi_lo_count += 1
                else:
                    break
            if hi_lo_count > best_alt_count:
                best_alt_count = hi_lo_count
                best_alt_start = start_i
                best_alt_direction = 'hi_lo'

            # 嘗試 lo-hi 方向
            lo_hi_count = 0
            for p in range(start_i, len(page_lengths) - 1, 2):
                a = page_lengths[p]
                b = page_lengths[p + 1]
                if b > 150 and a < LOW_THRESHOLD:
                    lo_hi_count += 1
                else:
                    break
            if lo_hi_count > best_alt_count:
                best_alt_count = lo_hi_count
                best_alt_start = start_i
                best_alt_direction = 'lo_hi'

        if best_alt_count >= MIN_CONSECUTIVE_PAIRS:
            # 驗證：如果起始頁 < 15，確認交替持續到至少第50頁
            candidate_start_page = best_alt_start + 1
            if candidate_start_page < 15:
                pairs_past_50 = 0
                for p in range(best_alt_start, len(page_lengths) - 1, 2):
                    if p + 1 >= 49:  # 第50頁之後
                        a = page_lengths[p]
                        b = page_lengths[p + 1]
                        if best_alt_direction == 'hi_lo' and a > 150 and b < LOW_THRESHOLD:
                            pairs_past_50 += 1
                        elif best_alt_direction == 'lo_hi' and b > 150 and a < LOW_THRESHOLD:
                            pairs_past_50 += 1
                if pairs_past_50 < 3:
                    best_alt_count = 0

            # 驗證：低頁平均文字量必須穩定低
            if best_alt_count >= MIN_CONSECUTIVE_PAIRS:
                low_vals = []
                for p in range(best_alt_start, min(best_alt_start + best_alt_count * 2, len(page_lengths)), 2):
                    if best_alt_direction == 'hi_lo' and p + 1 < len(page_lengths):
                        low_vals.append(page_lengths[p + 1])
                    elif best_alt_direction == 'lo_hi':
                        low_vals.append(page_lengths[p])
                if low_vals and sum(low_vals) / len(low_vals) > LOW_THRESHOLD:
                    best_alt_count = 0

        if best_alt_count >= MIN_CONSECUTIVE_PAIRS:
            detected_mode = 'interleaved'
            if best_alt_direction == 'hi_lo':
                detected_start = best_alt_start + 1
            else:
                detected_start = best_alt_start + 2

    # ============================================================
    # Phase 5：連續模式驗證（防止連續被誤判為隔頁）
    # ============================================================
    if detected_mode == 'interleaved':
        # 從第40頁之後抽查「背面」頁（避開前段可能有OCR雜訊的文件區段）
        # 用 detected_start 的奇偶性判斷哪些是背面
        start_idx = detected_start - 1
        check_from = max(start_idx, 39)  # 至少從第40頁開始

        back_pages_checked = 0
        back_pages_with_content = 0
        for i in range(check_from, min(check_from + 40, len(page_texts))):
            offset = i - start_idx
            if offset % 2 == 1:  # 「應該是背面」的頁
                clean_len = clean_watermark(page_texts[i])
                if clean_len > 150 and has_legal_terms(page_texts[i]):
                    back_pages_with_content += 1
                back_pages_checked += 1
                if back_pages_checked >= 5:
                    break

        if back_pages_checked >= 3 and back_pages_with_content >= 3:
            detected_mode = 'consecutive'

    if detected_mode is None:
        detected_mode = 'consecutive'

    # 連續模式：起始頁預設為 1（法院卷證通常從第一頁開始編號）
    if detected_mode == 'consecutive':
        detected_start = 1

    return detected_start, detected_mode, total_pages


def extract_and_inject(pdf_path, court_start, mode, volume_name):
    """從 PDF 逐頁萃取文字，插入 [REF:] 標記。"""
    result_lines = []
    total_pages = 0
    pages_with_text = 0
    court_page = 0

    with pdfplumber.open(pdf_path) as pdf:
        total_pages = len(pdf.pages)

        for i, page in enumerate(pdf.pages):
            pdf_page = i + 1
            text = page.extract_text()

            if not text or not text.strip():
                continue

            pages_with_text += 1

            if pdf_page < court_start:
                result_lines.append(f"[前置頁:{volume_name}|PDF.p.{pdf_page}]\n")
                result_lines.append(text.strip() + "\n\n")
            elif mode == 'consecutive':
                court_page = pdf_page - (court_start - 1)
                result_lines.append(f"[REF:{volume_name}|p.{court_page}]\n")
                result_lines.append(text.strip() + "\n\n")
            else:
                pages_from_start = pdf_page - court_start
                if pages_from_start % 2 == 0:
                    court_page = (pages_from_start // 2) + 1
                    result_lines.append(f"[REF:{volume_name}|p.{court_page}]\n")
                    result_lines.append(text.strip() + "\n\n")
                else:
                    # 背面頁仍保留文字供參考
                    result_lines.append(f"[背面:{volume_name}|PDF.p.{pdf_page}]\n")
                    result_lines.append(text.strip() + "\n\n")

    return result_lines, total_pages, pages_with_text, court_page


def filter_defendant(all_lines, keywords, context_lines=20):
    """篩選被告相關段落，保留頁碼標記。"""
    ref_pattern = re.compile(r'\[REF:.+?\|p\.\d+\]')

    match_ranges = []
    for i, line in enumerate(all_lines):
        if any(kw in line for kw in keywords):
            start = max(0, i - context_lines)
            end = min(len(all_lines), i + context_lines + 1)
            match_ranges.append((start, end))

    merged = []
    for start, end in sorted(match_ranges):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    output = []
    for start, end in merged:
        segment = all_lines[start:end]
        nearest_ref = None
        for j in range(start, -1, -1):
            if ref_pattern.search(all_lines[j]):
                nearest_ref = all_lines[j].strip()
                break
        if nearest_ref and not ref_pattern.search(segment[0]):
            output.append(f"{nearest_ref}（接續）\n")
        output.extend(segment)
        output.append(f"\n{'─'*40}\n\n")

    return output


def process_folder(folder_path, defendant_name=None):
    """處理整個資料夾"""

    if not os.path.isdir(folder_path):
        print(f"❌ 資料夾不存在：{folder_path}")
        sys.exit(1)

    files = os.listdir(folder_path)
    pdfs = sorted([f for f in files if f.lower().endswith('.pdf')])

    if not pdfs:
        print(f"❌ 資料夾內沒有 PDF：{folder_path}")
        sys.exit(1)

    print(f"📂 {folder_path}")
    print(f"📋 {len(pdfs)} 個 PDF：")
    for f in pdfs:
        size_mb = os.path.getsize(os.path.join(folder_path, f)) / (1024*1024)
        print(f"   {f}（{size_mb:.1f} MB）")

    # ============================================================
    # 步驟一：全自動偵測
    # ============================================================
    print(f"\n{'='*50}")
    print("📐 步驟一：自動偵測各卷冊設定")
    print(f"{'='*50}")

    # 讀取手動覆寫設定（_page_config.json）
    overrides = {}
    config_path = os.path.join(folder_path, '_page_config.json')
    if os.path.exists(config_path):
        with open(config_path, 'r', encoding='utf-8') as f:
            overrides = json.load(f)
        print(f"\n   📋 已載入覆寫設定：{config_path}")

    configs = {}
    auto_detections = {}  # 記錄每卷的自動偵測結果（用於偵測報告）
    for pdf_name in pdfs:
        pdf_path = os.path.join(folder_path, pdf_name)
        volume_name = simplify_name(pdf_name)

        print(f"\n   🔄 {volume_name}...", end=' ', flush=True)

        # 一律先跑自動偵測
        auto_start, auto_mode, total_pages = detect_config(pdf_path)
        auto_detections[volume_name] = {
            'start': auto_start,
            'mode': auto_mode,
            'total_pages': total_pages,
        }

        # 檢查是否有手動覆寫
        if volume_name in overrides:
            ov = overrides[volume_name]
            detected_mode = ov['mode']
            detected_start = ov['start']
            print(f"共 {total_pages} 頁 ⚙️ 手動覆寫")
        else:
            detected_start = auto_start
            detected_mode = auto_mode

        mode_label = "連續" if detected_mode == "consecutive" else "隔頁（正反面掃描）"
        skip = detected_start - 1
        if detected_mode == 'consecutive':
            last_court = total_pages - skip
        else:
            last_court = (total_pages - skip + 1) // 2

        print(f"共 {total_pages} 頁")
        print(f"      → 模式：{mode_label}")
        print(f"      → 起始：PDF 第 {detected_start} 頁 = 法院第 1 頁")
        print(f"      → 預估法院頁碼：1~{last_court}")

        configs[volume_name] = (detected_start, detected_mode)

    # ============================================================
    # 步驟二：萃取 + 注入
    # ============================================================
    print(f"\n{'='*50}")
    print("✏️ 步驟二：萃取文字 + 注入頁碼標記")
    print(f"{'='*50}\n")

    all_merged_lines = []
    total_refs = 0

    for pdf_name in pdfs:
        pdf_path = os.path.join(folder_path, pdf_name)
        volume_name = simplify_name(pdf_name)
        court_start, mode = configs[volume_name]
        mode_label = "連續" if mode == "consecutive" else "隔頁"

        print(f"🔄 {volume_name}（{mode_label}）...", end=' ', flush=True)

        ref_lines, total_pages, pages_with_text, last_court = extract_and_inject(
            pdf_path, court_start, mode, volume_name
        )

        ref_count = sum(1 for l in ref_lines if l.startswith('[REF:'))
        total_refs += ref_count

        ref_path = os.path.join(folder_path, f"{volume_name}_REF.txt")
        with open(ref_path, 'w', encoding='utf-8') as f:
            f.writelines(ref_lines)

        print(f"✅ {pages_with_text}/{total_pages} 頁有文字，法院頁碼 1~{last_court}")

        all_merged_lines.append(f"\n{'='*80}\n")
        all_merged_lines.append(f"=== 卷冊：{volume_name}（{total_pages} 頁，{mode_label}，法院頁碼 1~{last_court}）===\n")
        all_merged_lines.append(f"{'='*80}\n\n")
        all_merged_lines.extend(ref_lines)

    # 全卷合併
    merged_path = os.path.join(folder_path, "全卷合併_REF.txt")
    with open(merged_path, 'w', encoding='utf-8') as f:
        f.writelines(all_merged_lines)

    # ============================================================
    # 步驟三：篩選被告段落
    # ============================================================
    if defendant_name:
        print(f"\n{'='*50}")
        print(f"🔍 步驟三：篩選「{defendant_name}」相關段落")
        print(f"{'='*50}\n")

        keywords = [defendant_name]
        filtered = filter_defendant(all_merged_lines, keywords)

        if filtered:
            filter_path = os.path.join(folder_path, f"{defendant_name}相關.txt")
            with open(filter_path, 'w', encoding='utf-8') as f:
                f.writelines(filtered)
            filter_size = os.path.getsize(filter_path) / 1024
            print(f"✅ {defendant_name}相關.txt（{filter_size:.0f} KB）")
        else:
            print(f"⚠️ 未找到包含「{defendant_name}」的段落")

    # ============================================================
    # 結果
    # ============================================================
    print(f"\n{'─'*50}")
    print(f"✅ 完成！{len(pdfs)} 卷，共 {total_refs} 個頁碼標記")
    print(f"\n📁 產出檔案：")
    for pdf_name in pdfs:
        volume_name = simplify_name(pdf_name)
        print(f"   {volume_name}_REF.txt")
    print(f"   全卷合併_REF.txt")
    if defendant_name:
        print(f"   {defendant_name}相關.txt")

    print(f"\n💡 頁碼為法院蓋印頁碼，可直接引用於書狀。")
    print(f"   [前置頁:] = 封面/目錄  [背面:] = 掃描背面")
    print(f"   下一步：上傳 claude.ai 進行卷證分析。")

    # ============================================================
    # 步驟四：產出偵測報告
    # ============================================================
    from datetime import date

    report_volumes = []
    success_count = 0
    total_count = len(pdfs)

    for pdf_name in pdfs:
        volume_name = simplify_name(pdf_name)
        final_start, final_mode = configs[volume_name]
        auto = auto_detections[volume_name]
        auto_start = auto['start']
        auto_mode = auto['mode']

        match = (auto_start == final_start and auto_mode == final_mode)
        if match:
            success_count += 1

        # 判斷修正方式
        if match:
            correction = None
        elif volume_name in overrides:
            correction = '_page_config.json 手動覆寫'
        else:
            correction = '未知'

        report_volumes.append({
            'volume': volume_name,
            'total_pages': auto['total_pages'],
            'auto_detection': {
                'start': auto_start,
                'mode': auto_mode,
            },
            'final_config': {
                'start': final_start,
                'mode': final_mode,
            },
            'detection_success': match,
            'correction': correction,
        })

    report = {
        'date': date.today().isoformat(),
        'defendant': defendant_name or '',
        'success_rate': f"{success_count}/{total_count}",
        'volumes': report_volumes,
    }

    report_path = os.path.join(folder_path, '_detection_report.json')
    with open(report_path, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print(f"\n📊 偵測報告：_detection_report.json（成功率 {success_count}/{total_count}）")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("卷證頁碼標記注入工具（法院蓋印頁碼版・全自動）")
        print()
        print("用法：")
        print("  python3 inject_page_refs.py /path/to/卷證資料夾")
        print("  python3 inject_page_refs.py /path/to/卷證資料夾 被告姓名")
        print()
        print("全自動偵測，不需要任何輸入。")
        sys.exit(0)

    folder = sys.argv[1]
    defendant = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        import pdfplumber
    except ImportError:
        print("❌ pdfplumber 未安裝。請執行：")
        print("   pip3 install pdfplumber --break-system-packages")
        sys.exit(1)

    process_folder(folder, defendant)
