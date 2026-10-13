@echo off
chcp 65001 >nul
rem ダブルクリックで起動（Windows用）
cd /d "%~dp0"

where py >nul 2>nul && (set PY=py -3.14) || (set PY=python)
%PY% --version >nul 2>nul || (
  echo Python 3.14 が見つかりません。https://www.python.org/downloads/ からインストールしてください。
  echo インストール時に「Add Python to PATH」にチェックを入れてください。
  start "" "https://www.python.org/downloads/"
  pause
  exit /b 1
)

%PY% -c "import sys; sys.exit(not ((3,10) <= sys.version_info[:2] <= (3,14)))" || (
  echo このアプリは Python 3.10～3.14 で動きます（3.15 以降はまだ非対応です）。
  echo Python 3.14 をインストールしてから、もう一度起動してください。
  pause
  exit /b 1
)

if not exist .venv (
  echo 初回セットアップ中です（数分かかります）...
  %PY% -m venv .venv || (pause ^& exit /b 1)
)
.venv\Scripts\python -m pip install -q --upgrade pip
.venv\Scripts\python -m pip install -q -U -r requirements.txt || (echo インストールに失敗しました。 ^& pause ^& exit /b 1)

echo.
echo アプリを起動しました。ブラウザが開きます。
echo 終了するときは、このウィンドウを閉じてください。
start "" /b cmd /c "timeout /t 5 >nul & start http://localhost:8501"
.venv\Scripts\python -m streamlit run app.py
pause
