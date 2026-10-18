#!/usr/bin/env python3
"""Check the public Adym endpoint after deployment."""
from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def request(url: str):
    value = urllib.request.Request(url, headers={"User-Agent": "Adym deployment check/1"})
    return urllib.request.urlopen(value, timeout=20, context=ssl.create_default_context())


def main() -> int:
    parser = argparse.ArgumentParser(description="Проверка опубликованного сервиса Адым")
    parser.add_argument("origin", help="Например https://app.adym.ru")
    parser.add_argument("--allow-http", action="store_true", help="Только для локальной проверки")
    args = parser.parse_args()
    origin = args.origin.rstrip("/")
    parsed = urlsplit(origin)
    if parsed.scheme not in ({"http", "https"} if args.allow_http else {"https"}) or not parsed.hostname:
        print("ОШИБКА: укажите корректный HTTPS origin.", file=sys.stderr)
        return 2
    checks: list[str] = []
    try:
        with request(origin + "/api/health") as response:
            health = json.loads(response.read(64_000))
            if response.status != 200 or health != {"ok": True, "service": "adym"}:
                raise ValueError("health endpoint вернул неожиданный ответ")
            checks.append("health endpoint")
        with request(origin + "/") as response:
            body = response.read(2_000_000)
            if response.status != 200 or "Адым".encode() not in body:
                raise ValueError("главная страница приложения не загрузилась")
            required = {
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Content-Security-Policy": "default-src 'self'",
                "Permissions-Policy": "camera=(self)",
            }
            for header, fragment in required.items():
                if fragment not in response.headers.get(header, ""):
                    raise ValueError(f"нет защитного заголовка {header}")
            if parsed.scheme == "https" and "max-age=" not in response.headers.get("Strict-Transport-Security", ""):
                raise ValueError("нет HSTS")
            checks.extend(("интерфейс", "защитные заголовки", "HTTPS" if parsed.scheme == "https" else "HTTP"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
        print(f"ОШИБКА: {exc}", file=sys.stderr)
        return 1
    print("Проверка опубликованного сервиса пройдена: " + ", ".join(checks) + ".")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
