"""HTTP security checks independent of experimental voice modifications."""
import json
from http.cookies import SimpleCookie
import unittest
import test_server


class AccountSecurityTests(unittest.TestCase):
    setUp=test_server.ServerTests.setUp
    tearDown=test_server.ServerTests.tearDown
    request=test_server.ServerTests.request
    def test_password_change_rotates_cookie_and_invalidates_old_login(self):
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        payload=json.dumps({'current_password':'password-123','new_password':'new-password-456',
                            'confirmation':'new-password-456'}).encode()
        code,body,result=self.request('/api/account/password',payload,headers,include_headers=True)
        self.assertEqual(code,200)
        self.assertEqual(self.request('/api/status',headers={'X-App-Token':self.s.token})[0],401)
        cookie=SimpleCookie(result['Set-Cookie'])
        self.session=cookie['parentai_session'].value
        self.assertEqual(self.request('/api/status',headers={'X-App-Token':self.s.token})[0],200)
        self.assertIsNone(self.s.auth.authenticate('test-user','password-123'))
        self.assertIsNotNone(self.s.auth.authenticate('test-user','new-password-456'))

    def test_untrusted_forwarded_header_cannot_evade_login_rate_limit(self):
        payload=json.dumps({'identifier':'unknown-user','password':'wrong-password'}).encode()
        for attempt in range(11):
            code,_=self.request('/api/auth/login',payload,
                {'Origin':self.s.origin,'X-App-Token':self.s.token,'X-Forwarded-For':f'192.0.2.{attempt+1}'},
                authenticated=False)
            self.assertEqual(code,429 if attempt==10 else 401)

    def test_oversized_auth_request_is_rejected(self):
        code,_=self.request('/api/auth/login',b' '*16001,
                           {'Origin':self.s.origin,'X-App-Token':self.s.token},authenticated=False)
        self.assertEqual(code,413)
