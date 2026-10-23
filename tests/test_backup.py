from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest

from scripts.backup import backup


class BackupTests(unittest.TestCase):
    def test_age_limit_applies_even_when_fewer_than_keep_archives_exist(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, destination = root / 'data', root / 'backups'
            data.mkdir()
            destination.mkdir()
            old = destination / 'adym-20200101T000000000000Z.tar.gz'
            old.write_bytes(b'old private backup')
            current = backup(data, destination, 14)
            self.assertFalse(old.exists())
            self.assertTrue(current.exists())

    def test_backup_contains_consistent_databases_and_private_profiles(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, destination = root / 'data', root / 'backups'
            profile = data / 'profiles/7'
            profile.mkdir(parents=True)
            (profile / 'avatar.json').write_text('{"version":7}', encoding='utf-8')
            with sqlite3.connect(data / 'users.sqlite3') as database:
                database.execute('CREATE TABLE users (login TEXT)')
                database.execute("INSERT INTO users VALUES ('family')")
            archive = backup(data, destination, 14)
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            with tarfile.open(archive) as source:
                names = source.getnames()
                self.assertIn('data/users.sqlite3', names)
                self.assertIn('data/profiles/7/avatar.json', names)
                source.extract('data/users.sqlite3', root / 'restore', filter='data')
            with sqlite3.connect(root / 'restore/data/users.sqlite3') as database:
                self.assertEqual(database.execute('SELECT login FROM users').fetchone()[0], 'family')

    def test_fast_repeated_backups_are_distinct_and_retention_is_enforced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, destination = root / 'data', root / 'backups'
            data.mkdir()
            first = backup(data, destination, 1)
            second = backup(data, destination, 1)
            self.assertNotEqual(first.name, second.name)
            self.assertFalse(first.exists())
            self.assertTrue(second.exists())


if __name__ == '__main__':
    unittest.main()
