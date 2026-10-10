"""One launch: local API, model workers and camera-capable browser UI."""
import argparse
import threading
import webbrowser
from runtime import Runtime
from server import AppServer


def main():
    parser = argparse.ArgumentParser(description='ИИ-Родитель')
    parser.add_argument('--desktop', action='store_true', help='Окно pywebview (доступ к камере зависит от ОС)')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--no-models', action='store_true', help='Диагностика интерфейса без загрузки моделей')
    parser.add_argument('--port', type=int, default=8767)
    args = parser.parse_args()
    runtime = Runtime()
    try:
        server = AppServer(runtime, args.port)
    except OSError as exc:
        raise SystemExit(f'Не удалось открыть порт {args.port}: {exc}. Используйте --port 0.')
    url = server.origin + '/'
    print(f'ИИ-Родитель: {url}\nДля завершения нажмите Ctrl+C.', flush=True)
    if not args.no_models:
        runtime.start()
    try:
        if args.desktop:
            import webview
            threading.Thread(target=server.serve_forever, daemon=True).start()
            webview.create_window('ИИ-Родитель', url, width=1200, height=900)
            webview.start()
            server.shutdown()
        else:
            if not args.no_browser:
                webbrowser.open(url)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        runtime.close()


if __name__ == '__main__':
    main()
