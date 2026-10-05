"""
Запуск приложения как настоящего окна, а не веб-страницы в браузере.

    pip install pywebview
    python run_app.py

Открывается обычное окно программы (без адресной строки, без вкладок).
Если на macOS окно не даёт доступ к камере — временный обходной путь:
    python -m http.server 8000 --directory web
и открыть http://localhost:8000/avatar.html в Safari/Chrome — там
разрешения на камеру работают гарантированно, пока не разберёмся
с правами конкретно под pywebview на твоей системе.
"""

import os
import webview

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENTRY_FILE = os.path.join(BASE_DIR, "web", "avatar.html")

if __name__ == "__main__":
    window = webview.create_window(
        "ИИ-Родитель",
        ENTRY_FILE,
        width=1100,
        height=800,
        resizable=True,
        confirm_close=False,
    )
    webview.start()