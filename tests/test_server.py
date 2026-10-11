import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch
from runtime import Runtime
from server import AppServer
from tutor import Tutor
from test_avatar_model import glb


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.iterations = patch('auth.PASSWORD_ITERATIONS', 1000)
        self.iterations.start()
        self.temp = tempfile.TemporaryDirectory()
        self.r = Runtime(self.temp.name)
        self.s = AppServer(self.r)
        self.s.tutor = Tutor()
        user = self.s.auth.register('test-user', 'test@example.com', 'password-123', 'password-123')
        self.session = self.s.auth.create_session(user.id)
        self.thread = threading.Thread(target=self.s.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.s.shutdown(); self.s.server_close(); self.thread.join(); self.temp.cleanup(); self.iterations.stop()

    def request(self, path, data=None, headers=None, authenticated=True):
        headers = dict(headers or {})
        if authenticated:
            headers.setdefault('Cookie', 'parentai_session=' + self.session)
        req=urllib.request.Request(self.s.origin+path,data=data,headers=headers)
        try:
            with urllib.request.urlopen(req) as response: return response.status,response.read()
        except urllib.error.HTTPError as e: return e.code,e.read()

    def test_public_ui_and_protected_api(self):
        self.assertEqual(self.request('/')[0],200)
        self.assertEqual(self.request('/api/status')[0],403)
        self.assertEqual(self.request('/api/status',headers={'X-App-Token':self.s.token})[0],200)
        self.assertEqual(self.request('/api/status',headers={'X-App-Token':self.s.token},authenticated=False)[0],401)
        code, body = self.request('/api/parent/summary',headers={'X-App-Token':self.s.token})
        self.assertEqual(code,200)
        self.assertEqual(json.loads(body)['plan']['code'],'free')
        self.assertEqual(self.request('/api/metrics/cost',headers={'X-App-Token':self.s.token})[0],403)
        session=json.loads(self.request('/api/session')[1])
        self.assertEqual(session['user']['login'],'test-user')
        self.assertEqual(self.request('/api/session',headers={'Sec-Fetch-Site':'cross-site'})[0],403)

    def test_login_accepts_login_or_email_and_logout_revokes_session(self):
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        for identifier in ('test-user','TEST@EXAMPLE.COM'):
            payload=json.dumps({'identifier':identifier,'password':'password-123'}).encode()
            code,body=self.request('/api/auth/login',payload,headers,authenticated=False)
            self.assertEqual(code,200)
            self.assertEqual(json.loads(body)['user']['login'],'test-user')
        payload=json.dumps({'identifier':'test-user','password':'wrong-password'}).encode()
        self.assertEqual(self.request('/api/auth/login',payload,headers,authenticated=False)[0],401)
        self.assertEqual(self.request('/api/auth/logout',b'{}',headers)[0],200)
        self.assertEqual(self.request('/api/status',headers={'X-App-Token':self.s.token})[0],401)

    def test_admin_cannot_be_self_assigned_and_has_unlimited_dashboard(self):
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        payload=json.dumps({'login':'new-user','email':'new@example.com','password':'password-123',
                            'password_confirmation':'password-123','role':'admin'}).encode()
        code,body=self.request('/api/auth/register',payload,headers,authenticated=False)
        self.assertEqual(code,201)
        self.assertFalse(json.loads(body)['user']['is_admin'])
        self.s.auth.set_role('test-user','admin')
        code,body=self.request('/api/parent/summary',headers={'X-App-Token':self.s.token})
        self.assertEqual(code,200)
        summary=json.loads(body)
        self.assertEqual(summary['plan']['code'],'admin')
        self.assertTrue(summary['plan']['unlimited'])
        self.assertIsNone(summary['remaining']['assignments'])
        self.assertEqual(self.request('/api/metrics/cost',headers={'X-App-Token':self.s.token})[0],200)

    def test_origin_token_and_wav_validation(self):
        self.assertEqual(self.request('/api/reference',b'bad')[0],403)
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token}
        self.assertEqual(self.request('/api/reference',b'bad',headers)[0],400)
        self.assertEqual(self.request('/api/generate',b'',headers)[0],400)

    def test_private_files_and_traversal_not_served(self):
        (Path(self.temp.name)/'ollama.log').write_text('private')
        for url in ['/audio/ollama.log','/../runtime.py','/audio/../runtime.py']:
            self.assertEqual(self.request(url)[0],404)

    def test_generated_avatar_is_private_and_bad_export_preserves_previous(self):
        self.assertEqual(self.request('/api/avatar-model')[0],403)
        self.assertEqual(self.request('/api/avatar-model', glb())[0],403)
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token}
        code, body = self.request('/api/avatar-model', glb(), headers)
        self.assertEqual(code,200)
        filename=json.loads(body)['model']
        self.assertEqual(self.request('/api/avatar-model',headers=headers)[1],glb())
        self.assertEqual(self.request('/audio/'+filename)[0],404)
        self.assertEqual(self.request('/api/avatar-model',b'bad',headers)[0],400)
        self.assertEqual(self.request('/api/avatar-model',headers=headers)[1],glb())

    def test_speech_dialog_and_reply_audio_are_protected(self):
        for path in ('/api/speech','/api/dialog','/api/dialog-cancel'):
            self.assertEqual(self.request(path,b'{}')[0],403)
        self.assertEqual(self.request('/api/dialog/guess')[0],403)
        self.assertEqual(self.request('/api/dialog-audio/guess')[0],403)
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token}
        self.assertEqual(self.request('/api/dialog',b'{}',headers)[0],400)

    def test_tutor_is_protected_and_reports_missing_configuration(self):
        payload=json.dumps({'question':'Помоги','history':[],'level':'средняя школа'}).encode()
        self.assertEqual(self.request('/api/tutor',payload)[0],403)
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        code, body = self.request('/api/tutor',payload,headers)
        self.assertEqual(code,400)
        self.assertIn('не настроен',json.loads(body)['error'])
