#!/bin/bash
# ダブルクリックで起動（Mac用）
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python が見つかりません。https://www.python.org/downloads/ からインストールしてください。"
  open "https://www.python.org/downloads/"
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  exit 1
fi

if ! python3 -c "import sys; sys.exit(not ((3,10) <= sys.version_info[:2] <= (3,14)))"; then
  echo "このアプリは Python 3.10〜3.14 で動きます（3.15 以降はまだ非対応です）。"
  echo "Python 3.14 をインストールしてから、もう一度起動してください。"
  read -n 1 -s -r -p "何かキーを押すと閉じます"
  exit 1
fi

if [ ! -d .venv ]; then
  echo "初回セットアップ中です（数分かかります）..."
  python3 -m venv .venv || exit 1
fi
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -U -r requirements.txt || { read -n 1 -s -r -p "インストールに失敗しました。何かキーを押すと閉じます"; exit 1; }

echo ""
echo "アプリを起動しました。ブラウザが開きます。"
echo "終了するときは、このウィンドウを閉じてください。"
(sleep 4; open "http://localhost:8501") &
.venv/bin/python -m streamlit run app.py
