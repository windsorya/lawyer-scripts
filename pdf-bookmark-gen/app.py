"""
app.py — 卷證書籤產生器 Standalone Web UI  v3
啟動：streamlit run app.py --server.port 8502

v3 新增：
- ⚙️ 字典設定 expander：YAML 字典 CRUD，切換字典，建立新字典
- ✨ Gemini Enrich：自動補充被告姓名、日期、案號
"""

import io
import os
import sys
import tempfile
import zipfile
from pathlib import Path

import yaml
import streamlit as st

sys.path.insert(0, str(Path(__file__).parent))
from bookmark_engine import scan_pdf, write_pdf_with_bookmarks, load_dictionary
from gemini_enrich import enrich_bookmarks

# ──────────────────────────────────────────────────────────────
# 常數
# ──────────────────────────────────────────────────────────────
DICT_DIR = Path(__file__).parent / 'dictionaries'
DICT_DIR.mkdir(exist_ok=True)


def _get_dict_files() -> list[str]:
    return sorted(p.name for p in DICT_DIR.glob('*.yaml'))


def _load_dict_as_df(yaml_path: Path):
    """讀 YAML，轉成 [{標準名稱, 同義詞}] list for dataframe 顯示。"""
    try:
        with open(yaml_path, encoding='utf-8') as f:
            raw = yaml.safe_load(f) or {}
        rows = []
        for canonical, synonyms in raw.items():
            if canonical.startswith('#'):
                continue
            syns = '、'.join(synonyms) if synonyms else ''
            rows.append({'標準名稱': canonical, '同義詞': syns})
        return rows
    except Exception:
        return []


def _save_dict(yaml_path: Path, data: dict) -> None:
    """把 {canonical: [synonyms]} dict 寫回 YAML。"""
    with open(yaml_path, 'w', encoding='utf-8') as f:
        yaml.dump(data, f, allow_unicode=True, default_flow_style=False,
                  sort_keys=False)


def _read_raw_dict(yaml_path: Path) -> dict:
    try:
        with open(yaml_path, encoding='utf-8') as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


# ──────────────────────────────────────────────────────────────
# 頁面設定
# ──────────────────────────────────────────────────────────────
st.set_page_config(
    page_title='卷證書籤產生器',
    page_icon='📑',
    layout='wide',
    initial_sidebar_state='expanded',
)

# ──────────────────────────────────────────────────────────────
# 全域 CSS（Apple Legal 設計語言）
# ──────────────────────────────────────────────────────────────
st.markdown("""
<style>
*, *::before, *::after { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
html, body, [class*="css"], .stMarkdown, p, label, input, button {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text",
                 "PingFang TC", "Noto Sans TC", sans-serif !important;
}
h1, h2, h3 {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
                 "PingFang TC", "Noto Sans TC", sans-serif !important;
}
[data-testid="stAppViewContainer"] { background: #F5F5F7; }
[data-testid="stMainBlockContainer"] { max-width: 1100px; padding: 1.5rem 2rem 4rem; }

/* 側邊欄 */
section[data-testid="stSidebar"] {
    background: linear-gradient(180deg, #0D1B35 0%, #1B2A4A 60%, #1E3055 100%);
    border-right: none;
    box-shadow: 4px 0 24px rgba(0,0,0,0.18);
}
section[data-testid="stSidebar"] .stMarkdown p,
section[data-testid="stSidebar"] label,
section[data-testid="stSidebar"] .stCaption { color: rgba(232,237,245,0.85) !important; }
section[data-testid="stSidebar"] hr { border-color: rgba(255,255,255,0.1) !important; }

/* 按鈕 */
[data-testid="stBaseButton-primary"] button {
    background: linear-gradient(150deg, #1B2A4A 0%, #243560 100%) !important;
    border: none !important; color: white !important;
    border-radius: 10px !important; font-size: 14px !important;
    font-weight: 600 !important;
    box-shadow: 0 2px 8px rgba(27,42,74,0.28) !important;
    transition: all 0.18s ease !important;
}
[data-testid="stBaseButton-primary"] button:hover {
    background: linear-gradient(150deg, #243560 0%, #2E4170 100%) !important;
    transform: translateY(-1px) !important;
    box-shadow: 0 4px 16px rgba(27,42,74,0.38) !important;
}

/* Expander */
[data-testid="stExpander"] {
    background: white !important; border: 1px solid rgba(0,0,0,0.07) !important;
    border-radius: 12px !important; box-shadow: 0 1px 4px rgba(0,0,0,0.05) !important;
    margin-bottom: 8px !important; overflow: hidden !important;
}
[data-testid="stExpander"]:hover {
    border-color: rgba(201,169,110,0.35) !important;
    box-shadow: 0 4px 14px rgba(0,0,0,0.08) !important;
}

/* Alert */
div[class*="stInfo"]    { border-left: 3px solid #C9A96E !important; background: rgba(201,169,110,0.07) !important; border-radius: 10px !important; }
div[class*="stSuccess"] { border-left: 3px solid #34C759 !important; background: rgba(52,199,89,0.07) !important; border-radius: 10px !important; }
div[class*="stWarning"] { border-left: 3px solid #FF9500 !important; background: rgba(255,149,0,0.07) !important; border-radius: 10px !important; }
div[class*="stError"]   { border-left: 3px solid #FF3B30 !important; background: rgba(255,59,48,0.07) !important; border-radius: 10px !important; }

/* Progress */
[data-testid="stProgressBar"] > div > div { background: #C9A96E !important; border-radius: 4px; }
</style>
""", unsafe_allow_html=True)


# ──────────────────────────────────────────────────────────────
# 側邊欄
# ──────────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown("""
    <div style="padding: 8px 0 16px;">
        <div style="font-size: 2rem; margin-bottom: 8px;">📑</div>
        <div style="color: white; font-size: 1.1rem; font-weight: 700; letter-spacing: -0.02em;">
            卷證書籤產生器
        </div>
        <div style="color: rgba(255,255,255,0.5); font-size: 12px; margin-top: 4px;">
            v3 · YAML 字典 + Gemini Enrich
        </div>
    </div>
    """, unsafe_allow_html=True)
    st.divider()
    st.markdown("""
    <p style="color:rgba(232,237,245,0.7);font-size:13px;margin:0 0 8px;font-weight:600;
              letter-spacing:.05em;text-transform:uppercase;">支援辨識</p>
    """, unsafe_allow_html=True)
    items = [
        "偵卷・院卷・卷一/卷二・案號",
        "起訴書・聲請簡易判決書",
        "審判筆錄・訊問筆錄・詢問筆錄",
        "判決・裁定",
        "書狀・答辯狀・聲請狀",
        "鑑定報告・檢驗報告・職務報告",
        "搜索票・扣押文件・通聯紀錄",
        "函文・移送書",
        "附件・附錄・附表（L2）",
    ]
    for item in items:
        st.markdown(f'<div style="color:rgba(232,237,245,0.78);font-size:12.5px;'
                    f'padding:3px 0;display:flex;gap:6px;">'
                    f'<span style="color:#C9A96E;">▸</span>{item}</div>',
                    unsafe_allow_html=True)
    st.divider()
    st.markdown("""
    <p style="color:rgba(232,237,245,0.7);font-size:13px;margin:0 0 6px;font-weight:600;
              letter-spacing:.05em;text-transform:uppercase;">注意事項</p>
    <p style="color:rgba(232,237,245,0.65);font-size:12.5px;line-height:1.7;margin:0;">
        PDF 需已完成 OCR（有文字層）<br>
        純掃描圖檔請先跑<br>
        <code style="background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:4px;font-size:11px;">
            ocrmypdf --force-ocr
        </code>
    </p>
    """, unsafe_allow_html=True)
    st.divider()
    st.markdown("""
    <p style="color:rgba(232,237,245,0.7);font-size:13px;margin:0 0 6px;font-weight:600;
              letter-spacing:.05em;text-transform:uppercase;">CLI 用法</p>
    <code style="background:rgba(255,255,255,0.08);border-radius:6px;padding:6px 10px;
                 font-size:11.5px;color:rgba(232,237,245,0.85);display:block;line-height:1.8;">
        cd ~/scripts/pdf-bookmark-gen<br>
        python cli.py input.pdf<br>
        python cli.py input.pdf -o out.pdf
    </code>
    """, unsafe_allow_html=True)


# ──────────────────────────────────────────────────────────────
# Hero Banner
# ──────────────────────────────────────────────────────────────
st.markdown("""
<div style="background:linear-gradient(135deg,#1B2A4A 0%,#243560 100%);
            border-radius:16px;padding:24px 28px;margin-bottom:20px;">
    <div style="display:flex;align-items:flex-start;gap:16px;">
        <div style="font-size:2.2rem;line-height:1;flex-shrink:0;">📑</div>
        <div>
            <div style="color:white;margin:0 0 6px;font-size:1.5rem;font-weight:700;
                        letter-spacing:-0.03em;line-height:1.2;">
                卷證書籤產生器
            </div>
            <p style="color:rgba(255,255,255,0.72);margin:0;font-size:13.5px;line-height:1.7;">
                自動掃描 OCR 後的電子卷證，辨識文件結構並寫入 PDF 書籤目錄。
                v3 支援 YAML 字典同義詞比對與 Gemini Enrich 自動補充個案資訊。
            </p>
        </div>
    </div>
    <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:14px;">
        <span style="background:rgba(201,169,110,0.2);border:1px solid rgba(201,169,110,0.38);
                     color:#D4B87E;border-radius:20px;padding:3px 11px;font-size:12px;">
            起訴書・筆錄・判決
        </span>
        <span style="background:rgba(201,169,110,0.2);border:1px solid rgba(201,169,110,0.38);
                     color:#D4B87E;border-radius:20px;padding:3px 11px;font-size:12px;">
            書狀・答辯狀・聲請狀
        </span>
        <span style="background:rgba(201,169,110,0.2);border:1px solid rgba(201,169,110,0.38);
                     color:#D4B87E;border-radius:20px;padding:3px 11px;font-size:12px;">
            YAML 字典・Gemini Enrich
        </span>
    </div>
</div>
""", unsafe_allow_html=True)


# ──────────────────────────────────────────────────────────────
# ⚙️ 字典設定 Expander
# ──────────────────────────────────────────────────────────────
with st.expander('⚙️ 字典設定（同義詞管理）', expanded=False):
    dict_files = _get_dict_files()

    col_sel, col_new = st.columns([3, 2])
    with col_sel:
        if dict_files:
            selected_dict_name = st.selectbox(
                '選擇字典',
                options=['（不使用字典）'] + dict_files,
                key='selected_dict_name',
            )
        else:
            st.info('尚無字典檔案，請先建立一個。')
            selected_dict_name = '（不使用字典）'
            st.session_state['selected_dict_name'] = selected_dict_name

    with col_new:
        new_dict_input = st.text_input('新字典名稱（不含 .yaml）', key='new_dict_name_input',
                                       placeholder='例：行政訴訟')
        if st.button('建立空字典', key='btn_create_dict'):
            if new_dict_input.strip():
                new_path = DICT_DIR / f'{new_dict_input.strip()}.yaml'
                if new_path.exists():
                    st.warning(f'「{new_dict_input.strip()}.yaml」已存在')
                else:
                    _save_dict(new_path, {})
                    st.success(f'已建立 {new_path.name}')
                    st.rerun()
            else:
                st.warning('請輸入字典名稱')

    # 若已選某字典，顯示內容 + CRUD
    active_dict_name = st.session_state.get('selected_dict_name', '（不使用字典）')
    if active_dict_name != '（不使用字典）' and active_dict_name in dict_files:
        active_path = DICT_DIR / active_dict_name
        st.markdown(f'**目前字典：** `{active_dict_name}`')

        rows = _load_dict_as_df(active_path)
        if rows:
            st.dataframe(rows, use_container_width=True, hide_index=True)
        else:
            st.info('字典目前是空的。')

        st.markdown('---')
        col_add1, col_add2, col_add3 = st.columns([2, 3, 1])
        with col_add1:
            new_canonical = st.text_input('標準名稱', key='new_canonical',
                                          placeholder='例：訊問筆錄')
        with col_add2:
            new_synonyms = st.text_input('同義詞（逗號分隔）', key='new_synonyms',
                                         placeholder='例：詢問筆錄, 偵訊筆錄')
        with col_add3:
            st.markdown('<div style="margin-top:28px;"></div>', unsafe_allow_html=True)
            if st.button('新增', key='btn_add_entry', type='primary'):
                if new_canonical.strip():
                    raw_dict = _read_raw_dict(active_path)
                    syns = [s.strip() for s in new_synonyms.split(',') if s.strip()] \
                           if new_synonyms.strip() else None
                    raw_dict[new_canonical.strip()] = syns
                    _save_dict(active_path, raw_dict)
                    st.success(f'已新增「{new_canonical.strip()}」')
                    st.rerun()
                else:
                    st.warning('請輸入標準名稱')

        # 刪除條目
        raw_dict_cur = _read_raw_dict(active_path)
        canonical_list = [k for k in raw_dict_cur if not k.startswith('#')]
        if canonical_list:
            to_delete = st.multiselect('選擇要刪除的條目', canonical_list,
                                       key='delete_entries')
            if st.button('刪除選取', key='btn_delete_entries',
                         disabled=not to_delete):
                for key in to_delete:
                    raw_dict_cur.pop(key, None)
                _save_dict(active_path, raw_dict_cur)
                st.success(f'已刪除 {len(to_delete)} 個條目')
                st.rerun()


# ──────────────────────────────────────────────────────────────
# ✨ 處理選項
# ──────────────────────────────────────────────────────────────
st.markdown("""
<div style="background:white;border:1px solid rgba(0,0,0,0.08);border-radius:12px;
            padding:16px 20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,0.05);">
    <div style="font-weight:700;color:#1D1D1F;font-size:14px;margin-bottom:10px;">
        📋 處理選項
    </div>
""", unsafe_allow_html=True)

opt_col1, opt_col2 = st.columns([1, 1])
with opt_col1:
    enable_enrich = st.checkbox(
        '✨ 啟用 Gemini Enrich（自動補充被告姓名、日期、案號）',
        key='enable_enrich',
        value=False,
    )
with opt_col2:
    if enable_enrich:
        case_hint = st.text_input(
            '案件提示（可選）',
            key='case_hint',
            placeholder='例：被告王志文 114年偵字第5678號',
        )
    else:
        case_hint = ''

st.markdown('</div>', unsafe_allow_html=True)


# ──────────────────────────────────────────────────────────────
# Helper：書籤樹狀 HTML
# ──────────────────────────────────────────────────────────────
def _bm_tree_html(bookmarks):
    if not bookmarks:
        return ('<div style="padding:24px;text-align:center;color:#AEAEB2;font-size:13px;">'
                '未找到書籤</div>')
    rows = []
    for bm in bookmarks:
        if bm["level"] == 1:
            rows.append(
                f'<div style="display:flex;justify-content:space-between;align-items:center;'
                f'padding:9px 14px;border-bottom:1px solid rgba(0,0,0,0.055);">'
                f'<div style="display:flex;align-items:center;gap:8px;">'
                f'<span style="background:#1B2A4A;color:white;border-radius:4px;'
                f'padding:1px 7px;font-size:11px;font-weight:700;letter-spacing:.02em;">L1</span>'
                f'<span style="font-weight:600;color:#1D1D1F;font-size:13.5px;">▸ {bm["title"]}</span>'
                f'</div>'
                f'<span style="color:#AEAEB2;font-size:12px;white-space:nowrap;">'
                f'第&nbsp;{bm["page"]}&nbsp;頁</span></div>'
            )
        else:
            rows.append(
                f'<div style="display:flex;justify-content:space-between;align-items:center;'
                f'padding:7px 14px 7px 38px;border-bottom:1px solid rgba(0,0,0,0.035);'
                f'background:rgba(201,169,110,0.04);">'
                f'<div style="display:flex;align-items:center;gap:8px;">'
                f'<span style="background:#C9A96E;color:white;border-radius:4px;'
                f'padding:1px 7px;font-size:11px;font-weight:700;letter-spacing:.02em;">L2</span>'
                f'<span style="color:#636366;font-size:13px;">· {bm["title"]}</span>'
                f'</div>'
                f'<span style="color:#AEAEB2;font-size:12px;white-space:nowrap;">'
                f'第&nbsp;{bm["page"]}&nbsp;頁</span></div>'
            )
    return (
        '<div style="background:white;border-radius:12px;border:1px solid rgba(0,0,0,0.08);'
        'overflow:hidden;max-height:520px;overflow-y:auto;">'
        + ''.join(rows)
        + '</div>'
    )


# ──────────────────────────────────────────────────────────────
# 上傳區
# ──────────────────────────────────────────────────────────────
uploaded_files = st.file_uploader(
    '拖放 PDF 檔案（可多選，最大 2000 MB/檔）',
    type=['pdf'],
    accept_multiple_files=True,
    help='支援批次處理',
)

if not uploaded_files:
    st.markdown("""
    <div style="background:#FAFAFA;border:1.5px dashed rgba(27,42,74,0.15);
                border-radius:14px;padding:36px 24px;text-align:center;margin-top:8px;">
        <div style="font-size:2.8rem;margin-bottom:12px;opacity:.45;">📂</div>
        <p style="color:#8E8E93;margin:0;font-size:14px;line-height:1.8;">
            拖放 PDF 至上方虛線框，或點擊「Browse files」選擇
            <br><span style="font-size:12.5px;color:#AEAEB2;">支援批次多選 · 每檔最大 2000 MB · 需已完成 OCR</span>
        </p>
    </div>
    """, unsafe_allow_html=True)
    st.stop()

# ── 已選擇檔案的摘要 ──────────────────────────────────────────
n_files = len(uploaded_files)
total_mb = sum(f.size for f in uploaded_files) / 1024 / 1024

# 決定是否使用字典
active_dict_name_now = st.session_state.get('selected_dict_name', '（不使用字典）')
dict_path_to_use: str | None = None
if active_dict_name_now != '（不使用字典）' and (DICT_DIR / active_dict_name_now).exists():
    dict_path_to_use = str(DICT_DIR / active_dict_name_now)

dict_badge = f'字典：{active_dict_name_now}' if dict_path_to_use else '內建規則'
enrich_badge = 'Gemini Enrich：開' if enable_enrich else 'Gemini Enrich：關'

st.markdown(f"""
<div style="background:rgba(27,42,74,0.05);border:1px solid rgba(27,42,74,0.12);
            border-radius:10px;padding:12px 18px;margin-bottom:16px;
            display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
    <span style="font-size:20px;">📋</span>
    <span style="color:#1B2A4A;font-weight:600;font-size:14px;">已選擇 {n_files} 個 PDF</span>
    <span style="color:#8E8E93;font-size:13px;">合計 {total_mb:.1f} MB</span>
    <span style="background:#EEF1F8;color:#1B2A4A;border-radius:6px;padding:2px 9px;
                 font-size:12px;">{dict_badge}</span>
    <span style="background:{'rgba(201,169,110,0.18)' if enable_enrich else '#F2F2F7'};
                 color:{'#8B6914' if enable_enrich else '#636366'};
                 border-radius:6px;padding:2px 9px;font-size:12px;">{enrich_badge}</span>
</div>
""", unsafe_allow_html=True)

# ──────────────────────────────────────────────────────────────
# 處理
# ──────────────────────────────────────────────────────────────
if st.button('🚀 開始產生書籤', type='primary', use_container_width=True):
    results = []
    tmp_files = []

    progress = st.progress(0, text='準備中…')

    for idx, uploaded_file in enumerate(uploaded_files):
        progress.progress(
            idx / len(uploaded_files),
            text=f'掃描中 {idx+1}/{len(uploaded_files)}：{uploaded_file.name}'
        )

        # 暫存輸入
        tmp_in = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf')
        tmp_in.write(uploaded_file.read())
        tmp_in.flush(); tmp_in.close()
        tmp_files.append(tmp_in.name)

        # 暫存輸出
        tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf')
        tmp_out.close()
        tmp_files.append(tmp_out.name)

        try:
            # Step 1: 掃描
            scan_result = scan_pdf(
                tmp_in.name,
                dict_path=dict_path_to_use,
                collect_page_texts=enable_enrich,
            )
            bookmarks = scan_result['bookmarks']
            page_texts = scan_result.get('page_texts') or {}

            # Step 2: Gemini Enrich（可選）
            if enable_enrich and bookmarks:
                progress.progress(
                    (idx + 0.5) / len(uploaded_files),
                    text=f'Gemini Enrich {idx+1}/{len(uploaded_files)}：{uploaded_file.name}'
                )
                bookmarks = enrich_bookmarks(bookmarks, page_texts, case_hint)

            # Step 3: 寫入 PDF
            write_pdf_with_bookmarks(tmp_in.name, bookmarks, tmp_out.name)
            with open(tmp_out.name, 'rb') as f:
                output_bytes = f.read()

            results.append({
                'name': uploaded_file.name,
                'output_name': Path(uploaded_file.name).stem + '_bookmarked.pdf',
                'output_bytes': output_bytes,
                'total_pages': scan_result['total_pages'],
                'bookmarks': bookmarks,
                'warnings': scan_result['warnings'],
                'error': None,
            })
        except Exception as e:
            results.append({
                'name': uploaded_file.name,
                'output_name': None,
                'output_bytes': None,
                'total_pages': 0,
                'bookmarks': [],
                'warnings': [],
                'error': str(e),
            })

    progress.progress(1.0, text='✅ 完成！')

    for f in tmp_files:
        try: os.unlink(f)
        except Exception: pass

    # ── 結果顯示 ──────────────────────────────────────────────
    st.divider()

    success_results = [r for r in results if r['error'] is None]
    fail_results = [r for r in results if r['error'] is not None]

    total_bm = sum(len(r['bookmarks']) for r in success_results)
    st.markdown(f"""
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;">
        <div style="background:white;border:1px solid rgba(0,0,0,0.07);border-radius:12px;
                    padding:14px 20px;flex:1;min-width:120px;
                    box-shadow:0 1px 4px rgba(0,0,0,0.05);">
            <div style="font-size:1.8rem;font-weight:700;color:#1B2A4A;letter-spacing:-0.04em;">
                {len(success_results)}
            </div>
            <div style="font-size:11px;color:#8E8E93;font-weight:600;text-transform:uppercase;
                        letter-spacing:.05em;margin-top:2px;">成功處理</div>
        </div>
        <div style="background:white;border:1px solid rgba(0,0,0,0.07);border-radius:12px;
                    padding:14px 20px;flex:1;min-width:120px;
                    box-shadow:0 1px 4px rgba(0,0,0,0.05);position:relative;overflow:hidden;">
            <div style="position:absolute;top:0;left:0;width:4px;height:100%;
                        background:linear-gradient(180deg,#C9A96E,#D4B87E);"></div>
            <div style="font-size:1.8rem;font-weight:700;color:#1B2A4A;letter-spacing:-0.04em;">
                {total_bm}
            </div>
            <div style="font-size:11px;color:#8E8E93;font-weight:600;text-transform:uppercase;
                        letter-spacing:.05em;margin-top:2px;">總書籤數</div>
        </div>
        {f'<div style="background:#FFF3F0;border:1px solid rgba(255,59,48,0.2);border-radius:12px;padding:14px 20px;flex:1;min-width:120px;"><div style="font-size:1.8rem;font-weight:700;color:#FF3B30;letter-spacing:-0.04em;">{len(fail_results)}</div><div style="font-size:11px;color:#8E8E93;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-top:2px;">處理失敗</div></div>' if fail_results else ''}
    </div>
    """, unsafe_allow_html=True)

    # 批次 ZIP
    if len(success_results) > 1:
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for r in success_results:
                zf.writestr(r['output_name'], r['output_bytes'])
        zip_buf.seek(0)
        st.download_button(
            label=f'⬇ 下載全部 {len(success_results)} 份（ZIP）',
            data=zip_buf,
            file_name='bookmarked_pdfs.zip',
            mime='application/zip',
            use_container_width=True,
            type='primary',
        )
        st.divider()

    # 逐檔結果
    for r in results:
        if r['error']:
            with st.expander(f'❌  {r["name"]}', expanded=True):
                st.error(f'處理失敗：{r["error"]}')
            continue

        bms = r['bookmarks']
        n_bm = len(bms)
        n_l1 = sum(1 for b in bms if b['level'] == 1)
        n_l2 = n_bm - n_l1

        st.markdown(f"""
        <div style="background:white;border:1px solid rgba(0,0,0,0.08);border-radius:14px;
                    padding:16px 18px;margin:12px 0 4px;box-shadow:0 1px 4px rgba(0,0,0,0.05);">
            <div style="font-weight:700;color:#1D1D1F;font-size:14px;margin-bottom:8px;">
                ✅ {r['name']}
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <span style="background:#F2F2F7;color:#3A3A3C;border-radius:6px;
                             padding:2px 9px;font-size:12px;">📄 {r['total_pages']} 頁</span>
                <span style="background:#EEF1F8;color:#1B2A4A;border-radius:6px;
                             padding:2px 9px;font-size:12px;font-weight:600;">{n_bm} 個書籤</span>
                <span style="background:#1B2A4A;color:white;border-radius:6px;
                             padding:2px 9px;font-size:12px;">L1 × {n_l1}</span>
                <span style="background:rgba(201,169,110,0.18);color:#8B6914;border-radius:6px;
                             padding:2px 9px;font-size:12px;">L2 × {n_l2}</span>
            </div>
        </div>
        """, unsafe_allow_html=True)

        col_tree, col_dl = st.columns([3, 1])

        with col_dl:
            st.download_button(
                label='⬇ 下載 PDF',
                data=r['output_bytes'],
                file_name=r['output_name'],
                mime='application/pdf',
                key=f'dl_{r["name"]}',
                use_container_width=True,
                type='primary',
            )
            if r['warnings']:
                with st.expander(f'⚠ {len(r["warnings"])} 則警告'):
                    for w in r['warnings'][:20]:
                        st.text(w)
                    if len(r['warnings']) > 20:
                        st.text(f'… 另有 {len(r["warnings"]) - 20} 則')

        with col_tree:
            if bms:
                st.markdown(_bm_tree_html(bms), unsafe_allow_html=True)
            else:
                st.warning('未找到任何書籤。請確認 PDF 已完成 OCR（有文字層）。')

    if fail_results:
        st.error('處理失敗：' + '、'.join(r['name'] for r in fail_results))
