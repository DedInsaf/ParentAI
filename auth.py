"""Local user accounts backed by SQLite. Passwords are never stored verbatim."""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import pbkdf2_hmac, sha256
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import unicodedata


PASSWORD_ITERATIONS = 600_000
# Remember a device, but do not leave a stolen session valid for years.
SESSION_LIFETIME = 30 * 24 * 60 * 60
MAX_SESSION_LIFETIME = 90 * 24 * 60 * 60
LOGIN_FAILURE_WINDOW = 300
MAX_LOGIN_FAILURES = 10
TERMS_VERSION = "2026-10-31"
PRIVACY_CONSENT_VERSION = "2026-10-31"
AVATAR_CONSENT_VERSION = "2026-10-23"
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TELEGRAM_RE = re.compile(r"^[A-Za-z0-9_]{5,32}$")


@dataclass(frozen=True)
class User:
    id: int
    login: str
    email: str
    role: str = "parent"
    telegram_username: str = ""
    terms_version: str = ""
    privacy_consent_version: str = ""
    avatar_consent_version: str = ""

    def public(self):
        return {"id": self.id, "login": self.login, "email": self.email,
                "role": self.role, "telegram_username": self.telegram_username,
                "is_admin": self.role == "admin",
                "legal_current": (self.terms_version == TERMS_VERSION and
                                  self.privacy_consent_version == PRIVACY_CONSENT_VERSION),
                "avatar_consent_current": self.avatar_consent_version == AVATAR_CONSENT_VERSION}


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


def _validate_telegram(value) -> str:
    if not isinstance(value, str):
        raise ValueError("Введите Telegram username.")
    username = unicodedata.normalize("NFKC", value).strip()
    if username.startswith("@"):
        username = username[1:]
    if not TELEGRAM_RE.fullmatch(username):
        raise ValueError("Введите Telegram username: от 5 до 32 латинских букв, цифр или _.")
    return "@" + username


class AuthStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA secure_delete = ON")
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
                    role TEXT NOT NULL DEFAULT 'parent',
                    terms_accepted_at INTEGER,
                    terms_version TEXT,
                    parent_confirmed INTEGER NOT NULL DEFAULT 0,
                    is_banned INTEGER NOT NULL DEFAULT 0,
                    banned_at INTEGER,
                    ban_reason TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash BLOB PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS password_resets (
                    token_hash BLOB PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    invalidated INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id, created_at);
                CREATE TABLE IF NOT EXISTS email_verifications (
                    token_hash BLOB PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    invalidated INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS email_verifications_user ON email_verifications(user_id,created_at);
                CREATE TABLE IF NOT EXISTS login_failures (
                    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    attempts INTEGER NOT NULL,
                    window_started_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS admin_audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    admin_user_id INTEGER NOT NULL,
                    target_user_id INTEGER NOT NULL,
                    target_login TEXT NOT NULL,
                    action TEXT NOT NULL,
                    details TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS admin_audit_created_at ON admin_audit(created_at DESC);
                CREATE TABLE IF NOT EXISTS account_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    event TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    details TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS account_events_user_created
                    ON account_events(user_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS account_events_created
                    ON account_events(created_at DESC);
                CREATE TABLE IF NOT EXISTS device_registrations (
                    device_hash BLOB PRIMARY KEY,
                    user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
                    registered_at INTEGER NOT NULL
                );
                """
            )

            columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
            # Existing accounts retain access; do not label their emails as verified.
            if 'email_verification_required' not in columns:
                connection.execute('ALTER TABLE users ADD COLUMN email_verification_required INTEGER NOT NULL DEFAULT 0')
            if 'email_verified_at' not in columns:
                connection.execute('ALTER TABLE users ADD COLUMN email_verified_at INTEGER')
            if 'pending_device_hash' not in columns:
                connection.execute('ALTER TABLE users ADD COLUMN pending_device_hash BLOB')
            if 'registration_plan' not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN registration_plan TEXT NOT NULL DEFAULT ''")
            if "role" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'parent'")
            if "terms_accepted_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER")
            if "terms_version" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN terms_version TEXT")
            if "parent_confirmed" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN parent_confirmed INTEGER NOT NULL DEFAULT 0")
            if "is_banned" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0")
            if "banned_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN banned_at INTEGER")
            if "ban_reason" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''")
            if "last_login_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN last_login_at INTEGER")
            if "login_count" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0")
            if "last_seen_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN last_seen_at INTEGER")
            if "last_logout_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN last_logout_at INTEGER")
            if "telegram_username" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN telegram_username TEXT NOT NULL DEFAULT ''")
            if "billing_contact_updated_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN billing_contact_updated_at INTEGER")
            if "privacy_consent_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN privacy_consent_at INTEGER")
            if "privacy_consent_version" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN privacy_consent_version TEXT")
            if "avatar_consent_at" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN avatar_consent_at INTEGER")
            if "avatar_consent_version" not in columns:
                connection.execute("ALTER TABLE users ADD COLUMN avatar_consent_version TEXT")
            session_columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
            if "last_seen_at" not in session_columns:
                connection.execute("ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER")
            connection.execute(
                """UPDATE admin_audit SET target_login='[deleted]',details='{}'
                   WHERE target_user_id NOT IN (SELECT id FROM users)""")

    def register(self, login, email, password, password_confirmation, role="parent",
                 legal_accepted=True, privacy_accepted=True, parent_confirmed=True, device_token=None,
                 telegram_username=None, require_email_verification=False, requested_plan=None) -> User:
        if role not in ("parent", "admin"):
            raise ValueError("Неизвестная роль пользователя.")
        display_login, normalized_login = _validate_login(login)
        display_email, normalized_email = _validate_email(email)
        telegram = _validate_telegram(telegram_username) if telegram_username is not None else ""
        _validate_password(password)
        if password != password_confirmation:
            raise ValueError("Пароли не совпадают.")
        if not legal_accepted or not privacy_accepted or not parent_confirmed:
            raise ValueError("Подтвердите совершеннолетие, соглашение и согласие на обработку данных.")
        salt = os.urandom(16)
        digest = pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
        device_hash = None
        if device_token is not None:
            if not isinstance(device_token, str) or not 20 <= len(device_token) <= 200:
                raise ValueError("Не удалось определить устройство. Обновите страницу и повторите.")
            device_hash = sha256(device_token.encode("utf-8")).digest()
        try:
            with self._connect() as connection:
                if device_hash is not None and connection.execute(
                        "SELECT 1 FROM device_registrations WHERE device_hash=?", (device_hash,)
                ).fetchone():
                    raise ValueError(
                        "На этом устройстве уже создан аккаунт. Войдите в него или восстановите доступ."
                    )
                cursor = connection.execute(
                    """INSERT INTO users
                       (login, login_normalized, email, email_normalized, password_salt,
                        password_hash, password_iterations, created_at, role,
                        terms_accepted_at, terms_version, parent_confirmed, telegram_username,
                        billing_contact_updated_at,privacy_consent_at,privacy_consent_version)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (display_login, normalized_login, display_email, normalized_email, salt,
                     digest, PASSWORD_ITERATIONS, int(time.time()), role, int(time.time()),
                     TERMS_VERSION, 1, telegram, int(time.time()) if telegram else None,
                     int(time.time()), PRIVACY_CONSENT_VERSION),
                )
                user_id = cursor.lastrowid
                connection.execute(
                    "INSERT INTO account_events(user_id,event,created_at) VALUES (?, 'registered', ?)",
                    (user_id, int(time.time())),
                )
                if require_email_verification:
                    plan=requested_plan if requested_plan in ('paid','ultra') else ''
                    connection.execute('UPDATE users SET email_verification_required=1,pending_device_hash=?,registration_plan=? WHERE id=?',
                                       (device_hash,plan,user_id))
                elif device_hash is not None:
                    connection.execute(
                        "INSERT INTO device_registrations(device_hash,user_id,registered_at) VALUES (?,?,?)",
                        (device_hash, user_id, int(time.time())),
                    )
                return User(user_id, display_login, display_email, role, telegram,
                            TERMS_VERSION, PRIVACY_CONSENT_VERSION, "")
        except sqlite3.IntegrityError:
            with self._connect() as connection:
                device_taken = device_hash is not None and connection.execute(
                    "SELECT 1 FROM device_registrations WHERE device_hash = ?", (device_hash,)
                ).fetchone()
                login_taken = connection.execute(
                    "SELECT 1 FROM users WHERE login_normalized = ?", (normalized_login,)
                ).fetchone()
            if device_taken:
                raise ValueError(
                    "На этом устройстве уже создан аккаунт. Войдите в него или восстановите доступ."
                )
            if login_taken:
                raise ValueError("Этот логин уже занят.")
            raise ValueError("Аккаунт с этой почтой уже существует.")

    def authenticate(self, identifier, password) -> User | None:
        return self.authenticate_with_status(identifier, password)[0]

    def remember_device(self, user_id, device_token):
        """Associate an existing account with a browser without exposing the raw token."""
        if not isinstance(device_token, str) or not 20 <= len(device_token) <= 200:
            return
        device_hash = sha256(device_token.encode("utf-8")).digest()
        with self._connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO device_registrations(device_hash,user_id,registered_at) VALUES (?,?,?)",
                (device_hash, int(user_id), int(time.time())),
            )

    def authenticate_with_status(self, identifier, password):
        if not isinstance(identifier, str) or not isinstance(password, str):
            return None, "invalid"
        if len(identifier) > 254:
            return None, "invalid"
        normalized = _normalized(identifier)
        if not normalized or len(password) > 128:
            return None, "invalid"
        field = "email_normalized" if "@" in normalized else "login_normalized"
        with self._connect() as connection:
            row = connection.execute(f"SELECT * FROM users WHERE {field} = ?", (normalized,)).fetchone()
            failure = connection.execute(
                "SELECT attempts,window_started_at FROM login_failures WHERE user_id=?",
                (row['id'],)).fetchone() if row else None
        now = int(time.time())
        if failure and failure['window_started_at'] > now-LOGIN_FAILURE_WINDOW and failure['attempts'] >= MAX_LOGIN_FAILURES:
            return None, "throttled"
        if row is None:
            # Keep the expensive path for unknown accounts too, reducing identifier probing signals.
            pbkdf2_hmac("sha256", password.encode("utf-8"), b"\0" * 16, PASSWORD_ITERATIONS)
            return None, "invalid"
        candidate = pbkdf2_hmac(
            "sha256", password.encode("utf-8"), row["password_salt"], row["password_iterations"]
        )
        if not hmac.compare_digest(candidate, row["password_hash"]):
            with self._connect() as connection:
                connection.execute(
                    """INSERT INTO login_failures(user_id,attempts,window_started_at) VALUES (?,1,?)
                       ON CONFLICT(user_id) DO UPDATE SET
                       attempts=CASE WHEN window_started_at<=? THEN 1 ELSE attempts+1 END,
                       window_started_at=CASE WHEN window_started_at<=? THEN excluded.window_started_at ELSE window_started_at END""",
                    (row['id'], now, now-LOGIN_FAILURE_WINDOW, now-LOGIN_FAILURE_WINDOW))
                connection.execute(
                    "INSERT INTO account_events(user_id,event,created_at,details) VALUES (?,'login_failed',?,'{}')",
                    (row['id'], now))
            return None, "invalid"
        if row["is_banned"]:
            return None, "banned"
        if row['email_verification_required'] and not row['email_verified_at']:
            return None, 'unverified'
        with self._connect() as connection:
            connection.execute("DELETE FROM login_failures WHERE user_id=?", (row['id'],))
        return User(row["id"], row["login"], row["email"], row["role"],
                    row["telegram_username"], row["terms_version"] or "",
                    row["privacy_consent_version"] or "",
                    row["avatar_consent_version"] or ""), "ok"

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self._connect() as connection:
            active = connection.execute(
                """SELECT 1 FROM users WHERE id=? AND is_banned=0
                   AND (email_verification_required=0 OR email_verified_at IS NOT NULL)""", (int(user_id),)
            ).fetchone()
            if not active:
                raise ValueError("Подтвердите почту. Также проверьте, что аккаунт не заблокирован или удалён.")
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            connection.execute("""DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN
                (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 4)""",
                (user_id,user_id))
            connection.execute(
                "INSERT INTO sessions(token_hash,user_id,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?)",
                (sha256(token.encode()).digest(), user_id, now + SESSION_LIFETIME, now, now),
            )
            connection.execute(
                "UPDATE users SET last_login_at=?,last_seen_at=?,login_count=login_count+1 WHERE id=?",
                (now, now, user_id),
            )
            connection.execute(
                "INSERT INTO account_events(user_id,event,created_at) VALUES (?, 'login', ?)",
                (user_id, now),
            )
        return token

    def user_for_session(self, token, *, renew=False) -> User | None:
        if not isinstance(token, str) or not token:
            return None
        now = int(time.time())
        token_hash = sha256(token.encode()).digest()
        with self._connect() as connection:
            row = connection.execute(
                """SELECT users.id, users.login, users.email, users.role, users.telegram_username,
                          users.terms_version,users.privacy_consent_version,users.avatar_consent_version
                   FROM sessions JOIN users ON users.id = sessions.user_id
                   WHERE sessions.token_hash = ? AND sessions.expires_at > ?
                     AND sessions.created_at > ?
                     AND users.is_banned = 0
                     AND (users.email_verification_required=0 OR users.email_verified_at IS NOT NULL)""",
                (token_hash, now, now-MAX_SESSION_LIFETIME),
            ).fetchone()
            if row and renew:
                connection.execute(
                    """UPDATE sessions SET expires_at=?,last_seen_at=?
                       WHERE token_hash=? AND COALESCE(last_seen_at,0)<?""",
                    (now + SESSION_LIFETIME, now, token_hash, now - 300),
                )
                connection.execute(
                    "UPDATE users SET last_seen_at=? WHERE id=? AND COALESCE(last_seen_at,0)<?",
                    (now, row["id"], now - 300),
                )
        return User(row["id"], row["login"], row["email"], row["role"],
                    row["telegram_username"], row["terms_version"] or "",
                    row["privacy_consent_version"] or "",
                    row["avatar_consent_version"] or "") if row else None

    def update_billing_contact(self, user_id, telegram_username) -> User:
        """Store the buyer contact required before starting a payment."""
        telegram = _validate_telegram(telegram_username)
        now = int(time.time())
        with self._connect() as connection:
            cursor = connection.execute(
                "UPDATE users SET telegram_username=?,billing_contact_updated_at=? WHERE id=?",
                (telegram, now, int(user_id)),
            )
            if cursor.rowcount != 1:
                raise ValueError("Пользователь не найден.")
            row = connection.execute(
                """SELECT id,login,email,role,telegram_username,terms_version,
                          privacy_consent_version,avatar_consent_version FROM users WHERE id=?""",
                (int(user_id),),
            ).fetchone()
            connection.execute(
                """INSERT INTO account_events(user_id,event,created_at,details)
                   VALUES (?, 'billing_contact_updated', ?, '{}')""",
                (int(user_id), now),
            )
        return User(row["id"], row["login"], row["email"], row["role"],
                    row["telegram_username"], row["terms_version"] or "",
                    row["privacy_consent_version"] or "",
                    row["avatar_consent_version"] or "")

    def record_consent(self, user_id, kind, accepted) -> User:
        """Record separate, versioned consent without bundling it into another document."""
        if accepted is not True:
            raise ValueError("Согласие не подтверждено.")
        now = int(time.time())
        with self._connect() as connection:
            if kind == "legal":
                connection.execute(
                    """UPDATE users SET terms_accepted_at=?,terms_version=?,parent_confirmed=1,
                              privacy_consent_at=?,privacy_consent_version=? WHERE id=?""",
                    (now, TERMS_VERSION, now, PRIVACY_CONSENT_VERSION, int(user_id)),
                )
                event = "legal_consent_updated"
            elif kind == "avatar":
                connection.execute(
                    "UPDATE users SET avatar_consent_at=?,avatar_consent_version=? WHERE id=?",
                    (now, AVATAR_CONSENT_VERSION, int(user_id)),
                )
                event = "avatar_consent_recorded"
            else:
                raise ValueError("Неизвестный вид согласия.")
            connection.execute(
                "INSERT INTO account_events(user_id,event,created_at,details) VALUES (?,?,?,'{}')",
                (int(user_id), event, now),
            )
            row = connection.execute("SELECT * FROM users WHERE id=?", (int(user_id),)).fetchone()
        if not row:
            raise ValueError("Пользователь не найден.")
        return User(row["id"], row["login"], row["email"], row["role"],
                    row["telegram_username"], row["terms_version"] or "",
                    row["privacy_consent_version"] or "",
                    row["avatar_consent_version"] or "")

    def record_checkout_identity(self, user_id, plan) -> None:
        """Verify and audit buyer identity before a payment is created."""
        now = int(time.time())
        with self._connect() as connection:
            row = connection.execute(
                "SELECT email,telegram_username FROM users WHERE id=?", (int(user_id),)
            ).fetchone()
            if not row or not row["email"] or not row["telegram_username"]:
                raise ValueError("Перед оплатой укажите почту и Telegram username в аккаунте.")
            connection.execute(
                """INSERT INTO account_events(user_id,event,created_at,details)
                   VALUES (?, 'checkout_identity_verified', ?, ?)""",
                (int(user_id), now, json.dumps({"plan": str(plan)}, ensure_ascii=False)),
            )

    def set_role(self, identifier, role):
        if role not in ("parent", "admin"):
            raise ValueError("Неизвестная роль пользователя.")
        normalized = _normalized(identifier)
        field = "email_normalized" if "@" in normalized else "login_normalized"
        with self._connect() as connection:
            cursor = connection.execute(f"UPDATE users SET role=? WHERE {field}=?", (role, normalized))
        if cursor.rowcount != 1:
            raise ValueError("Пользователь не найден.")

    def registration_plan(self, email):
        _,normalized=_validate_email(email)
        with self._connect() as connection:
            row=connection.execute('SELECT registration_plan FROM users WHERE email_normalized=?',(normalized,)).fetchone()
        return row['registration_plan'] if row and row['registration_plan'] in ('paid','ultra') else ''

    def request_email_verification(self, email):
        _, normalized = _validate_email(email)
        now = int(time.time())
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('DELETE FROM email_verifications WHERE created_at<?', (now-86400,))
            user = connection.execute('''SELECT id,email FROM users WHERE email_normalized=? AND is_banned=0
                AND email_verification_required=1 AND email_verified_at IS NULL''', (normalized,)).fetchone()
            if not user:
                return None
            recent = connection.execute('SELECT created_at FROM email_verifications WHERE user_id=? AND created_at>?',
                                        (user['id'],now-3600)).fetchall()
            if len(recent)>=5 or any(row['created_at']>now-60 for row in recent):
                return None
            token = secrets.token_urlsafe(32)
            connection.execute('UPDATE email_verifications SET invalidated=1 WHERE user_id=?', (user['id'],))
            connection.execute('INSERT INTO email_verifications VALUES (?,?,?,?,0)',
                               (sha256(token.encode()).digest(),user['id'],now,now+86400))
            return user['email'], token

    def invalidate_email_verification(self, token):
        with self._connect() as connection:
            connection.execute('UPDATE email_verifications SET invalidated=1 WHERE token_hash=?',
                               (sha256(token.encode()).digest(),))

    def verify_email(self, token, password):
        if not isinstance(token,str) or not 40<=len(token)<=100:
            raise ValueError('Ссылка недействительна или устарела. Запросите новое письмо.')
        if not isinstance(password,str) or not 8<=len(password)<=128:
            raise ValueError('Введите пароль, который вы указали при регистрации.')
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('''SELECT u.* FROM email_verifications v JOIN users u ON u.id=v.user_id
                WHERE v.token_hash=? AND v.invalidated=0 AND v.expires_at>? AND u.is_banned=0
                AND u.email_verification_required=1 AND u.email_verified_at IS NULL''',
                (sha256(token.encode()).digest(),int(time.time()))).fetchone()
            if not row:
                raise ValueError('Ссылка недействительна или устарела. Запросите новое письмо.')
            if not hmac.compare_digest(pbkdf2_hmac('sha256',password.encode(),row['password_salt'],
                                                 row['password_iterations']),row['password_hash']):
                raise ValueError('Неверный пароль регистрации. Если забыли его, воспользуйтесь восстановлением пароля.')
            device_hash=row['pending_device_hash']
            if device_hash:
                if connection.execute('SELECT 1 FROM device_registrations WHERE device_hash=?', (device_hash,)).fetchone():
                    raise ValueError('На устройстве регистрации уже создан аккаунт. Обратитесь в поддержку.')
                connection.execute('INSERT INTO device_registrations(device_hash,user_id,registered_at) VALUES (?,?,?)',
                                   (device_hash,row['id'],int(time.time())))
            connection.execute('UPDATE users SET email_verified_at=?,pending_device_hash=NULL WHERE id=?',
                               (int(time.time()),row['id']))
            connection.execute('DELETE FROM email_verifications WHERE user_id=?', (row['id'],))
            connection.execute("INSERT INTO account_events(user_id,event,created_at,details) VALUES (?,'email_verified',?,'{}')",
                               (row['id'],int(time.time())))

    def request_password_reset(self, email):
        _, normalized = _validate_email(email)
        now = int(time.time())
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            connection.execute('DELETE FROM password_resets WHERE created_at < ?', (now-86400,))
            user = connection.execute('SELECT id,email FROM users WHERE email_normalized=? AND is_banned=0',
                                      (normalized,)).fetchone()
            if not user:
                return None
            recent = connection.execute('SELECT created_at FROM password_resets WHERE user_id=? AND created_at>?',
                                        (user['id'], now-3600)).fetchall()
            if len(recent) >= 5 or any(row['created_at'] > now-60 for row in recent):
                return None
            token = secrets.token_urlsafe(32)
            connection.execute('UPDATE password_resets SET invalidated=1 WHERE user_id=?', (user['id'],))
            connection.execute('INSERT INTO password_resets VALUES (?,?,?,?,0)',
                               (sha256(token.encode()).digest(), user['id'], now, now+1800))
            return user['email'], token

    def invalidate_password_reset(self, token):
        with self._connect() as connection:
            connection.execute('UPDATE password_resets SET invalidated=1 WHERE token_hash=?',
                               (sha256(token.encode()).digest(),))

    def reset_password(self, token, new_password, confirmation, *, device_token=None):
        _validate_password(new_password)
        if new_password != confirmation:
            raise ValueError('Пароли не совпадают.')
        if not isinstance(token, str) or not 40 <= len(token) <= 100:
            raise ValueError('Ссылка недействительна или устарела. Запросите новое письмо.')
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('''SELECT r.user_id,u.email_verification_required,u.email_verified_at
                FROM password_resets r JOIN users u ON u.id=r.user_id
                WHERE r.token_hash=? AND r.invalidated=0 AND r.expires_at>? AND u.is_banned=0''',
                (sha256(token.encode()).digest(), int(time.time()))).fetchone()
            if not row:
                raise ValueError('Ссылка недействительна или устарела. Запросите новое письмо.')
            user_id = row['user_id']
            if row['email_verification_required'] and not row['email_verified_at'] and device_token is not None:
                # Recovery may be the mailbox owner's first activation. Claim their device,
                # not the device of someone who might have supplied a foreign email.
                if not isinstance(device_token,str) or not 20<=len(device_token)<=200:
                    raise ValueError('Не удалось определить устройство. Обновите страницу.')
                device_hash=sha256(device_token.encode()).digest()
                if connection.execute('SELECT 1 FROM device_registrations WHERE device_hash=?',(device_hash,)).fetchone():
                    raise ValueError('На этом устройстве уже создан аккаунт. Войдите в него или обратитесь в поддержку.')
                connection.execute('INSERT INTO device_registrations(device_hash,user_id,registered_at) VALUES (?,?,?)',
                                   (device_hash,user_id,int(time.time())))
            salt = os.urandom(16)
            digest = pbkdf2_hmac('sha256', new_password.encode(), salt, PASSWORD_ITERATIONS)
            connection.execute('UPDATE users SET password_salt=?,password_hash=?,password_iterations=? WHERE id=?',
                               (salt, digest, PASSWORD_ITERATIONS, user_id))
            # A reset proves mailbox ownership and replaces any password chosen by someone else.
            connection.execute('UPDATE users SET email_verified_at=?,pending_device_hash=NULL WHERE id=?',
                               (int(time.time()),user_id))
            connection.execute('DELETE FROM email_verifications WHERE user_id=?', (user_id,))
            for table in ('sessions', 'login_failures', 'password_resets'):
                connection.execute(f'DELETE FROM {table} WHERE user_id=?', (user_id,))
            connection.execute("INSERT INTO account_events(user_id,event,created_at,details) VALUES (?,'password_reset',?,'{}')",
                               (user_id, int(time.time())))

    def change_password(self, user_id, current_password, new_password, confirmation):
        _validate_password(new_password)
        if new_password != confirmation:
            raise ValueError('Пароли не совпадают.')
        if not isinstance(current_password,str) or not 1 <= len(current_password) <= 128:
            raise ValueError('Неверный текущий пароль.')
        with self._connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            row=connection.execute('SELECT * FROM users WHERE id=? AND is_banned=0', (int(user_id),)).fetchone()
            if not row or not hmac.compare_digest(
                    pbkdf2_hmac('sha256',current_password.encode(),row['password_salt'],row['password_iterations']),
                    row['password_hash']):
                raise ValueError('Неверный текущий пароль.')
            salt=os.urandom(16)
            digest=pbkdf2_hmac('sha256',new_password.encode(),salt,PASSWORD_ITERATIONS)
            connection.execute('UPDATE users SET password_salt=?,password_hash=?,password_iterations=? WHERE id=?',
                               (salt,digest,PASSWORD_ITERATIONS,int(user_id)))
            connection.execute('DELETE FROM sessions WHERE user_id=?',(int(user_id),))
            connection.execute('DELETE FROM login_failures WHERE user_id=?',(int(user_id),))
            connection.execute('DELETE FROM password_resets WHERE user_id=?',(int(user_id),))
            connection.execute("INSERT INTO account_events(user_id,event,created_at,details) VALUES (?,'password_changed',?,'{}')",
                               (int(user_id),int(time.time())))

    def verify_password(self, user_id, password) -> bool:
        if not isinstance(password, str) or not password or len(password) > 128:
            return False
        with self._connect() as connection:
            row = connection.execute(
                "SELECT password_salt,password_hash,password_iterations FROM users WHERE id=?",
                (int(user_id),),
            ).fetchone()
        if row is None:
            return False
        candidate = pbkdf2_hmac(
            "sha256", password.encode("utf-8"), row["password_salt"], row["password_iterations"]
        )
        return hmac.compare_digest(candidate, row["password_hash"])

    def list_users(self, search="", limit=50, offset=0):
        """Return bounded account metadata for the administrator panel."""
        search = _normalized(search) if isinstance(search, str) else ""
        try:
            limit = max(1, min(int(limit), 100))
            offset = max(0, int(offset))
        except (TypeError, ValueError):
            limit, offset = 50, 0
        where, params = "", []
        if search:
            where = "WHERE users.login_normalized LIKE ? OR users.email_normalized LIKE ? OR users.telegram_username LIKE ?"
            pattern = f"%{search}%"
            params.extend((pattern, pattern, pattern))
        now = int(time.time())
        with self._connect() as connection:
            total = connection.execute(
                f"SELECT COUNT(*) FROM users {where}", params
            ).fetchone()[0]
            rows = connection.execute(
                f"""SELECT users.id,users.login,users.email,users.telegram_username,users.role,users.created_at,
                            users.last_login_at,users.login_count,users.last_seen_at,users.last_logout_at,
                            users.is_banned,users.banned_at,users.ban_reason,
                            COUNT(sessions.token_hash) AS active_sessions
                     FROM users
                     LEFT JOIN sessions ON sessions.user_id=users.id AND sessions.expires_at>?
                     {where}
                     GROUP BY users.id
                     ORDER BY users.created_at DESC,users.id DESC LIMIT ? OFFSET ?""",
                (now, *params, limit, offset),
            ).fetchall()
        return {
            "total": total,
            "users": [{
                "id": row["id"], "login": row["login"], "email": row["email"],
                "telegram_username": row["telegram_username"],
                "role": row["role"], "created_at": row["created_at"],
                "last_login_at": row["last_login_at"], "login_count": row["login_count"],
                "last_seen_at": row["last_seen_at"], "last_logout_at": row["last_logout_at"],
                "is_banned": bool(row["is_banned"]), "banned_at": row["banned_at"],
                "ban_reason": row["ban_reason"], "active_sessions": row["active_sessions"],
            } for row in rows],
        }

    def user_for_admin(self, user_id):
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id,login,email,telegram_username,role,is_banned FROM users WHERE id=?", (int(user_id),)
            ).fetchone()
        return dict(row) if row else None

    def user_counts(self):
        with self._connect() as connection:
            row = connection.execute(
                """SELECT COUNT(*) AS total,
                          COALESCE(SUM(CASE WHEN is_banned=1 THEN 1 ELSE 0 END),0) AS banned
                   FROM users"""
            ).fetchone()
        return {"total": row["total"], "banned": row["banned"]}

    def set_banned(self, target_user_id, banned, reason=""):
        target_user_id = int(target_user_id)
        reason = " ".join(str(reason or "").split())[:240]
        now = int(time.time())
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id,login,role FROM users WHERE id=?", (target_user_id,)
            ).fetchone()
            if not row:
                raise ValueError("Пользователь не найден.")
            if row["role"] == "admin":
                raise ValueError("Администраторские аккаунты нельзя блокировать из панели.")
            connection.execute(
                "UPDATE users SET is_banned=?,banned_at=?,ban_reason=? WHERE id=?",
                (int(bool(banned)), now if banned else None, reason if banned else "", target_user_id),
            )
            if banned:
                connection.execute("DELETE FROM sessions WHERE user_id=?", (target_user_id,))
        return {"id": row["id"], "login": row["login"], "is_banned": bool(banned)}

    def revoke_user_sessions(self, target_user_id):
        target_user_id = int(target_user_id)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT login,role FROM users WHERE id=?", (target_user_id,)
            ).fetchone()
            if not row:
                raise ValueError("Пользователь не найден.")
            if row["role"] == "admin":
                raise ValueError("Сессии администратора нельзя завершить из панели.")
            cursor = connection.execute("DELETE FROM sessions WHERE user_id=?", (target_user_id,))
        return {"login": row["login"], "revoked_sessions": cursor.rowcount}

    def record_admin_action(self, admin_user_id, target_user_id, target_login, action, details=None):
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO admin_audit
                   (admin_user_id,target_user_id,target_login,action,details,created_at)
                   VALUES (?,?,?,?,?,?)""",
                (int(admin_user_id), int(target_user_id), str(target_login)[:32], str(action)[:40],
                 json.dumps(details or {}, ensure_ascii=False), int(time.time())),
            )

    def admin_audit(self, limit=40):
        try:
            limit = max(1, min(int(limit), 100))
        except (TypeError, ValueError):
            limit = 40
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT admin_audit.id,admin_audit.admin_user_id,admin_audit.target_user_id,
                          admin_audit.target_login,admin_audit.action,admin_audit.details,
                          admin_audit.created_at,users.login AS admin_login
                   FROM admin_audit LEFT JOIN users ON users.id=admin_audit.admin_user_id
                   ORDER BY admin_audit.id DESC LIMIT ?""", (limit,)
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            try:
                item["details"] = json.loads(item["details"])
            except (json.JSONDecodeError, TypeError):
                item["details"] = {}
            result.append(item)
        return result

    def delete_user(self, user_id):
        with self._connect() as connection:
            # Audit rows have no FK: do not retain the deleted family's login
            # or admin-entered personal details in historical moderation data.
            connection.execute(
                "UPDATE admin_audit SET target_login='[deleted]',details='{}' WHERE target_user_id=?",
                (int(user_id),))
            cursor = connection.execute("DELETE FROM users WHERE id=?", (int(user_id),))
        if cursor.rowcount != 1:
            raise ValueError("Аккаунт уже удалён.")

    def delete_session(self, token):
        if not isinstance(token, str) or not token:
            return
        with self._connect() as connection:
            token_hash = sha256(token.encode()).digest()
            row = connection.execute(
                "SELECT user_id FROM sessions WHERE token_hash=?", (token_hash,)
            ).fetchone()
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            if row:
                now = int(time.time())
                connection.execute("UPDATE users SET last_logout_at=? WHERE id=?", (now, row["user_id"]))
                connection.execute(
                    "INSERT INTO account_events(user_id,event,created_at) VALUES (?, 'logout', ?)",
                    (row["user_id"], now),
                )
