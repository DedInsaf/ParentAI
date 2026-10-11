import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from auth import AuthStore


class AuthStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.iterations = patch('auth.PASSWORD_ITERATIONS', 1000)
        self.iterations.start()
        self.addCleanup(self.iterations.stop)
        self.store = AuthStore(self.temp.name + '/users.sqlite3')

    def test_registration_and_login_by_name_or_email(self):
        user = self.store.register('Родитель-1', 'Parent@Example.com', 'strong-pass', 'strong-pass')
        self.assertEqual(self.store.authenticate('родитель-1', 'strong-pass'), user)
        self.assertEqual(self.store.authenticate('parent@example.COM', 'strong-pass'), user)
        self.assertIsNone(self.store.authenticate('Родитель-1', 'wrong-pass'))
        with sqlite3.connect(self.store.path) as connection:
            row = connection.execute('SELECT password_salt, password_hash FROM users').fetchone()
        self.assertNotEqual(row[0], b'strong-pass')
        self.assertNotEqual(row[1], b'strong-pass')

    def test_registration_validation_and_unique_fields(self):
        cases = [
            ('ab', 'one@example.com', 'strong-pass', 'strong-pass', 'Логин'),
            ('valid-user', 'bad-email', 'strong-pass', 'strong-pass', 'почты'),
            ('valid-user', 'one@example.com', 'short', 'short', '8 символов'),
            ('valid-user', 'one@example.com', 'strong-pass', 'other-pass', 'не совпадают'),
        ]
        for login, email, password, confirmation, message in cases:
            with self.subTest(login=login, email=email), self.assertRaisesRegex(ValueError, message):
                self.store.register(login, email, password, confirmation)
        self.store.register('valid-user', 'one@example.com', 'strong-pass', 'strong-pass')
        with self.assertRaisesRegex(ValueError, 'логин уже занят'):
            self.store.register('VALID-USER', 'two@example.com', 'strong-pass', 'strong-pass')
        with self.assertRaisesRegex(ValueError, 'почтой уже существует'):
            self.store.register('other-user', 'ONE@example.com', 'strong-pass', 'strong-pass')

    def test_session_creation_lookup_and_revocation(self):
        user = self.store.register('valid-user', 'one@example.com', 'strong-pass', 'strong-pass')
        token = self.store.create_session(user.id)
        self.assertEqual(self.store.user_for_session(token), user)
        self.store.delete_session(token)
        self.assertIsNone(self.store.user_for_session(token))

    def test_admin_role_is_returned_and_can_be_promoted(self):
        admin = self.store.register('admin-user', 'admin@example.com', 'strong-pass', 'strong-pass', role='admin')
        self.assertTrue(admin.public()['is_admin'])
        parent = self.store.register('parent-user', 'parent@example.com', 'strong-pass', 'strong-pass')
        self.store.set_role(parent.login, 'admin')
        self.assertEqual(self.store.authenticate(parent.login, 'strong-pass').role, 'admin')


if __name__ == '__main__':
    unittest.main()
