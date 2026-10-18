#!/usr/bin/env python3
"""Validate an Adym deployment without printing secret values."""
from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation
import os
from pathlib import Path
import stat
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_WEB_ASSETS = (
    "three.module.js",
    "loaders/GLTFLoader.js",
    "utils/BufferGeometryUtils.js",
    "vision/vision_bundle.mjs",
    "vision/face_landmarker.task",
    "vision/selfie_multiclass.tflite",
    "vision/wasm/vision_wasm_internal.js",
    "vision/wasm/vision_wasm_internal.wasm",
    "vision/wasm/vision_wasm_nosimd_internal.js",
    "vision/wasm/vision_wasm_nosimd_internal.wasm",
    "matting/modnet.onnx",
    "matting/ort.wasm.min.mjs",
    "matting/ort-wasm-simd-threaded.mjs",
    "matting/ort-wasm-simd-threaded.wasm",
)


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key and key.replace("_", "").isalnum():
            values[key] = value.strip().strip('"').strip("'")
    return values


def _positive_budget(value: str) -> Decimal | None:
    try:
        parsed = Decimal(value)
        return parsed if parsed > 0 and parsed.is_finite() else None
    except (InvalidOperation, TypeError):
        return None


def _model_ready(root: Path, model: str) -> bool:
    snapshots = (root / "data" / "models" / "huggingface" /
                 ("models--" + model.replace("/", "--")) / "snapshots")
    try:
        candidates = list(snapshots.iterdir())
    except OSError:
        return False
    return any(
        item.is_dir()
        and (item / "config.json").is_file()
        and (item / "preprocessor_config.json").is_file()
        and any(item.glob("model*.safetensors"))
        for item in candidates
    )


def validate(values: dict[str, str], root: Path = ROOT, *, production: bool = False,
             require_payments: bool = False, check_assets: bool = True) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    origin = values.get("PARENTAI_PUBLIC_ORIGIN", "").rstrip("/")
    parsed = urlsplit(origin)
    if production:
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment):
            errors.append("PARENTAI_PUBLIC_ORIGIN должен быть чистым HTTPS-адресом без пути.")
        elif parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
            errors.append("Для сервера нужен публичный HTTPS-домен, а не localhost.")
    elif origin and parsed.scheme not in {"http", "https"}:
        errors.append("PARENTAI_PUBLIC_ORIGIN должен начинаться с http:// или https://.")

    bind = values.get("PARENTAI_BIND", "127.0.0.1").strip()
    if production and bind not in {"127.0.0.1", "::1", "localhost"}:
        errors.append("PARENTAI_BIND должен быть локальным: внешний доступ принимает только Caddy.")

    invite = values.get("PARENTAI_INVITE_CODE", "").strip()
    if production and (len(invite) < 16 or "замените" in invite.casefold()):
        errors.append("Для закрытой беты задайте случайный PARENTAI_INVITE_CODE длиной от 16 символов.")

    daily = _positive_budget(values.get("PARENTAI_GLOBAL_DAILY_BUDGET_RUBLES", ""))
    monthly = _positive_budget(values.get("PARENTAI_GLOBAL_MONTHLY_BUDGET_RUBLES", ""))
    if production and daily is None:
        errors.append("Задайте положительный дневной предел расходов.")
    if production and monthly is None:
        errors.append("Задайте положительный месячный предел расходов.")
    if daily is not None and monthly is not None and monthly < daily:
        errors.append("Месячный предел расходов не может быть меньше дневного.")

    if production and not values.get("YANDEX_API_KEY", "").strip():
        errors.append("Не задан YANDEX_API_KEY.")
    if production and not values.get("YANDEX_FOLDER_ID", "").strip():
        errors.append("Не задан YANDEX_FOLDER_ID.")

    engine = values.get("PARENTAI_STT_ENGINE", "local").strip().casefold()
    if engine not in {"local", "yandex"}:
        errors.append("PARENTAI_STT_ENGINE должен быть local или yandex.")
    elif production and engine != "local":
        warnings.append("SpeechKit выбран первым; это увеличит внешние расходы.")

    model = values.get("PARENTAI_STT_MODEL", "openai/whisper-small").strip()
    if production and not _model_ready(root, model):
        errors.append("Локальный Whisper не установлен: выполните setup_speech.py.")

    xtts = values.get("PARENTAI_ENABLE_XTTS", "0").strip().casefold()
    if production and xtts not in {"0", "false", "no"}:
        errors.append("XTTS-v2 нужно выключить для публичной/платной беты из-за лицензии модели.")

    merchant = bool(values.get("PLATEGA_MERCHANT_ID", "").strip())
    secret = bool(values.get("PLATEGA_SECRET", "").strip())
    if merchant != secret:
        errors.append("PLATEGA_MERCHANT_ID и PLATEGA_SECRET задаются только вместе.")
    if require_payments and not (merchant and secret):
        errors.append("Для запуска оплаты нужны рабочие реквизиты Platega.")
    elif production and not merchant:
        warnings.append("Platega пока не подключена; кнопки покупки покажут временное сообщение.")

    data = root / "data"
    try:
        data.mkdir(parents=True, exist_ok=True)
    except OSError:
        errors.append("Каталог data невозможно создать.")
    else:
        if not os.access(data, os.R_OK | os.W_OK | os.X_OK):
            errors.append("У пользователя приложения нет прав на чтение и запись каталога data.")

    for relative in ("billing.json", "web/avatar.html", "web/app.js"):
        if not (root / relative).is_file():
            errors.append(f"Не найден обязательный файл {relative}.")
    if check_assets:
        missing = [name for name in REQUIRED_WEB_ASSETS
                   if not (root / "web" / "vendor" / name).is_file()]
        if missing:
            errors.append("Не загружены ресурсы камеры: выполните download_assets.py.")
    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description="Проверка готовности Адым к запуску на сервере")
    parser.add_argument("--env", type=Path, default=ROOT / "parentai.env")
    parser.add_argument("--production", action="store_true")
    parser.add_argument("--require-payments", action="store_true")
    parser.add_argument("--skip-assets", action="store_true", help="Только для подготовки до загрузки моделей")
    args = parser.parse_args()
    if not args.env.is_file():
        print(f"ОШИБКА: не найден файл настроек {args.env}", file=sys.stderr)
        return 1
    values = read_env(args.env)
    values.update({key: value for key, value in os.environ.items() if key in values or
                   key.startswith("PARENTAI_") or key.startswith("YANDEX_") or
                   key.startswith("PLATEGA_")})
    errors, warnings = validate(values, ROOT, production=args.production,
                                require_payments=args.require_payments,
                                check_assets=not args.skip_assets)
    try:
        mode = stat.S_IMODE(args.env.stat().st_mode)
        if mode & 0o007 or mode & 0o020:
            warnings.append("Ограничьте права parentai.env до 600 или 640.")
    except OSError:
        pass
    for message in warnings:
        print(f"ПРЕДУПРЕЖДЕНИЕ: {message}")
    for message in errors:
        print(f"ОШИБКА: {message}", file=sys.stderr)
    if errors:
        print(f"Проверка не пройдена: ошибок — {len(errors)}.", file=sys.stderr)
        return 1
    print("Проверка пройдена: конфигурация и файлы готовы к запуску.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
