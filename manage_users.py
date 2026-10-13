"""Local account administration. This command never writes credentials to the repository."""
from __future__ import annotations

import argparse
from getpass import getpass
import secrets

from auth import AuthStore
from runtime import DATA
from usage import UsageStore


def _password(args):
    if args.generate_password:
        return secrets.token_urlsafe(18)
    first = getpass("Новый пароль: ")
    second = getpass("Повторите пароль: ")
    if first != second:
        raise SystemExit("Пароли не совпадают.")
    return first


def main():
    parser = argparse.ArgumentParser(description="Управление локальными аккаунтами Адым")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-admin", help="Создать администратора без лимитов продукта")
    create.add_argument("--login", default="admin")
    create.add_argument("--email", default="admin@adym.local")
    create.add_argument("--generate-password", action="store_true",
                        help="Создать стойкий случайный пароль и показать его один раз")
    test = commands.add_parser(
        "create-test-account", help="Создать локальный тестовый аккаунт Плюс или Ультра")
    test.add_argument("plan", choices=("paid", "ultra"), help="Тестовый тариф")
    test.add_argument("--login", help="Логин; по умолчанию test-plus или test-ultra")
    test.add_argument("--email", help="Почта; по умолчанию локальный адрес @adym.local")
    test.add_argument("--generate-password", action="store_true",
                      help="Создать стойкий случайный пароль и показать его один раз")
    promote = commands.add_parser("promote", help="Назначить существующего пользователя администратором")
    promote.add_argument("identifier", help="Логин или почта")
    args = parser.parse_args()
    store = AuthStore(DATA / "users.sqlite3")
    try:
        if args.command == "promote":
            store.set_role(args.identifier, "admin")
            print(f"Пользователь {args.identifier} теперь администратор.")
            return
        if args.command == "create-test-account":
            suffix = "plus" if args.plan == "paid" else "ultra"
            login = args.login or f"test-{suffix}"
            email = args.email or f"test-{suffix}@adym.local"
            password = _password(args)
            user = store.register(login, email, password, password)
            usage = UsageStore(DATA / "usage.sqlite3")
            usage.set_subscription(user.id, args.plan)
            title = usage.subscription(user.id)["title"]
            print(f"Тестовый аккаунт создан: {user.login} ({user.email}) · {title}")
            if args.generate_password:
                print(f"Пароль: {password}")
                print("Сохраните пароль: повторно он не показывается.")
            return
        password = _password(args)
        user = store.register(args.login, args.email, password, password, role="admin")
        print(f"Администратор создан: {user.login} ({user.email})")
        if args.generate_password:
            print(f"Пароль: {password}")
            print("Сохраните пароль в менеджере паролей: повторно он не показывается.")
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
