"""
bookmark_engine.py — 卷證書籤核心引擎 v3
讀取 OCR 後的 PDF，辨識卷證結構，寫入 TOC/bookmark。

v3 新增：
- load_dictionary()：從 YAML 字典載入同義詞，L1 比對改為字典查找
- scan_pdf()：純掃描，回傳 bookmarks + page_texts（供 Gemini Enrich）
- write_pdf_with_bookmarks()：獨立的 PDF 寫入函式
- generate_bookmarks() 加入 dict_path 參數，向下相容

v2 改進（參考 Tylexi 行為）：
1. 掃全頁文字（跳過浮水印行），不再只看前5行
2. 書籤名稱 = regex 匹配到的實際文字（如「附件十九」），不再用固定關鍵字
3. 不去除同名書籤——同一文件類型的多份文件各自獨立書籤
4. 層級改為：文件 = L1，附件/附錄/附表 = L2（掛在前一個 L1 底下）
5. 補充缺漏 pattern：檢驗報告、結文、同意書、刑事案件報告書等
"""

import re
import yaml
import fitz  # PyMuPDF
from pathlib import Path
from typing import Optional


# ──────────────────────────────────────────────────────────────
# 浮水印偵測（司法院線上閱卷系統在每頁頂部的浮水印）
# ──────────────────────────────────────────────────────────────

_WATERMARK_RE = re.compile(
    r'司法院線上閱卷|司法院.*閱卷|線上閱卷系統'
)
_LAWYER_NAME_RE = re.compile(r'^[^\s]{2,4}$')  # 2-4字短行（浮水印中的律師名）


def _is_watermark_line(line: str) -> bool:
    """判斷一行是否為浮水印（跳過不用）。"""
    if not line or len(line) < 2:
        return True
    if _WATERMARK_RE.search(line):
        return True
    # 全是 ASCII + 數字的短行（OCR 雜訊）
    chinese = sum(1 for c in line if '\u4e00' <= c <= '\u9fff')
    if len(line) <= 8 and chinese == 0:
        return True
    return False


def _get_all_lines(page: fitz.Page, limit: int = 15) -> list[str]:
    """
    取頁面前 limit 行非浮水印行，依 Y 座標排序。
    limit=15 可避免掃到正文深處造成誤判（標題通常在頁面頂部）。
    """
    try:
        blocks = page.get_text("blocks", flags=fitz.TEXT_PRESERVE_WHITESPACE)
        text_blocks = sorted((b for b in blocks if b[6] == 0), key=lambda b: b[1])
        lines = []
        for b in text_blocks:
            for line in b[4].splitlines():
                s = line.strip()
                if s and not _is_watermark_line(s):
                    lines.append(s)
    except Exception:
        lines = [s.strip() for s in page.get_text().splitlines()
                 if s.strip() and not _is_watermark_line(s.strip())]
    return lines[:limit]


# ──────────────────────────────────────────────────────────────
# YAML 字典載入
# ──────────────────────────────────────────────────────────────

def load_dictionary(dict_path: str) -> dict:
    """
    載入 YAML 字典，回傳 {同義詞: 標準名稱} 的反查 dict。
    標準名稱本身也加入作為自己的映射。
    """
    with open(dict_path, encoding='utf-8') as f:
        raw = yaml.safe_load(f)
    if not raw:
        return {}
    reverse: dict[str, str] = {}
    for canonical, synonyms in raw.items():
        if canonical.startswith('#'):
            continue
        reverse[canonical] = canonical  # 標準名稱本身也能匹配
        if synonyms:
            for syn in synonyms:
                if syn and isinstance(syn, str):
                    reverse[syn] = canonical
    return reverse


# ──────────────────────────────────────────────────────────────
# Pattern 定義（順序：具體→一般）
# ──────────────────────────────────────────────────────────────
#
# 每個 pattern 是 (compiled_regex, is_attachment, requires_standalone)
# is_attachment=True → L2（掛在前一個 L1 底下）
# requires_standalone=True → 該關鍵字必須佔該行中文字數 ≥ 50%（防止正文中的關鍵字誤判）

_PATTERNS: list[tuple[re.Pattern, bool, bool]] = []

def _add(pattern: str, is_attachment: bool = False, standalone: bool = False) -> None:
    _PATTERNS.append((re.compile(pattern), is_attachment, standalone))


# 卷冊標記（L1）
_add(r'(?:偵|院|他|警|執行|審判)(?:[一二三四五六七八九十]|\d+)卷')
_add(r'偵查卷(?![宗\d])')  # 排除「偵查卷宗」「偵查卷1宗」（附送清單用語）
_add(r'(?:審判卷|執行卷|偵卷|院卷|他卷|警卷)')
_add(r'第[一二三四五六七八九十\d]+卷[宗]?(?=\s|$|，|。)')
_add(r'\d{2,3}年度[^\s]{1,10}字第\d+號', standalone=True)  # 案號需獨行

# 個人/前案紀錄（L1）
_add(r'前案紀錄表')
_add(r'刑案資料[查査][注註]紀錄表')
_add(r'在監在押紀[錄録]表')
_add(r'戶籍謄本')

# 起訴相關（L1）
_add(r'追加起訴書')
_add(r'併辦意旨書')
_add(r'聲請簡易判決處刑書')
_add(r'起訴書')

# 筆錄（L1，具體→一般）
_add(r'審判筆錄')
_add(r'準備程序筆錄')
_add(r'訊問筆錄')
_add(r'詢問筆錄')
_add(r'調查筆錄')
_add(r'偵訊筆錄')
_add(r'勘驗筆錄')
_add(r'扣押筆錄')
_add(r'筆錄', standalone=True)

# 裁判（L1）
_add(r'判決', standalone=True)
_add(r'裁定', standalone=True)

# 書狀（L1）
_add(r'上訴理由狀')
_add(r'刑事答辯狀')
_add(r'辯護意旨狀')
_add(r'準備書狀')
_add(r'答辯狀')
_add(r'陳報狀')
_add(r'聲請狀')
_add(r'民事起訴狀')

# 報告書（L1，具體→一般）
_add(r'純度鑑定報告書')
_add(r'成分鑑定報告書')
_add(r'鑑定報告書')
_add(r'鑑定書')
_add(r'鑑定報告')
_add(r'濫用藥物尿液檢驗報告')
_add(r'尿液檢驗報告')
_add(r'檢驗報告')
_add(r'勘驗報告')
_add(r'刑事案件報告書?')
_add(r'職務報告')
_add(r'報告書', standalone=True)

# 結文（L1）
_add(r'鑑定人結文')
_add(r'結文', standalone=True)

# 同意書（L1）
_add(r'數位證物勘察採證同意書')
_add(r'個人資料提供同意書')

# 搜索/扣押文件（L1）
_add(r'扣押物品目錄表')
_add(r'通聯紀錄')
_add(r'調取票')
_add(r'搜索票')

# 函文/移送（L1）
_add(r'移送書')
_add(r'解送人犯報告書')
_add(r'函覆')
_add(r'覆函')

# 財務（L1）
_add(r'金融帳戶')
_add(r'帳戶資料')
_add(r'交易明細')

# 附件/附錄（L2，掛在前一個 L1 底下）
_add(r'附錄[^。\n]{0,30}',          is_attachment=True)
_add(r'附件[一二三四五六七八九十百千\d][^\s。\n]{0,10}', is_attachment=True)
_add(r'附件\d+',                     is_attachment=True)
_add(r'附件',                        is_attachment=True)
_add(r'附表[一二三四五六七八九十\d]*', is_attachment=True)
_add(r'犯罪嫌疑人照片',              is_attachment=True)
_add(r'證物[一二三四五六七八九十\d]*', is_attachment=True)


# ──────────────────────────────────────────────────────────────
# 核心：掃一頁，回傳 (title, is_attachment) 或 None
# ──────────────────────────────────────────────────────────────

def _chinese_count(text: str) -> int:
    return sum(1 for c in text if '\u4e00' <= c <= '\u9fff')


def _scan_page(page: fitz.Page, reverse_dict: Optional[dict] = None) -> list[tuple[str, bool]]:
    """
    掃描頁面，回傳「按頁面順序」匹配到的書籤列表。
    每頁上限：1 個 L1（文件）+ 1 個 L2（附件/附錄），合計最多 2 個。

    reverse_dict 不為 None 時（YAML 模式）：
    - L1：用字典做子字串比對，優先匹配最長 pattern
    - L2：仍使用 _PATTERNS 中 is_attachment=True 的部分
    """
    lines = _get_all_lines(page)
    l1_match: Optional[tuple[str, bool]] = None
    l2_match: Optional[tuple[str, bool]] = None

    if reverse_dict is not None:
        # ── YAML 模式 ──────────────────────────────────────────
        for line in lines:
            if l1_match and l2_match:
                break

            # L1：字典比對（優先匹配較長的 pattern，避免短詞吃掉長詞）
            if not l1_match:
                best_len = 0
                best_canonical = None
                for pattern, canonical in reverse_dict.items():
                    if pattern in line and len(pattern) > best_len:
                        best_len = len(pattern)
                        best_canonical = canonical
                if best_canonical:
                    l1_match = (best_canonical, False)

            # L2：仍走 _PATTERNS 的附件規則
            if not l2_match:
                line_cn = _chinese_count(line)
                for patt, is_attach, requires_standalone in _PATTERNS:
                    if not is_attach:
                        continue
                    m = patt.search(line)
                    if not m:
                        continue
                    if requires_standalone and line_cn > 0:
                        if _chinese_count(m.group(0)) / line_cn < 0.5:
                            continue
                    raw = re.sub(r'[\s_\-]+$', '', m.group(0).strip())
                    if raw:
                        l2_match = (raw, True)
                        break
    else:
        # ── 原始 regex 模式 ────────────────────────────────────
        for line in lines:
            if l1_match and l2_match:
                break

            line_cn = _chinese_count(line)
            for pattern, is_attach, requires_standalone in _PATTERNS:
                if is_attach and l2_match:
                    continue
                if not is_attach and l1_match:
                    continue

                m = pattern.search(line)
                if not m:
                    continue

                if requires_standalone and line_cn > 0:
                    if _chinese_count(m.group(0)) / line_cn < 0.5:
                        continue

                raw = re.sub(r'[\s_\-]+$', '', m.group(0).strip())
                if not raw:
                    continue

                entry = (raw, is_attach)
                if is_attach:
                    l2_match = entry
                else:
                    l1_match = entry
                break

    # 按頁面行序輸出（先找到的先輸出）
    results = []
    if l1_match and l2_match:
        l1_line_idx = _find_first_line(lines, l1_match[0])
        l2_line_idx = _find_first_line(lines, l2_match[0])
        if l2_line_idx < l1_line_idx:
            results = [l2_match, l1_match]
        else:
            results = [l1_match, l2_match]
    elif l1_match:
        results = [l1_match]
    elif l2_match:
        results = [l2_match]
    return results


def _find_first_line(lines: list[str], keyword: str) -> int:
    """回傳 keyword 在 lines 中第一次出現的行索引。"""
    for i, line in enumerate(lines):
        if keyword in line:
            return i
    return len(lines)


# ──────────────────────────────────────────────────────────────
# 公開介面
# ──────────────────────────────────────────────────────────────

def scan_pdf(
    input_path: str,
    dict_path: Optional[str] = None,
    collect_page_texts: bool = False,
) -> dict:
    """
    掃描 PDF，辨識書籤，但不寫入 PDF。

    Returns:
        {
          'total_pages': int,
          'bookmarks': [{'level': int, 'title': str, 'page': int}, ...],
          'warnings': [str, ...],
          'page_texts': {page_no: str} | None  # 只在 collect_page_texts=True 時填充
        }
    """
    input_path = Path(input_path)
    warnings: list[str] = []
    bookmarks: list[dict] = []
    page_texts: Optional[dict] = {} if collect_page_texts else None

    reverse_dict: Optional[dict] = None
    if dict_path:
        try:
            reverse_dict = load_dictionary(dict_path)
        except Exception as e:
            warnings.append(f'字典載入失敗，改用內建規則：{e}')

    doc = fitz.open(str(input_path))
    total_pages = doc.page_count

    for i in range(total_pages):
        page = doc[i]

        try:
            raw_text = page.get_text().strip()
        except Exception as e:
            warnings.append(f'第 {i+1} 頁讀取失敗：{e}')
            continue
        if not raw_text:
            warnings.append(f'第 {i+1} 頁無文字層（可能是掃描圖），跳過')
            continue

        if collect_page_texts and page_texts is not None:
            page_texts[i + 1] = raw_text[:300]

        matches = _scan_page(page, reverse_dict)
        for title, is_attachment in matches:
            level = 2 if is_attachment else 1
            if level == 2 and not bookmarks:
                level = 1
            bookmarks.append({'level': level, 'title': title, 'page': i + 1})

    doc.close()

    if bookmarks and bookmarks[0]['level'] != 1:
        bookmarks[0]['level'] = 1

    return {
        'total_pages': total_pages,
        'bookmarks': bookmarks,
        'warnings': warnings,
        'page_texts': page_texts,
    }


def write_pdf_with_bookmarks(
    input_path: str,
    bookmarks: list[dict],
    output_path: Optional[str] = None,
) -> str:
    """
    把書籤列表寫入 PDF，存到 output_path。
    回傳最終輸出路徑（str）。
    """
    input_path = Path(input_path)
    if output_path is None:
        output_path = input_path.with_stem(input_path.stem + '_bookmarked')
    output_path = Path(output_path)

    doc = fitz.open(str(input_path))
    toc = [[bm['level'], bm['title'], bm['page']] for bm in bookmarks]
    doc.set_toc(toc)
    doc.save(str(output_path))
    doc.close()

    return str(output_path)


def generate_bookmarks(
    input_path: str,
    output_path: Optional[str] = None,
    dict_path: Optional[str] = None,
) -> dict:
    """
    掃描 + 寫入 PDF，向下相容舊版介面。

    Returns:
        {
          'total_pages': int,
          'bookmarks': [...],
          'output_path': str,
          'warnings': [...]
        }
    """
    result = scan_pdf(input_path, dict_path=dict_path, collect_page_texts=False)
    out = write_pdf_with_bookmarks(input_path, result['bookmarks'], output_path)
    result['output_path'] = out
    return result
