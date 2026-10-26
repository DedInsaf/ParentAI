import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from auth import AuthStore
import test_account_security


class ResetStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.iterations=patch('auth.PASSWORD_ITERATIONS',1000);self.iterations.start();self.addCleanup(self.iterations.stop)
        self.store=AuthStore(Path(self.temp.name)/'users.sqlite3')
        self.user=self.store.register('parent','parent@example.com','password-123','password-123')

    def test_single_use_hash_storage_and_session_revocation(self):
        session=self.store.create_session(self.user.id)
        email,token=self.store.request_password_reset('PARENT@example.com')
        self.assertEqual(email,self.user.email)
        with self.store._connect() as db:
            self.assertNotEqual(db.execute('SELECT token_hash FROM password_resets').fetchone()[0],token.encode())
        self.store.reset_password(token,'new-password','new-password')
        self.assertIsNone(self.store.user_for_session(session))
        self.assertIsNone(self.store.authenticate('parent','password-123'))
        self.assertEqual(self.store.authenticate('parent','new-password'),self.user)
        with self.assertRaises(ValueError):self.store.reset_password(token,'third-password','third-password')

    def test_cooldown_expiry_replacement_and_password_change(self):
        with patch('auth.time.time',return_value=1000):
            _,old=self.store.request_password_reset(self.user.email)
            self.assertIsNone(self.store.request_password_reset(self.user.email))
        with patch('auth.time.time',return_value=1061):
            _,new=self.store.request_password_reset(self.user.email)
            with self.assertRaises(ValueError):self.store.reset_password(old,'new-password','new-password')
        with patch('auth.time.time',return_value=2861):
            with self.assertRaises(ValueError):self.store.reset_password(new,'new-password','new-password')
        self.store.change_password(self.user.id,'password-123','other-password','other-password')
        with self.assertRaises(ValueError):self.store.reset_password(new,'new-password','new-password')

    def test_hour_limit_and_banned_unknown_and_mismatch(self):
        for attempt in range(6):
            with patch('auth.time.time',return_value=1000+61*attempt):
                delivery=self.store.request_password_reset(self.user.email)
                self.assertEqual(delivery is None,attempt==5)
        self.assertIsNone(self.store.request_password_reset('missing@example.com'))
        with self.store._connect() as db:db.execute('UPDATE users SET is_banned=1')
        self.assertIsNone(self.store.request_password_reset(self.user.email))

    def test_bad_confirmation_does_not_consume_link_and_deletion_cascades(self):
        _,token=self.store.request_password_reset(self.user.email)
        with self.assertRaises(ValueError):self.store.reset_password(token,'new-password','different-password')
        self.store.reset_password(token,'new-password','new-password')
        _,token=self.store.request_password_reset(self.user.email)
        with self.store._connect() as db:
            db.execute('UPDATE users SET is_banned=1')
        with self.assertRaises(ValueError):self.store.reset_password(token,'third-password','third-password')
        self.store.delete_user(self.user.id)
        with self.store._connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM password_resets').fetchone()[0],0)


class RecoveryHTTPTests(unittest.TestCase):
    setUp=test_account_security.AccountSecurityTests.setUp
    tearDown=test_account_security.AccountSecurityTests.tearDown
    request=test_account_security.AccountSecurityTests.request

    def post(self,path,value):
        code,body=self.request('/api/auth/'+path,json.dumps(value).encode(),
            {'Origin':self.s.origin,'X-App-Token':self.s.token},authenticated=False)
        return code,json.loads(body)

    def test_anonymous_reset_and_replay(self):
        _,token=self.s.auth.request_password_reset('test@example.com')
        body={'token':token,'new_password':'new-password','confirmation':'new-password'}
        self.assertEqual(self.post('reset-password',body)[0],200)
        self.assertIsNone(self.s.auth.user_for_session(self.session))
        self.assertEqual(self.post('reset-password',body)[0],400)

    def test_generic_response_and_mail_failure_invalidates_token(self):
        self.s.mailer=Mock(configured=True)
        # Execute delivery synchronously here so assertions include mail completion.
        real_thread=threading.Thread
        def thread_factory(target, args, daemon=None):
            if target == self.s.deliver_password_reset:
                return Mock(start=lambda:target(*args))
            return real_thread(target=target,args=args,daemon=daemon)
        with patch('server.threading.Thread') as thread:
            thread.side_effect=thread_factory
            known=self.post('forgot-password',{'email':'test@example.com'})
            unknown=self.post('forgot-password',{'email':'missing@example.com'})
        self.assertEqual(known,unknown)
        self.s.mailer.send_reset.assert_called_once()
        link=self.s.mailer.send_reset.call_args.args[1]
        self.assertTrue(link.startswith(self.s.origin+'/#reset='))
        with self.s.auth._connect() as db:db.execute('DELETE FROM password_resets')
        self.s.mailer.send_reset.side_effect=OSError('failure')
        self.s.mail_slots.acquire();self.s.deliver_password_reset('test@example.com')
        with self.s.auth._connect() as db:
            self.assertEqual(db.execute('SELECT invalidated FROM password_resets').fetchone()[0],1)

    def test_missing_mail_configuration_and_request_validation(self):
        self.s.mailer=Mock(configured=False)
        self.assertEqual(self.post('forgot-password',{'email':'test@example.com'})[0],503)
        self.assertEqual(self.post('forgot-password',{'email':'bad'})[0],400)
        self.assertEqual(self.post('reset-password',{'token':'bad','new_password':'new-password','confirmation':'new-password'})[0],400)


class MailerTests(unittest.TestCase):
    def test_mail_settings_load_from_private_environment_file(self):
        from tutor import load_local_env
        from mailer import AccountMailer
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ',{},clear=True):
            config=Path(folder)/'parentai.env'
            config.write_text('ADYM_SMTP_HOST=smtp.example.com\nADYM_SMTP_USER=support@example.com\nADYM_SMTP_PASSWORD=test-secret\n')
            load_local_env(config)
            self.assertTrue(AccountMailer().configured)

    def test_tls_and_message(self):
        from mailer import AccountMailer
        with patch.dict('os.environ',{'ADYM_SMTP_HOST':'smtp.example.com','ADYM_SMTP_USER':'support@example.com',
                                    'ADYM_SMTP_PASSWORD':'test-secret','ADYM_SMTP_PORT':'465'},clear=True):
            mailer=AccountMailer()
        with patch('mailer.smtplib.SMTP_SSL') as smtp:
            mailer.send_reset('parent@example.com','https://app.example.com/#reset=test-token')
            connection=smtp.return_value
            connection.login.assert_called_once_with('support@example.com','test-secret')
            message=connection.send_message.call_args.args[0]
            self.assertEqual(message['To'],'parent@example.com')
            self.assertIn('#reset=test-token',message.get_content())
            self.assertEqual(smtp.call_args.kwargs['timeout'],15)
