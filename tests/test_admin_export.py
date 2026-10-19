import sqlite3
import tempfile
import unittest
from pathlib import Path

from auth import AuthStore
from scripts.export_admin_db import export_database
from usage import UsageStore


class AdminExportTests(unittest.TestCase):
    def test_export_contains_analytics_but_no_authentication_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            auth = AuthStore(root / "users.sqlite3")
            usage = UsageStore(root / "usage.sqlite3")
            user = auth.register("parent-one", "parent@example.com", "strong-pass", "strong-pass")
            auth.create_session(user.id)
            usage.set_subscription(user.id, "paid")
            target = root / "admin-export.sqlite3"
            export_database(root, target)
            with sqlite3.connect(target) as connection:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(accounts)")}
                self.assertNotIn("password_hash", columns)
                self.assertNotIn("password_salt", columns)
                self.assertEqual(connection.execute(
                    "SELECT login,plan,login_count FROM account_overview"
                ).fetchone(), ("parent-one", "paid", 1))
                self.assertEqual(connection.execute(
                    "SELECT COUNT(*) FROM account_events WHERE event='registered'"
                ).fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
