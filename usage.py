"""Server-side usage metering, subscriptions and privacy-preserving lesson reports."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid


MICROS_PER_RUBLE = 1_000_000
OPERATIONS = {"llm", "stt", "tts"}


def rubles_to_micros(value) -> int:
    return int((Decimal(str(value)) * MICROS_PER_RUBLE).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def micros_to_rubles(value: int) -> str:
    return str((Decimal(int(value)) / MICROS_PER_RUBLE).quantize(Decimal("0.0001")))


def estimate_tokens(text: str) -> int:
    """Conservative fallback only; provider-reported token counts take precedence."""
    return max(1, math.ceil(len(text or "") / 3))


@dataclass(frozen=True)
class BillingConfig:
    values: dict

    @classmethod
    def load(cls, path=None):
        source = Path(path) if path else Path(__file__).with_name("billing.json")
        value = json.loads(source.read_text(encoding="utf-8"))
        if value.get("currency") != "RUB" or not isinstance(value.get("plans"), dict):
            raise ValueError("Некорректная конфигурация тарифов.")
        for name in ("free", "paid", "ultra"):
            if name not in value["plans"]:
                raise ValueError("В конфигурации нужны тарифы Бесплатный, Плюс и Ультра.")
        return cls(value)

    @property
    def warning_ratio(self):
        return Decimal(self.values["warning_ratio"])

    def plan(self, name):
        return self.values["plans"].get(name) or self.values["plans"]["free"]

    def price_micros(self, name):
        return rubles_to_micros(self.values["prices"][name])

    def llm_cost(self, input_tokens, output_tokens=0):
        raw = (Decimal(max(0, input_tokens)) * self.price_micros("llm_input_per_1000_tokens")
               + Decimal(max(0, output_tokens)) * self.price_micros("llm_output_per_1000_tokens")) / 1000
        return int(raw.quantize(Decimal("1"), rounding=ROUND_CEILING))

    def stt_cost(self, billed_seconds):
        blocks = max(0, math.ceil(billed_seconds / 15))
        return blocks * self.price_micros("stt_per_15_seconds")

    def tts_cost(self, blocks):
        return max(0, blocks) * self.price_micros("tts_v3_per_250_chars")


class LimitExceeded(ValueError):
    pass


class UsageStore:
    """SQLite aggregate ledger. It intentionally stores no prompt, transcript or audio."""

    def __init__(self, path, config=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.config = config or BillingConfig.load()
        self.lock = threading.RLock()
        self.global_monthly_budget = rubles_to_micros(
            os.getenv("PARENTAI_GLOBAL_MONTHLY_BUDGET_RUBLES", "0") or "0")
        self.global_daily_budget = rubles_to_micros(
            os.getenv("PARENTAI_GLOBAL_DAILY_BUDGET_RUBLES", "0") or "0")
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
                CREATE TABLE IF NOT EXISTS subscriptions (
                    user_id INTEGER PRIMARY KEY,
                    plan TEXT NOT NULL CHECK(plan IN ('free', 'paid', 'ultra')),
                    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'cancelled')),
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS study_sessions (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    started_at INTEGER NOT NULL,
                    active_started_at INTEGER,
                    active_seconds INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active', 'paused', 'complete'))
                );
                CREATE INDEX IF NOT EXISTS study_sessions_user_started
                    ON study_sessions(user_id, started_at);
                CREATE TABLE IF NOT EXISTS lessons (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    study_session_id TEXT,
                    started_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    hints INTEGER NOT NULL DEFAULT 0,
                    solved_independently INTEGER NOT NULL DEFAULT 0,
                    difficulty INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS lessons_user_started ON lessons(user_id, started_at);
                CREATE TABLE IF NOT EXISTS usage_events (
                    id TEXT PRIMARY KEY,
                    request_id TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    lesson_id TEXT,
                    operation TEXT NOT NULL CHECK(operation IN ('llm', 'stt', 'tts')),
                    state TEXT NOT NULL CHECK(state IN ('pending', 'complete', 'failed')),
                    input_units INTEGER NOT NULL DEFAULT 0,
                    output_units INTEGER NOT NULL DEFAULT 0,
                    duration_ms INTEGER NOT NULL DEFAULT 0,
                    billed_units INTEGER NOT NULL DEFAULT 0,
                    cost_microrubles INTEGER NOT NULL DEFAULT 0,
                    provider TEXT NOT NULL DEFAULT '',
                    model TEXT NOT NULL DEFAULT '',
                    actual_usage INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    completed_at INTEGER,
                    UNIQUE(user_id, operation, request_id)
                );
                CREATE INDEX IF NOT EXISTS usage_user_created ON usage_events(user_id, created_at);
                CREATE INDEX IF NOT EXISTS usage_lesson ON usage_events(lesson_id);
                CREATE TABLE IF NOT EXISTS payment_subscriptions (
                    provider_id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    provider TEXT NOT NULL,
                    plan TEXT NOT NULL CHECK(plan IN ('paid', 'ultra')),
                    amount_rubles INTEGER NOT NULL,
                    currency TEXT NOT NULL,
                    status TEXT NOT NULL,
                    redirect_url TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS payment_user_created
                    ON payment_subscriptions(user_id, created_at);
                """
            )
            self._migrate_schema(connection)

    @staticmethod
    def _migrate_schema(connection):
        """Expand old two-plan databases without discarding subscriptions or usage."""
        lesson_columns = {row[1] for row in connection.execute("PRAGMA table_info(lessons)")}
        if "study_session_id" not in lesson_columns:
            connection.execute("ALTER TABLE lessons ADD COLUMN study_session_id TEXT")
        for table, create_sql, columns in (
            ("subscriptions",
             """CREATE TABLE subscriptions (
                    user_id INTEGER PRIMARY KEY,
                    plan TEXT NOT NULL CHECK(plan IN ('free', 'paid', 'ultra')),
                    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'cancelled')),
                    updated_at INTEGER NOT NULL)""",
             "user_id,plan,status,updated_at"),
            ("payment_subscriptions",
             """CREATE TABLE payment_subscriptions (
                    provider_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
                    provider TEXT NOT NULL, plan TEXT NOT NULL CHECK(plan IN ('paid', 'ultra')),
                    amount_rubles INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL,
                    redirect_url TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)""",
             "provider_id,user_id,provider,plan,amount_rubles,currency,status,redirect_url,created_at,updated_at"),
        ):
            row = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            if row and "ultra" not in (row["sql"] or "").casefold():
                legacy = table + "_before_ultra"
                connection.execute(f"ALTER TABLE {table} RENAME TO {legacy}")
                connection.execute(create_sql)
                connection.execute(f"INSERT INTO {table} ({columns}) SELECT {columns} FROM {legacy}")
                connection.execute(f"DROP TABLE {legacy}")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS payment_user_created ON payment_subscriptions(user_id, created_at)")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS lessons_study_session ON lessons(study_session_id)")

    @staticmethod
    def _month_bounds(now=None):
        value = datetime.fromtimestamp(now or time.time()).astimezone()
        start = value.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if value.month == 12:
            end = start.replace(year=value.year + 1, month=1)
        else:
            end = start.replace(month=value.month + 1)
        return int(start.timestamp()), int(end.timestamp())

    @staticmethod
    def _day_bounds(now=None):
        value = datetime.fromtimestamp(now or time.time()).astimezone()
        start = value.replace(hour=0, minute=0, second=0, microsecond=0)
        return int(start.timestamp()), int(start.timestamp()) + 24 * 60 * 60

    def ensure_subscription(self, user_id):
        now = int(time.time())
        with self._connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO subscriptions(user_id, plan, status, updated_at) VALUES (?, 'free', 'active', ?)",
                (user_id, now),
            )

    def recover_interrupted_events(self):
        """Release reservations left pending when the previous app process stopped."""
        now = int(time.time())
        with self._connect() as connection:
            cursor = connection.execute(
                """UPDATE usage_events SET state='failed', cost_microrubles=0, completed_at=?
                   WHERE state='pending'""", (now,))
        return cursor.rowcount

    def set_subscription(self, user_id, plan, status="active"):
        if plan not in ("free", "paid", "ultra") or status not in ("active", "paused", "cancelled"):
            raise ValueError("Некорректный тариф или статус подписки.")
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO subscriptions(user_id, plan, status, updated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan, status=excluded.status,
                   updated_at=excluded.updated_at""",
                (user_id, plan, status, int(time.time())),
            )

    def subscription(self, user_id):
        self.ensure_subscription(user_id)
        with self._connect() as connection:
            row = connection.execute("SELECT plan, status FROM subscriptions WHERE user_id = ?", (user_id,)).fetchone()
        plan = row["plan"] if row and row["status"] == "active" else "free"
        return {"plan": plan, "status": row["status"] if row else "active", **self.config.plan(plan)}

    def catalog(self):
        return {name: {
            "code": name,
            "title": value["title"],
            "monthly_price_rubles": int(value["monthly_price_rubles"]),
            "sessions": int(value["sessions"]),
            "session_minutes": int(value["session_minutes"]),
            "assignments_per_session": int(value["assignments_per_session"]),
            "yandex_voice_per_session": int(value["yandex_voice_per_session"]),
            "assignments": int(value["assignments"]),
            "llm_requests": int(value["llm_requests"]),
            "stt_billed_seconds": int(value["stt_billed_seconds"]),
            "tts_blocks": int(value["tts_blocks"]),
        } for name, value in self.config.values["plans"].items()}

    def pending_checkout(self, user_id, max_age=15 * 60):
        threshold = int(time.time()) - max_age
        with self._connect() as connection:
            row = connection.execute(
                """SELECT provider_id, plan, redirect_url, status FROM payment_subscriptions
                   WHERE user_id=? AND (status='subscription_activated'
                         OR (status='pending' AND created_at>=?))
                   ORDER BY created_at DESC LIMIT 1""", (user_id, threshold)).fetchone()
        return (dict(row) if row else None)

    def record_checkout(self, user_id, provider_id, redirect_url, amount_rubles, plan="paid"):
        if plan not in ("paid", "ultra"):
            raise ValueError("Некорректный платный тариф.")
        now = int(time.time())
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO payment_subscriptions
                   (provider_id,user_id,provider,plan,amount_rubles,currency,status,redirect_url,created_at,updated_at)
                   VALUES (?,?,'platega',?,?,'RUB','pending',?,?,?)""",
                (provider_id, user_id, plan, int(amount_rubles), redirect_url, now, now))

    def payment_callback(self, provider_id, status, amount, currency):
        if not isinstance(provider_id, str) or not isinstance(status, str):
            raise ValueError("Некорректный callback Platega.")
        normalized = status.strip().upper()
        with self.lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT user_id,plan,amount_rubles,currency FROM payment_subscriptions WHERE provider_id=?",
                (provider_id,)).fetchone()
            if not row:
                raise ValueError("Подписка Platega не найдена.")
            try:
                received_amount = int(amount)
            except (TypeError, ValueError):
                raise ValueError("Platega не передала сумму подписки.") from None
            if received_amount != row["amount_rubles"] or currency != row["currency"]:
                raise ValueError("Сумма или валюта Platega не совпадает с заказом.")
            now = int(time.time())
            connection.execute(
                "UPDATE payment_subscriptions SET status=?,updated_at=? WHERE provider_id=?",
                (normalized.lower(), now, provider_id))
            if normalized == "CONFIRMED":
                connection.execute(
                    """INSERT INTO subscriptions(user_id,plan,status,updated_at) VALUES (?,?,'active',?)
                       ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,status='active',updated_at=excluded.updated_at""",
                    (row["user_id"], row["plan"], now))
            elif normalized in {"CANCELED", "CANCELLED", "CHARGEBACKED",
                                "SUBSCRIPTION_CANCELED", "SUBSCRIPTION_CANCELLED"}:
                connection.execute(
                    """INSERT INTO subscriptions(user_id,plan,status,updated_at) VALUES (?,?,'cancelled',?)
                       ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,status='cancelled',updated_at=excluded.updated_at""",
                    (row["user_id"], row["plan"], now))
        return {"user_id": row["user_id"], "status": normalized}

    def latest_payment(self, user_id):
        with self._connect() as connection:
            row = connection.execute(
                """SELECT provider,plan,status,created_at,updated_at FROM payment_subscriptions
                   WHERE user_id=? ORDER BY created_at DESC LIMIT 1""", (user_id,)).fetchone()
        return dict(row) if row else None

    def delete_user_data(self, user_id):
        """Remove every usage, lesson and subscription row owned by one account."""
        user_id = int(user_id)
        with self.lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            for table in ("usage_events", "lessons", "study_sessions",
                          "payment_subscriptions", "subscriptions"):
                connection.execute(f"DELETE FROM {table} WHERE user_id=?", (user_id,))

    def admin_overviews(self, user_ids):
        """Return aggregate-only account activity for the administrator panel."""
        ids = sorted({int(user_id) for user_id in user_ids if int(user_id) > 0})
        if not ids:
            return {}
        placeholders = ",".join("?" for _ in ids)
        start, end = self._month_bounds()
        result = {user_id: {
            "plan": "free", "plan_title": self.config.plan("free")["title"],
            "subscription_status": "active", "assignments": 0, "hints": 0,
            "external_cost_rubles": "0.0000", "last_activity_at": None,
            "open_sessions": 0,
        } for user_id in ids}
        with self._connect() as connection:
            subscriptions = connection.execute(
                f"SELECT user_id,plan,status FROM subscriptions WHERE user_id IN ({placeholders})", ids
            ).fetchall()
            lessons = connection.execute(
                f"""SELECT user_id,COUNT(*) AS assignments,COALESCE(SUM(hints),0) AS hints,
                            MAX(updated_at) AS last_activity_at
                     FROM lessons WHERE user_id IN ({placeholders}) AND started_at>=? AND started_at<?
                     GROUP BY user_id""", (*ids, start, end)
            ).fetchall()
            costs = connection.execute(
                f"""SELECT user_id,COALESCE(SUM(cost_microrubles),0) AS cost,
                            MAX(created_at) AS last_activity_at
                     FROM usage_events WHERE user_id IN ({placeholders})
                       AND state IN ('pending','complete') AND created_at>=? AND created_at<?
                     GROUP BY user_id""", (*ids, start, end)
            ).fetchall()
            sessions = connection.execute(
                f"""SELECT user_id,COUNT(*) AS open_sessions,MAX(updated_at) AS last_activity_at
                     FROM study_sessions WHERE user_id IN ({placeholders})
                       AND status IN ('active','paused') GROUP BY user_id""", ids
            ).fetchall()
        for row in subscriptions:
            plan = row["plan"] if row["status"] == "active" else "free"
            result[row["user_id"]].update(
                plan=plan, plan_title=self.config.plan(plan)["title"],
                subscription_status=row["status"])
        for rows, fields in ((lessons, ("assignments", "hints")),
                             (sessions, ("open_sessions",))):
            for row in rows:
                item = result[row["user_id"]]
                for field in fields:
                    item[field] = row[field]
                item["last_activity_at"] = max(
                    filter(None, (item["last_activity_at"], row["last_activity_at"])), default=None)
        for row in costs:
            item = result[row["user_id"]]
            item["external_cost_rubles"] = micros_to_rubles(row["cost"])
            item["last_activity_at"] = max(
                filter(None, (item["last_activity_at"], row["last_activity_at"])), default=None)
        return result

    def admin_plan_counts(self):
        with self._connect() as connection:
            row = connection.execute(
                """SELECT COALESCE(SUM(CASE WHEN status='active' AND plan IN ('paid','ultra')
                                             THEN 1 ELSE 0 END),0) AS paid
                   FROM subscriptions"""
            ).fetchone()
        return {"paid": row["paid"]}

    def _active_plan(self, connection, user_id):
        row = connection.execute(
            "SELECT plan,status FROM subscriptions WHERE user_id=?", (user_id,)
        ).fetchone()
        return row["plan"] if row and row["status"] == "active" else "free"

    def start_study_session(self, user_id, unlimited=False):
        """Start or restore a timed session. Empty sessions do not consume a slot."""
        self.ensure_subscription(user_id)
        now = int(time.time())
        session_id = uuid.uuid4().hex
        with self.lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            plan = self._active_plan(connection, user_id)
            minutes = int(self.config.plan(plan)["session_minutes"])
            limit_seconds = minutes * 60
            previous = connection.execute(
                """SELECT id,status,active_started_at,active_seconds,updated_at
                   FROM study_sessions WHERE user_id=? AND status IN ('active','paused')
                   ORDER BY updated_at DESC""", (user_id,)
            ).fetchall()
            restored = None
            for row in previous:
                elapsed = int(row["active_seconds"])
                if row["status"] == "active" and row["active_started_at"] is not None:
                    elapsed += max(0, now - int(row["active_started_at"]))
                if restored is None and (unlimited or elapsed < limit_seconds):
                    restored = {"id": row["id"], "elapsed_seconds": elapsed}
                    connection.execute(
                        """UPDATE study_sessions SET status='active',active_seconds=?,
                           active_started_at=?,updated_at=? WHERE id=?""",
                        (elapsed, now, now, row["id"]),
                    )
                else:
                    connection.execute(
                        """UPDATE study_sessions SET status='complete',active_seconds=?,
                           active_started_at=NULL,updated_at=? WHERE id=?""",
                        (elapsed, now, row["id"]),
                    )
            if restored:
                return {"id": restored["id"], "status": "active", "restored": True,
                        "elapsed_seconds": restored["elapsed_seconds"],
                        "limit_seconds": None if unlimited else limit_seconds}
            if not unlimited:
                start, end = self._month_bounds(now)
                used_sessions = self._totals(connection, user_id, start, end)["sessions"]
                if used_sessions >= int(self.config.plan(plan)["sessions"]):
                    raise LimitExceeded(
                        "Лимит занятий на этот месяц закончился. "
                        "Попросите взрослого открыть раздел «Для родителя»."
                    )
            connection.execute(
                """DELETE FROM study_sessions WHERE user_id=? AND status='complete'
                   AND updated_at<? AND id NOT IN
                       (SELECT DISTINCT study_session_id FROM lessons WHERE study_session_id IS NOT NULL)""",
                (user_id, now - 86400),
            )
            connection.execute(
                """INSERT INTO study_sessions
                   (id,user_id,started_at,active_started_at,active_seconds,updated_at,status)
                   VALUES (?,?,?,?,0,?,'active')""",
                (session_id, user_id, now, now, now),
            )
        return {"id": session_id, "status": "active", "restored": False,
                "elapsed_seconds": 0,
                "limit_seconds": None if unlimited else limit_seconds}

    def control_study_session(self, user_id, session_id, action, unlimited=False):
        if action not in ("pause", "resume", "stop"):
            raise ValueError("Неизвестное действие с занятием.")
        now = int(time.time())
        with self.lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM study_sessions WHERE id=? AND user_id=?", (session_id, user_id)
            ).fetchone()
            if not row:
                raise ValueError("Занятие не найдено. Начните новое занятие.")
            if row["status"] == "complete":
                if action == "stop":
                    plan = self._active_plan(connection, user_id)
                    limit_seconds = int(self.config.plan(plan)["session_minutes"]) * 60
                    return {"id": session_id, "status": "complete",
                            "elapsed_seconds": int(row["active_seconds"]),
                            "limit_seconds": None if unlimited else limit_seconds}
                raise ValueError("Занятие уже завершено. Начните новое занятие.")
            active_seconds = int(row["active_seconds"])
            if row["status"] == "active" and row["active_started_at"] is not None:
                active_seconds += max(0, now - int(row["active_started_at"]))
            plan = self._active_plan(connection, user_id)
            limit_seconds = int(self.config.plan(plan)["session_minutes"]) * 60
            if (action == "pause" and row["status"] == "paused") or (
                    action == "resume" and row["status"] == "active"):
                return {"id": session_id, "status": row["status"],
                        "elapsed_seconds": active_seconds,
                        "limit_seconds": None if unlimited else limit_seconds}
            if action == "resume" and not unlimited and active_seconds >= limit_seconds:
                raise LimitExceeded("Время занятия закончилось. Начните новое занятие.")
            status = "complete" if action == "stop" else ("paused" if action == "pause" else "active")
            active_started_at = now if status == "active" else None
            connection.execute(
                """UPDATE study_sessions SET status=?,active_seconds=?,active_started_at=?,updated_at=?
                   WHERE id=? AND user_id=?""",
                (status, active_seconds, active_started_at, now, session_id, user_id),
            )
        return {"id": session_id, "status": status,
                "elapsed_seconds": active_seconds,
                "limit_seconds": None if unlimited else limit_seconds}

    def validate_study_session(self, user_id, session_id, unlimited=False):
        if not session_id:
            raise ValueError("Сначала начните занятие.")
        now = int(time.time())
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM study_sessions WHERE id=? AND user_id=?", (session_id, user_id)
            ).fetchone()
            if not row or row["status"] == "complete":
                raise ValueError("Занятие завершено. Начните новое занятие.")
            if row["status"] == "paused":
                raise ValueError("Сначала продолжите занятие после перерыва.")
            plan = self._active_plan(connection, user_id)
            limit_seconds = int(self.config.plan(plan)["session_minutes"]) * 60
            elapsed = int(row["active_seconds"]) + max(0, now - int(row["active_started_at"] or now))
            if not unlimited and elapsed >= limit_seconds:
                raise LimitExceeded("Время занятия закончилось. Начните новое занятие.")
        return {"elapsed_seconds": elapsed, "limit_seconds": None if unlimited else limit_seconds}

    def ensure_lesson(self, user_id, lesson_id, study_session_id=None):
        if not lesson_id:
            return
        now = int(time.time())
        with self._connect() as connection:
            connection.execute(
                """INSERT OR IGNORE INTO lessons
                   (id, user_id, study_session_id, started_at, updated_at) VALUES (?, ?, ?, ?, ?)""",
                (lesson_id, user_id, study_session_id, now, now),
            )

    def lesson_hint(self, user_id, lesson_id, difficult=False):
        self.ensure_lesson(user_id, lesson_id)
        with self._connect() as connection:
            connection.execute(
                """UPDATE lessons SET hints=hints+1, difficulty=MAX(difficulty, ?), updated_at=?
                   WHERE id=? AND user_id=?""",
                (int(bool(difficult)), int(time.time()), lesson_id, user_id),
            )

    def finish_lesson(self, user_id, lesson_id, solved_independently=False, difficult=False):
        if not lesson_id:
            return
        self.ensure_lesson(user_id, lesson_id)
        with self._connect() as connection:
            connection.execute(
                """UPDATE lessons SET status='complete', solved_independently=MAX(solved_independently, ?),
                   difficulty=MAX(difficulty, ?), updated_at=? WHERE id=? AND user_id=?""",
                (int(bool(solved_independently)), int(bool(difficult)), int(time.time()), lesson_id, user_id),
            )

    def switch_lesson(self, user_id, lesson_id):
        """Close an active task because the child deliberately moved to another one."""
        if not lesson_id:
            return
        with self._connect() as connection:
            connection.execute(
                "UPDATE lessons SET status='switched', updated_at=? WHERE id=? AND user_id=? AND status='active'",
                (int(time.time()), lesson_id, user_id),
            )

    def abandon_empty_lesson(self, user_id, lesson_id):
        """A provider failure before the first answer must not consume an assignment."""
        with self._connect() as connection:
            completed = connection.execute(
                "SELECT 1 FROM usage_events WHERE user_id=? AND lesson_id=? AND state='complete' LIMIT 1",
                (user_id, lesson_id),
            ).fetchone()
            if not completed:
                connection.execute(
                    "DELETE FROM lessons WHERE id=? AND user_id=? AND status='active'", (lesson_id, user_id)
                )

    def _totals(self, connection, user_id, start, end):
        event = connection.execute(
            """SELECT COUNT(*) FILTER (WHERE operation='llm') AS llm_requests,
                      COALESCE(SUM(CASE WHEN operation='stt' THEN billed_units ELSE 0 END), 0) AS stt_billed_seconds,
                      COALESCE(SUM(CASE WHEN operation='tts' THEN billed_units ELSE 0 END), 0) AS tts_blocks,
                      COALESCE(SUM(cost_microrubles), 0) AS cost
               FROM usage_events WHERE user_id=? AND state IN ('pending','complete')
               AND created_at>=? AND created_at<?""",
            (user_id, start, end),
        ).fetchone()
        assignments = connection.execute(
            "SELECT COUNT(*) AS value FROM lessons WHERE user_id=? AND started_at>=? AND started_at<?",
            (user_id, start, end),
        ).fetchone()["value"]
        sessions = connection.execute(
            """SELECT COUNT(DISTINCT study_session_id) AS value FROM lessons
               WHERE user_id=? AND study_session_id IS NOT NULL AND started_at>=? AND started_at<?""",
            (user_id, start, end),
        ).fetchone()["value"]
        return {
            "sessions": sessions,
            "assignments": assignments,
            "llm_requests": event["llm_requests"],
            "stt_billed_seconds": event["stt_billed_seconds"],
            "tts_blocks": event["tts_blocks"],
            "external_cost_micros": event["cost"],
        }

    def _limits(self, plan):
        value = self.config.plan(plan)
        return {
            "sessions": int(value["sessions"]),
            "assignments": int(value["assignments"]),
            "llm_requests": int(value["llm_requests"]),
            "stt_billed_seconds": int(value["stt_billed_seconds"]),
            "tts_blocks": int(value["tts_blocks"]),
            "external_cost_micros": rubles_to_micros(value["external_cost_rubles"]),
        }

    def _friendly_limit(self, operation):
        if operation == "tts":
            return "Лимит голосовых ответов на этот месяц закончился. Подсказка останется на экране."
        if operation == "stt":
            return "Лимит голосовых вопросов на этот месяц закончился. Напиши вопрос в поле справа."
        return "Подсказки на этот месяц закончились. Попроси взрослого открыть раздел «Для родителя»."

    def reserve(self, user_id, operation, request_id, *, lesson_id=None, study_session_id=None, input_units=0,
                output_units=0, duration_ms=0, billed_units=0, estimated_cost=0,
                provider="", model="", new_lesson=False, bypass_limits=False):
        if operation not in OPERATIONS or not request_id:
            raise ValueError("Некорректная операция учёта.")
        self.ensure_subscription(user_id)
        now = int(time.time())
        start, end = self._month_bounds(now)
        with self.lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT id, state FROM usage_events WHERE user_id=? AND operation=? AND request_id=?",
                (user_id, operation, request_id),
            ).fetchone()
            if existing:
                return {"id": existing["id"], "duplicate": True, "warning": ""}
            estimated_cost = max(0, int(estimated_cost))
            if estimated_cost:
                if self.global_monthly_budget:
                    spent = connection.execute(
                        """SELECT COALESCE(SUM(cost_microrubles),0) AS value FROM usage_events
                           WHERE state IN ('pending','complete') AND created_at>=? AND created_at<?""",
                        (start, end)).fetchone()["value"]
                    if spent + estimated_cost > self.global_monthly_budget:
                        raise LimitExceeded("Общий месячный бюджет сервиса исчерпан. Попробуйте позже.")
                if self.global_daily_budget:
                    day_start = now - (now % 86400)
                    spent = connection.execute(
                        """SELECT COALESCE(SUM(cost_microrubles),0) AS value FROM usage_events
                           WHERE state IN ('pending','complete') AND created_at>=?""",
                        (day_start,)).fetchone()["value"]
                    if spent + estimated_cost > self.global_daily_budget:
                        raise LimitExceeded("Дневной бюджет сервиса исчерпан. Попробуйте завтра.")
            row = connection.execute("SELECT plan, status FROM subscriptions WHERE user_id=?", (user_id,)).fetchone()
            plan = row["plan"] if row and row["status"] == "active" else "free"
            if study_session_id:
                session = connection.execute(
                    "SELECT * FROM study_sessions WHERE id=? AND user_id=?", (study_session_id, user_id)
                ).fetchone()
                if not session or session["status"] != "active":
                    raise LimitExceeded("Занятие не активно. Начните или продолжите занятие.")
                elapsed = int(session["active_seconds"]) + max(
                    0, now - int(session["active_started_at"] or now))
                if not bypass_limits and elapsed >= int(self.config.plan(plan)["session_minutes"]) * 60:
                    raise LimitExceeded("Время занятия закончилось. Начните новое занятие.")
            totals, limits = self._totals(connection, user_id, start, end), self._limits(plan)
            projected = dict(totals)
            if new_lesson:
                projected["assignments"] += 1
                session_has_lesson = connection.execute(
                    "SELECT 1 FROM lessons WHERE user_id=? AND study_session_id=? LIMIT 1",
                    (user_id, study_session_id),
                ).fetchone() if study_session_id else None
                if study_session_id and not session_has_lesson:
                    projected["sessions"] += 1
                if study_session_id:
                    tasks = connection.execute(
                        "SELECT COUNT(*) AS value FROM lessons WHERE user_id=? AND study_session_id=?",
                        (user_id, study_session_id),
                    ).fetchone()["value"]
                    if not bypass_limits and tasks + 1 > int(self.config.plan(plan)["assignments_per_session"]):
                        raise LimitExceeded("В этом занятии уже разобрано максимум новых задач. Начните новое занятие.")
            projected["external_cost_micros"] += estimated_cost
            if operation == "llm":
                projected["llm_requests"] += 1
            elif operation == "stt":
                projected["stt_billed_seconds"] += max(0, int(billed_units))
            else:
                projected["tts_blocks"] += max(0, int(billed_units))
                if study_session_id and not bypass_limits:
                    voice_used = connection.execute(
                        """SELECT COALESCE(SUM(usage_events.billed_units),0) AS value
                           FROM usage_events JOIN lessons ON lessons.id=usage_events.lesson_id
                           WHERE usage_events.user_id=? AND lessons.study_session_id=?
                             AND usage_events.operation='tts'
                             AND usage_events.state IN ('pending','complete')""",
                        (user_id, study_session_id),
                    ).fetchone()["value"]
                    if voice_used + max(0, int(billed_units)) > int(
                            self.config.plan(plan)["yandex_voice_per_session"]):
                        raise LimitExceeded(
                            "Лимит ответов голосом Яндекса на это занятие закончился. "
                            "Подсказка останется на экране; голос родителя доступен без этого лимита.")
            relevant = {
                "llm": ("sessions", "assignments", "llm_requests", "external_cost_micros"),
                "stt": ("stt_billed_seconds", "external_cost_micros"),
                "tts": ("tts_blocks", "external_cost_micros"),
            }[operation]
            if not bypass_limits and any(projected[name] > limits[name] for name in relevant):
                raise LimitExceeded(self._friendly_limit(operation))
            warning = ""
            if not bypass_limits and any(limits[name] and Decimal(projected[name]) / limits[name] >= self.config.warning_ratio
                   for name in relevant):
                warning = "Месячный лимит почти закончился. Родитель увидит остаток в своём отчёте."
            event_id = uuid.uuid4().hex
            connection.execute(
                """INSERT INTO usage_events
                   (id, request_id, user_id, lesson_id, operation, state, input_units, output_units,
                    duration_ms, billed_units, cost_microrubles, provider, model, created_at)
                   VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)""",
                (event_id, request_id, user_id, lesson_id, operation, max(0, int(input_units)),
                 max(0, int(output_units)), max(0, int(duration_ms)), max(0, int(billed_units)),
                 max(0, int(estimated_cost)), provider[:40], model[:80], now),
            )
            if new_lesson and lesson_id:
                connection.execute(
                    """INSERT OR IGNORE INTO lessons
                       (id, user_id, study_session_id, started_at, updated_at) VALUES (?, ?, ?, ?, ?)""",
                    (lesson_id, user_id, study_session_id, now, now),
                )
            return {"id": event_id, "duplicate": False, "warning": warning}

    def complete(self, event_id, *, input_units=None, output_units=None, duration_ms=None,
                 billed_units=None, cost=None, actual_usage=False):
        fields = {"state": "complete", "completed_at": int(time.time()), "actual_usage": int(bool(actual_usage))}
        for key, value in (("input_units", input_units), ("output_units", output_units),
                           ("duration_ms", duration_ms), ("billed_units", billed_units),
                           ("cost_microrubles", cost)):
            if value is not None:
                fields[key] = max(0, int(value))
        clause = ", ".join(f"{key}=?" for key in fields)
        with self._connect() as connection:
            connection.execute(f"UPDATE usage_events SET {clause} WHERE id=?", (*fields.values(), event_id))

    def fail(self, event_id):
        with self._connect() as connection:
            connection.execute(
                "UPDATE usage_events SET state='failed', cost_microrubles=0, completed_at=? WHERE id=?",
                (int(time.time()), event_id),
            )

    def dashboard(self, user_id, unlimited=False):
        self.ensure_subscription(user_id)
        start, end = self._month_bounds()
        with self._connect() as connection:
            sub = connection.execute("SELECT plan, status FROM subscriptions WHERE user_id=?", (user_id,)).fetchone()
            plan = sub["plan"] if sub and sub["status"] == "active" else "free"
            totals = self._totals(connection, user_id, start, end)
            lesson = connection.execute(
                """SELECT COUNT(*) AS assignments, COALESCE(SUM(hints),0) AS hints,
                          COALESCE(SUM(solved_independently),0) AS independent,
                          COALESCE(SUM(difficulty),0) AS difficult
                   FROM lessons WHERE user_id=? AND started_at>=? AND started_at<?""",
                (user_id, start, end),
            ).fetchone()
            day_start, day_end = self._day_bounds()
            day_cost = connection.execute(
                """SELECT COALESCE(SUM(cost_microrubles),0) AS value FROM usage_events
                   WHERE user_id=? AND state IN ('pending','complete') AND created_at>=? AND created_at<?""",
                (user_id, day_start, day_end),
            ).fetchone()["value"]
            recent = connection.execute(
                """SELECT lessons.id, lessons.started_at, lessons.status, lessons.hints,
                          lessons.solved_independently, lessons.difficulty,
                          COALESCE(SUM(CASE WHEN usage_events.state IN ('pending','complete')
                                      THEN usage_events.cost_microrubles ELSE 0 END),0) AS cost
                   FROM lessons LEFT JOIN usage_events ON usage_events.lesson_id=lessons.id
                                      AND usage_events.user_id=lessons.user_id
                   WHERE lessons.user_id=? GROUP BY lessons.id ORDER BY lessons.started_at DESC LIMIT 10""",
                (user_id,),
            ).fetchall()
        limits = self._limits(plan)
        plan_config = self.config.plan(plan)
        remaining = ({key: None for key in limits} if unlimited else
                     {key: max(0, limits[key] - totals[key]) for key in limits})
        return {
            "plan": ({"code": "admin", "title": "Администратор", "status": "active", "unlimited": True,
                      "session_minutes": None, "assignments_per_session": None,
                      "yandex_voice_per_session": None}
                     if unlimited else
                     {"code": plan, "title": plan_config["title"],
                      "status": sub["status"], "unlimited": False,
                      "session_minutes": int(plan_config["session_minutes"]),
                      "assignments_per_session": int(plan_config["assignments_per_session"]),
                      "yandex_voice_per_session": int(plan_config["yandex_voice_per_session"])}),
            "period": datetime.fromtimestamp(start).astimezone().strftime("%Y-%m"),
            "usage": {**totals, "external_cost_rubles": micros_to_rubles(totals["external_cost_micros"]),
                      "today_cost_rubles": micros_to_rubles(day_cost)},
            "limits": {**limits, "external_cost_rubles": micros_to_rubles(limits["external_cost_micros"])},
            "remaining": {**remaining, "external_cost_rubles": (None if unlimited else
                           micros_to_rubles(remaining["external_cost_micros"]))},
            "report": {
                "assignments": lesson["assignments"], "hints": lesson["hints"],
                "solved_independently": lesson["independent"], "difficult": lesson["difficult"],
                "summary": ("Пока нет завершённых заданий." if not lesson["assignments"] else
                            f"Самостоятельно получилось: {lesson['independent']} из {lesson['assignments']}. "
                            f"Сложности возникли в {lesson['difficult']} заданиях."),
            },
            "recent_lessons": [{"started_at": row["started_at"], "status": row["status"],
                                "hints": row["hints"], "solved_independently": bool(row["solved_independently"]),
                                "difficulty": bool(row["difficulty"]),
                                "cost_rubles": micros_to_rubles(row["cost"])} for row in recent],
            "payment": self.latest_payment(user_id),
        }

    def cost_metrics(self):
        start, end = self._month_bounds()
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT user_id, SUM(cost_microrubles) AS cost FROM usage_events
                   WHERE state='complete' AND created_at>=? AND created_at<?
                   GROUP BY user_id HAVING cost > 0 ORDER BY cost""",
                (start, end),
            ).fetchall()
        values = [row["cost"] for row in rows]
        def percentile(p):
            if not values:
                return "0.0000"
            return micros_to_rubles(values[max(0, math.ceil(len(values) * p) - 1)])
        return {"active_users": len(values), "currency": "RUB", "p50": percentile(.50),
                "p90": percentile(.90), "p99": percentile(.99)}
