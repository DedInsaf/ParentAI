"""Local account administration. This command never writes credentials to the repository."""
from __future__ import annotations

import argparse
from getpass import getpass
import secrets

from auth import AuthStore
from runtime import DATA


def _password(args):
    if args.generate_password:
        return secrets.token_urlsafe(18)
    first = getpass("Новый пароль: ")
    second = getpass("Повторите пароль: ")
    if first != second:
        raise SystemExit("Пароли не совпадают.")
    return first


def main():
    parser = argparse.ArgumentParser(description="Управление локальными аккаунтами ParentAI")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-admin", help="Создать администратора без лимитов продукта")
    create.add_argument("--login", default="admin")
    create.add_argument("--email", default="admin@parentai.local")
    create.add_argument("--generate-password", action="store_true",
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
