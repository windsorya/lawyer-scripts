#!/usr/bin/env python3
"""
cli.py — 卷證書籤產生器 CLI 入口
用法：
    python cli.py input.pdf
    python cli.py input.pdf -o output.pdf
"""

import argparse
import sys
from pathlib import Path
from bookmark_engine import generate_bookmarks


def main():
    parser = argparse.ArgumentParser(
        description='自動為卷證 PDF 加入書籤目錄',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
範例：
  python cli.py 起訴狀卷一.pdf
  python cli.py 起訴狀卷一.pdf -o 加書籤版.pdf
        """
    )
    parser.add_argument('input', help='輸入 PDF 路徑')
    parser.add_argument('-o', '--output', help='輸出 PDF 路徑（預設：原檔名_bookmarked.pdf）')
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f'[錯誤] 找不到檔案：{input_path}', file=sys.stderr)
        sys.exit(1)
    if not input_path.suffix.lower() == '.pdf':
        print(f'[錯誤] 輸入必須是 PDF 檔案', file=sys.stderr)
        sys.exit(1)

    print(f'[處理中] {input_path.name} ...')

    result = generate_bookmarks(str(input_path), args.output)

    # 印出摘要
    print(f'\n{"─" * 50}')
    print(f'  輸入：{input_path.name}')
    print(f'  輸出：{Path(result["output_path"]).name}')
    print(f'  總頁數：{result["total_pages"]} 頁')
    print(f'  書籤數：{len(result["bookmarks"])} 個')
    print(f'{"─" * 50}')

    if result['bookmarks']:
        print('\n  書籤清單：')
        for bm in result['bookmarks']:
            indent = '    ' if bm['level'] == 2 else '  '
            marker = '▸' if bm['level'] == 1 else '  ·'
            print(f'{indent}{marker} [{bm["page"]:>4} 頁]  {bm["title"]}')
    else:
        print('\n  [注意] 未找到任何書籤，請確認 PDF 已完成 OCR。')

    if result['warnings']:
        print(f'\n  警告（{len(result["warnings"])} 則）：')
        for w in result['warnings'][:10]:  # 最多印 10 則
            print(f'    ⚠ {w}')
        if len(result['warnings']) > 10:
            print(f'    … 另有 {len(result["warnings"]) - 10} 則警告')

    print(f'\n  完成 → {result["output_path"]}')


if __name__ == '__main__':
    main()
