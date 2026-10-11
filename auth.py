"""Local user accounts backed by SQLite. Passwords are never stored verbatim."""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import pbkdf2_hmac, sha256
import hmac
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import unicodedata


PASSWORD_ITERATIONS = 600_000
SESSION_LIFETIME = 30 * 24 * 60 * 60
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass(frozen=True)
class User:
    id: int
    login: str
    email: str
    role: str = "parent"

    def public(self):
        return {"id": self.id, "login": self.login, "email": self.email,
                "role": self.role, "is_admin": self.role == "admin"}


def _normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def _validate_login(value) -> tuple[str, str]:
    if not isinstance(value, str):
        raise ValueError("Введите логин.")
    display = unicodedata.normalize("NFKC", value).strip()
    if not 3 <= len(display) <= 32:
        raise ValueError("Логин должен содержать от 3 до 32 символов.")
    if not display[0].isalnum() or not all(char.isalnum() or char in "._-" for char in display):
        raise ValueError("В логине можно использовать буквы, цифры, точку, дефис и подчёркивание.")
    return display, display.casefold()


def _validate_email(value) -> tuple[str, str]:
    if not isinstance(value, str):
        raise ValueError("Введите почту.")
    display = unicodedata.normalize("NFKC", value).strip()
    normalized = display.casefold()
    if len(display) > 254 or not EMAIL_RE.fullmatch(display):
        raise ValueError("Введите корректный адрес почты.")
    return display, normalized


def _validate_password(value):
    if not isinstance(value, str) or len(value) < 8:
        raise ValueError("Пароль должен содержать не менее 8 символов.")
    if len(value) > 128:
        raise ValueError("Пароль слишком длинный.")


class AuthStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self):
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    login TEXT NOT NULL,
                    login_normalized TEXT NOT NULL UNIQUE,
                    email TEXT NOT NULL,
                    email_normalized TEXT NOT NULL UNIQUE,
                    password_salt BLOB NOT NULL,
                    password_hash BLOB NOT NULL,
                    password_iterations INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    role TEXT NOT NULL DEFAULT 'parent'
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash BLOB PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
                """
            )

            columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
            if "role" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'parent'")

    def register(self, login, email, password, password_confirmation, role="parent") -> User:
        if role not in ("parent", "admin"):
            raise ValueError("Неизвестная роль пользователя.")
        display_login, normalized_login = _validate_login(login)
        display_email, normalized_email = _validate_email(email)
        _validate_password(password)
        if password != password_confirmation:
            raise ValueError("Пароли не совпадают.")
        salt = os.urandom(16)
        digest = pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
        try:
            with self._connect() as connection:
                cursor = connection.execute(
                    """INSERT INTO users
                       (login, login_normalized, email, email_normalized, password_salt,
                        password_hash, password_iterations, created_at, role)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (display_login, normalized_login, display_email, normalized_email, salt,
                     digest, PASSWORD_ITERATIONS, int(time.time()), role),
                )
                return User(cursor.lastrowid, display_login, display_email, role)
        except sqlite3.IntegrityError:
            with self._connect() as connection:
                login_taken = connection.execute(
                    "SELECT 1 FROM users WHERE login_normalized = ?", (normalized_login,)
                ).fetchone()
            if login_taken:
                raise ValueError("Этот логин уже занят.")
            raise ValueError("Аккаунт с этой почтой уже существует.")

    def authenticate(self, identifier, password) -> User | None:
        if not isinstance(identifier, str) or not isinstance(password, str):
            return None
        normalized = _normalized(identifier)
        if not normalized or len(password) > 128:
            return None
        field = "email_normalized" if "@" in normalized else "login_normalized"
        with self._connect() as connection:
            row = connection.execute(f"SELECT * FROM users WHERE {field} = ?", (normalized,)).fetchone()
        if row is None:
            # Keep the expensive path for unknown accounts too, reducing identifier probing signals.
            pbkdf2_hmac("sha256", password.encode("utf-8"), b"\0" * 16, PASSWORD_ITERATIONS)
            return None
        candidate = pbkdf2_hmac(
            "sha256", password.encode("utf-8"), row["password_salt"], row["password_iterations"]
        )
        if not hmac.compare_digest(candidate, row["password_hash"]):
            return None
        return User(row["id"], row["login"], row["email"], row["role"])

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            connection.execute(
                "INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (sha256(token.encode()).digest(), user_id, now + SESSION_LIFETIME, now),
            )
        return token

    def user_for_session(self, token) -> User | None:
        if not isinstance(token, str) or not token:
            return None
        now = int(time.time())
        with self._connect() as connection:
            row = connection.execute(
                """SELECT users.id, users.login, users.email, users.role
                   FROM sessions JOIN users ON users.id = sessions.user_id
                   WHERE sessions.token_hash = ? AND sessions.expires_at > ?""",
                (sha256(token.encode()).digest(), now),
            ).fetchone()
        return User(row["id"], row["login"], row["email"], row["role"]) if row else None

    def set_role(self, identifier, role):
        if role not in ("parent", "admin"):
            raise ValueError("Неизвестная роль пользователя.")
        normalized = _normalized(identifier)
        field = "email_normalized" if "@" in normalized else "login_normalized"
        with self._connect() as connection:
            cursor = connection.execute(f"UPDATE users SET role=? WHERE {field}=?", (role, normalized))
        if cursor.rowcount != 1:
            raise ValueError("Пользователь не найден.")

    def delete_session(self, token):
        if not isinstance(token, str) or not token:
            return
        with self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (sha256(token.encode()).digest(),))
