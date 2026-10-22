#!/usr/bin/env python3
"""Build a safe, read-only-friendly SQLite snapshot for product analysis.

The export deliberately excludes password hashes, salts and session tokens. It also
contains no prompts, transcripts, photographs or audio recordings.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import os
import sqlite3
import tempfile
import time


def export_database(data_dir: Path, output: Path) -> None:
    users = (data_dir / "users.sqlite3").resolve()
    usage = (data_dir / "usage.sqlite3").resolve()
    if not users.exists() or not usage.exists():
        raise FileNotFoundError("Сначала запустите Адым, чтобы базы данных были созданы.")
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=output.name + ".", suffix=".tmp", dir=output.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with sqlite3.connect(temporary) as connection:
            connection.execute("ATTACH DATABASE ? AS auth", (str(users),))
            connection.execute("ATTACH DATABASE ? AS usage", (str(usage),))
            connection.executescript(
                """
                CREATE TABLE export_info AS
                SELECT CAST(strftime('%s','now') AS INTEGER) AS exported_at,
                       'UTC timestamps; no passwords, tokens, prompts, photos or audio' AS privacy_note;

                CREATE TABLE accounts AS
                SELECT id,login,email,telegram_username,role,created_at,terms_accepted_at,terms_version,
                       parent_confirmed,is_banned,banned_at,ban_reason,last_login_at,
                       login_count,last_seen_at,last_logout_at
                  FROM auth.users;
                CREATE UNIQUE INDEX accounts_id ON accounts(id);
                CREATE UNIQUE INDEX accounts_login ON accounts(login);

                CREATE TABLE account_events AS
                SELECT id,user_id,event,created_at,details FROM auth.account_events;
                CREATE INDEX account_events_user_time ON account_events(user_id,created_at);

                CREATE TABLE active_sessions AS
                SELECT user_id,created_at,last_seen_at,expires_at FROM auth.sessions;
                CREATE INDEX active_sessions_user ON active_sessions(user_id);

                CREATE TABLE admin_actions AS
                SELECT id,admin_user_id,target_user_id,target_login,action,details,created_at
                  FROM auth.admin_audit;

                CREATE TABLE subscriptions AS SELECT * FROM usage.subscriptions;
                CREATE TABLE study_sessions AS SELECT * FROM usage.study_sessions;
                CREATE TABLE lessons AS SELECT * FROM usage.lessons;
                CREATE TABLE usage_events AS SELECT * FROM usage.usage_events;
                CREATE TABLE payments AS
                SELECT provider_id,user_id,provider,plan,amount_rubles,currency,status,
                       created_at,updated_at FROM usage.payment_subscriptions;

                CREATE TABLE daily_summary AS
                SELECT date(created_at,'unixepoch') AS day,user_id,
                       COUNT(*) AS provider_requests,
                       SUM(CASE WHEN state='complete' THEN 1 ELSE 0 END) AS successful_requests,
                       SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed_requests,
                       SUM(CASE WHEN operation='llm' THEN 1 ELSE 0 END) AS llm_requests,
                       SUM(CASE WHEN operation='stt' THEN 1 ELSE 0 END) AS stt_requests,
                       SUM(CASE WHEN operation='tts' THEN 1 ELSE 0 END) AS tts_requests,
                       ROUND(SUM(cost_microrubles)/1000000.0,4) AS external_cost_rubles
                  FROM usage.usage_events GROUP BY day,user_id;

                CREATE VIEW account_overview AS
                SELECT a.id,a.login,a.email,a.telegram_username,a.role,a.created_at,a.last_login_at,a.login_count,
                       a.last_seen_at,a.is_banned,COALESCE(s.plan,'free') AS plan,
                       COALESCE(s.status,'active') AS subscription_status,
                       COUNT(DISTINCT l.id) AS lessons_total,
                       COALESCE(SUM(l.hints),0) AS hints_total,
                       COALESCE(SUM(l.solved_independently),0) AS solved_total
                  FROM accounts a LEFT JOIN subscriptions s ON s.user_id=a.id
                  LEFT JOIN lessons l ON l.user_id=a.id GROUP BY a.id;
                """
            )
            connection.execute("PRAGMA user_version=1")
            connection.execute("ANALYZE")
        os.chmod(temporary, 0o640)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Экспорт безопасной административной копии БД Адым")
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--output", default="data/admin-export.sqlite3")
    args = parser.parse_args()
    export_database(Path(args.data_dir), Path(args.output))
    print(f"Экспорт готов: {args.output} ({int(time.time())})")


if __name__ == "__main__":
    main()
