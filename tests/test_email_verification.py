import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from auth import AuthStore
import test_account_security


class VerificationStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        iterations=patch('auth.PASSWORD_ITERATIONS',1000);iterations.start();self.addCleanup(iterations.stop)
        self.store=AuthStore(Path(self.temp.name)/'users.sqlite3')
        self.user=self.store.register('new-parent','parent@example.com','password-123','password-123',
            require_email_verification=True,device_token='unique-browser-device-token')

    def test_no_access_until_mail_and_password_are_proved_then_token_is_single_use(self):
        self.assertEqual(self.store.authenticate_with_status(self.user.login,'password-123')[1],'unverified')
        with self.assertRaises(ValueError):self.store.create_session(self.user.id)
        _,token=self.store.request_email_verification(self.user.email)
        with self.assertRaisesRegex(ValueError,'Неверный пароль'):
            self.store.verify_email(token,'wrong-password')
        self.store.verify_email(token,'password-123')
        self.assertEqual(self.store.authenticate(self.user.login,'password-123'),self.user)
        self.assertEqual(self.store.user_for_session(self.store.create_session(self.user.id)),self.user)
        with self.assertRaises(ValueError):self.store.verify_email(token,'password-123')
        with self.store._connect() as db:
            self.assertIsNotNone(db.execute('SELECT email_verified_at FROM users').fetchone()[0])
            self.assertEqual(db.execute('SELECT count(*) FROM device_registrations').fetchone()[0],1)

    def test_cooldown_replacement_expiry_and_hash_only_storage(self):
        with patch('auth.time.time',return_value=1000):
            _,first=self.store.request_email_verification(self.user.email)
            self.assertIsNone(self.store.request_email_verification(self.user.email))
            with self.store._connect() as db:
                self.assertNotEqual(db.execute('SELECT token_hash FROM email_verifications').fetchone()[0],first.encode())
        with patch('auth.time.time',return_value=1061):
            _,second=self.store.request_email_verification(self.user.email)
            with self.assertRaises(ValueError):self.store.verify_email(first,'password-123')
        with patch('auth.time.time',return_value=1061+86400):
            with self.assertRaises(ValueError):self.store.verify_email(second,'password-123')

    def test_reset_proves_ownership_replaces_untrusted_password_and_invalidates_verification(self):
        _,verification=self.store.request_email_verification(self.user.email)
        _,reset=self.store.request_password_reset(self.user.email)
        self.store.reset_password(reset,'owner-password','owner-password')
        self.assertIsNone(self.store.authenticate(self.user.login,'password-123'))
        self.assertEqual(self.store.authenticate(self.user.login,'owner-password'),self.user)
        with self.assertRaises(ValueError):self.store.verify_email(verification,'password-123')

    def test_pending_registrations_do_not_claim_device_but_only_one_can_activate(self):
        other=self.store.register('other-parent','other@example.com','password-123','password-123',
            require_email_verification=True,device_token='unique-browser-device-token')
        _,first=self.store.request_email_verification(self.user.email)
        _,second=self.store.request_email_verification(other.email)
        self.store.verify_email(first,'password-123')
        with self.assertRaisesRegex(ValueError,'уже создан аккаунт'):self.store.verify_email(second,'password-123')

    def test_recovery_activation_claims_owner_device_and_cannot_bypass_device_limit(self):
        self.store.register('existing','existing@example.com','password-123','password-123',
                            device_token='already-registered-browser-device')
        _,token=self.store.request_password_reset(self.user.email)
        with self.assertRaisesRegex(ValueError,'уже создан аккаунт'):
            self.store.reset_password(token,'owner-password','owner-password',
                                      device_token='already-registered-browser-device')
        self.store.reset_password(token,'owner-password','owner-password',device_token='mailbox-owner-browser-device')
        with self.assertRaisesRegex(ValueError,'уже создан аккаунт'):
            self.store.register('other','other@example.com','password-123','password-123',
                                device_token='mailbox-owner-browser-device',require_email_verification=True)

    def test_existing_accounts_keep_access_without_false_verified_status(self):
        existing=self.store.register('existing','existing@example.com','password-123','password-123')
        self.assertEqual(AuthStore(self.store.path).authenticate('existing','password-123'),existing)
        with self.store._connect() as db:
            self.assertIsNone(db.execute('SELECT email_verified_at FROM users WHERE id=?',(existing.id,)).fetchone()[0])
        self.assertIsNone(self.store.request_email_verification(existing.email))

    def test_ban_blocks_confirmation_and_account_deletion_cascades(self):
        _,token=self.store.request_email_verification(self.user.email)
        with self.store._connect() as db:db.execute('UPDATE users SET is_banned=1')
        with self.assertRaises(ValueError):self.store.verify_email(token,'password-123')
        self.store.delete_user(self.user.id)
        with self.store._connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM email_verifications').fetchone()[0],0)


class VerificationHTTPTests(unittest.TestCase):
    setUp=test_account_security.AccountSecurityTests.setUp
    tearDown=test_account_security.AccountSecurityTests.tearDown
    request=test_account_security.AccountSecurityTests.request

    def post(self,path,values):
        code,body,headers=self.request('/api/auth/'+path,json.dumps(values).encode(),
            {'Origin':self.s.origin,'X-App-Token':self.s.token},authenticated=False,include_headers=True)
        return code,json.loads(body),headers

    def register(self):
        return self.post('register',{'login':'mail-parent','email':'mail@example.com','password':'password-123',
            'password_confirmation':'password-123','telegram_username':'@mail_parent',
            'parent_confirmed':True,'privacy_accepted':True,'terms_accepted':True})

    def test_registration_email_confirm_login_no_session_before_confirmation(self):
        code,body,headers=self.register()
        self.assertEqual(code,201);self.assertTrue(body['verification_required']);self.assertNotIn('user',body)
        self.assertNotIn('parentai_session=',str(headers))
        code,body,_=self.post('login',{'identifier':'mail-parent','password':'password-123'})
        self.assertEqual(code,403);self.assertTrue(body['verification_required'])
        self.assertEqual(self.post('login',{'identifier':'mail-parent','password':'wrong-password'})[0],401)
        recipient,link=self.s.mailer.send_verification.call_args.args
        self.assertEqual(recipient,'mail@example.com');self.assertTrue(link.startswith(self.s.origin+'/#verify='))
        token=link.split('#verify=',1)[1]
        self.assertEqual(self.post('verify-email',{'token':token,'password':'wrong-password'})[0],400)
        self.assertEqual(self.post('verify-email',{'token':token,'password':'password-123'})[0],200)
        self.assertEqual(self.post('login',{'identifier':'mail-parent','password':'password-123'})[0],200)
        self.assertEqual(self.post('verify-email',{'token':token,'password':'password-123'})[0],400)

    def test_mail_failure_does_not_allow_login_and_missing_settings_do_not_create_user(self):
        self.s.mailer=Mock(configured=False)
        self.assertEqual(self.register()[0],503)
        self.assertEqual(self.s.auth.user_counts()['total'],1)
        self.s.mailer=Mock(configured=True)
        self.s.mailer.send_verification.side_effect=OSError('delivery failed')
        code,body,_=self.register()
        self.assertEqual(code,503);self.assertTrue(body['verification_required'])
        self.assertEqual(self.post('login',{'identifier':'mail-parent','password':'password-123'})[0],403)
        with self.s.auth._connect() as db:
            self.assertEqual(db.execute('SELECT invalidated FROM email_verifications').fetchone()[0],1)

    def test_resend_generic_and_expired_link_can_be_replaced(self):
        self.register()
        link=self.s.mailer.send_verification.call_args.args[1]
        self.assertEqual(self.post('resend-verification',{'email':'mail@example.com'})[:2],
                         self.post('resend-verification',{'email':'missing@example.com'})[:2])
        with self.s.auth._connect() as db:
            db.execute('UPDATE email_verifications SET created_at=created_at-120,expires_at=0')
        self.s.send_email_verification('mail@example.com')
        new=self.s.mailer.send_verification.call_args.args[1]
        self.assertNotEqual(link,new)
        self.assertEqual(self.post('verify-email',{'token':new.split('#verify=',1)[1],'password':'password-123'})[0],200)
