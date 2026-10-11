"""Server-side usage metering, subscriptions and privacy-preserving lesson reports."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
import json
import math
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
        for name in ("free", "paid"):
            if name not in value["plans"]:
                raise ValueError("В конфигурации нужны тарифы Free и Paid.")
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
                CREATE TABLE IF NOT EXISTS subscriptions (
                    user_id INTEGER PRIMARY KEY,
                    plan TEXT NOT NULL CHECK(plan IN ('free', 'paid')),
                    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'cancelled')),
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS lessons (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
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
                """
            )

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

    def set_subscription(self, user_id, plan, status="active"):
        if plan not in ("free", "paid") or status not in ("active", "paused", "cancelled"):
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

    def ensure_lesson(self, user_id, lesson_id):
        if not lesson_id:
            return
        now = int(time.time())
        with self._connect() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO lessons(id, user_id, started_at, updated_at) VALUES (?, ?, ?, ?)",
                (lesson_id, user_id, now, now),
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
        return {
            "assignments": assignments,
            "llm_requests": event["llm_requests"],
            "stt_billed_seconds": event["stt_billed_seconds"],
            "tts_blocks": event["tts_blocks"],
            "external_cost_micros": event["cost"],
        }

    def _limits(self, plan):
        value = self.config.plan(plan)
        return {
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

    def reserve(self, user_id, operation, request_id, *, lesson_id=None, input_units=0,
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
            row = connection.execute("SELECT plan, status FROM subscriptions WHERE user_id=?", (user_id,)).fetchone()
            plan = row["plan"] if row and row["status"] == "active" else "free"
            totals, limits = self._totals(connection, user_id, start, end), self._limits(plan)
            projected = dict(totals)
            if new_lesson:
                projected["assignments"] += 1
            projected["external_cost_micros"] += max(0, int(estimated_cost))
            if operation == "llm":
                projected["llm_requests"] += 1
            elif operation == "stt":
                projected["stt_billed_seconds"] += max(0, int(billed_units))
            else:
                projected["tts_blocks"] += max(0, int(billed_units))
            relevant = {
                "llm": ("assignments", "llm_requests", "external_cost_micros"),
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
                    "INSERT OR IGNORE INTO lessons(id, user_id, started_at, updated_at) VALUES (?, ?, ?, ?)",
                    (lesson_id, user_id, now, now),
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
        remaining = ({key: None for key in limits} if unlimited else
                     {key: max(0, limits[key] - totals[key]) for key in limits})
        return {
            "plan": ({"code": "admin", "title": "Admin", "status": "active", "unlimited": True}
                     if unlimited else
                     {"code": plan, "title": self.config.plan(plan)["title"],
                      "status": sub["status"], "unlimited": False}),
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
