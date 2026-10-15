import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch
from http.cookies import SimpleCookie
from auth import SESSION_LIFETIME
from runtime import Runtime
from server import AppServer
from tutor import Tutor
from test_avatar_model import glb
from test_dialogue import recording


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

    def request(self, path, data=None, headers=None, authenticated=True, include_headers=False):
        headers = dict(headers or {})
        if authenticated:
            headers.setdefault('Cookie', 'parentai_session=' + self.session)
        req=urllib.request.Request(self.s.origin+path,data=data,headers=headers)
        try:
            with urllib.request.urlopen(req) as response:
                result = (response.status, response.read())
                return (*result, response.headers) if include_headers else result
        except urllib.error.HTTPError as e:
            result = (e.code, e.read())
            return (*result, e.headers) if include_headers else result

    def test_public_ui_and_protected_api(self):
        self.assertEqual(self.request('/')[0],200)
        self.assertEqual(self.request('/api/health',authenticated=False)[0],200)
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

    def test_static_assets_are_streamed_with_cache_and_security_headers(self):
        code,body,headers=self.request('/app.js',include_headers=True,authenticated=False)
        self.assertEqual(code,200)
        self.assertTrue(body)
        self.assertEqual(headers['Cache-Control'],'no-cache')
        self.assertIn("default-src 'self'",headers['Content-Security-Policy'])
        etag=headers['ETag']
        code,body=self.request('/app.js',headers={'If-None-Match':etag},authenticated=False)
        self.assertEqual(code,304)
        self.assertEqual(body,b'')

    def test_session_restore_renews_persistent_cookie(self):
        code, body, headers = self.request('/api/session', include_headers=True)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['user']['login'], 'test-user')
        cookie = SimpleCookie(headers['Set-Cookie'])['parentai_session']
        self.assertEqual(cookie.value, self.session)
        self.assertEqual(int(cookie['max-age']), SESSION_LIFETIME)
        self.assertTrue(cookie['expires'])

    def test_platega_checkout_and_authenticated_callback_activate_paid(self):
        provider_id='11111111-1111-4111-8111-111111111111'
        redirect='https://pay.platega.io/subscription/11111111'
        class FakePlatega:
            def public_status(self):return {'provider':'Platega','enabled':True,'method':'recurring_sbp'}
            def create_subscription(self,amount,plan_title):
                self.amount=amount; self.plan_title=plan_title
                return {'provider_id':provider_id,'redirect':redirect,'status':'pending'}
            def valid_callback(self,merchant,secret):return merchant=='merchant' and secret=='secret'
        self.s.platega=FakePlatega()
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        code,body=self.request('/api/billing/checkout',json.dumps({'plan':'paid'}).encode(),headers)
        self.assertEqual(code,201)
        self.assertEqual(json.loads(body)['redirect'],redirect)
        self.assertEqual(self.s.platega.amount,490)
        callback=json.dumps({'Id':provider_id,'Amount':490,'Currency':'RUB','Status':'CONFIRMED'}).encode()
        bad={'X-MerchantId':'merchant','X-Secret':'wrong','Content-Type':'application/json'}
        self.assertEqual(self.request('/api/webhooks/platega',callback,bad,authenticated=False)[0],403)
        good={'X-MerchantId':'merchant','X-Secret':'secret','Content-Type':'application/json'}
        self.assertEqual(self.request('/api/webhooks/platega',callback,good,authenticated=False)[0],200)
        self.assertEqual(self.s.usage.subscription(1)['plan'],'paid')
        status=json.loads(self.request('/api/status',headers={'X-App-Token':self.s.token})[1])
        self.assertTrue(status['billing']['provider']['enabled'])

    def test_checkout_does_not_create_a_second_recurring_subscription(self):
        class FakePlatega:
            called = False
            def public_status(self): return {'provider':'Platega','enabled':True}
            def create_subscription(self, _amount, _title):
                self.called = True
                raise AssertionError('Platega must not be called')
        self.s.platega = FakePlatega()
        self.s.usage.set_subscription(1, 'paid')
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        code, body = self.request(
            '/api/billing/checkout', json.dumps({'plan':'ultra'}).encode(), headers)
        self.assertEqual(code, 400)
        self.assertIn('двух одновременных списаний', json.loads(body)['error'])
        self.assertFalse(self.s.platega.called)

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
                            'password_confirmation':'password-123','role':'admin',
                            'legal_accepted':True,'parent_confirmed':True}).encode()
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

    def test_avatar_and_voice_storage_is_isolated_between_accounts(self):
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token}
        self.assertEqual(self.request('/api/avatar-model',glb(),headers)[0],200)
        second=self.s.auth.register('second-user','second@example.com','password-123','password-123')
        second_session=self.s.auth.create_session(second.id)
        req=urllib.request.Request(self.s.origin+'/api/avatar-model',headers={
            'Cookie':'parentai_session='+second_session,'X-App-Token':self.s.token})
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(req)
        self.assertEqual(error.exception.code,404)
        self.assertNotEqual(self.s.profile_runtime(1).data,self.s.profile_runtime(second.id).data)

    def test_registration_requires_parental_legal_consent(self):
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        payload=json.dumps({'login':'new-user','email':'new@example.com','password':'password-123',
                            'password_confirmation':'password-123'}).encode()
        code,body=self.request('/api/auth/register',payload,headers,authenticated=False)
        self.assertEqual(code,400)
        self.assertIn('родитель',json.loads(body)['error'])

    def test_account_deletion_requires_password_and_removes_private_data(self):
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        self.assertEqual(self.request('/api/avatar-model',glb(),headers)[0],200)
        profile=self.s.profile_runtime(1).data
        self.assertTrue(profile.is_dir())
        wrong=json.dumps({'password':'wrong-password','confirmation':'УДАЛИТЬ'}).encode()
        self.assertEqual(self.request('/api/auth/delete',wrong,headers)[0],400)
        value=json.dumps({'password':'password-123','confirmation':'УДАЛИТЬ'}).encode()
        code,body,response_headers=self.request('/api/auth/delete',value,headers,include_headers=True)
        self.assertEqual(code,200)
        self.assertFalse(profile.exists())
        self.assertIn('Max-Age=0',response_headers['Set-Cookie'])
        self.assertIsNone(self.s.auth.authenticate('test-user','password-123'))
        self.assertEqual(self.request('/api/status',headers={'X-App-Token':self.s.token})[0],401)

    def test_closed_beta_registration_checks_invite_code(self):
        self.s.invite_code='beta-secret'
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        value={'login':'invited-user','email':'invited@example.com','password':'password-123',
               'password_confirmation':'password-123','legal_accepted':True,'parent_confirmed':True}
        self.assertEqual(self.request('/api/auth/register',json.dumps(value).encode(),headers,
                                      authenticated=False)[0],400)
        value['invite_code']='beta-secret'
        self.assertEqual(self.request('/api/auth/register',json.dumps(value).encode(),headers,
                                      authenticated=False)[0],201)

    def test_speech_dialog_and_reply_audio_are_protected(self):
        for path in ('/api/speech','/api/dialog','/api/dialog-cancel'):
            self.assertEqual(self.request(path,b'{}')[0],403)
        self.assertEqual(self.request('/api/dialog/guess')[0],403)
        self.assertEqual(self.request('/api/dialog-audio/guess')[0],403)
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token}
        self.assertEqual(self.request('/api/dialog',b'{}',headers)[0],400)

    def test_local_speech_has_zero_external_cost(self):
        class LocalSpeech:
            def public_status(self):
                return {'enabled':True,'provider':'Локальный Whisper','model':'test-whisper','local':True}
            def recognize(self, payload):
                return 'Помоги решить задачу'
        self.s.speech = LocalSpeech()
        result = self.s.recognize(1, recording(), 'local-speech-request')
        self.assertEqual(result['text'], 'Помоги решить задачу')
        dashboard = self.s.usage.dashboard(1)
        self.assertEqual(dashboard['usage']['external_cost_rubles'], '0.0000')

    def test_speech_falls_back_to_second_engine_and_accounts_actual_provider(self):
        class BrokenLocal:
            def public_status(self):
                return {'enabled':True,'provider':'Локальный Whisper','model':'test','local':True}
            def recognize(self, payload):
                raise ValueError('локальная модель временно недоступна')
        class WorkingCloud:
            def public_status(self):
                return {'enabled':True,'provider':'Yandex SpeechKit'}
            def recognize(self, payload):
                return 'Резерв распознал вопрос'
        self.s.speech = BrokenLocal()
        self.s.speech_fallbacks = [WorkingCloud()]
        result = self.s.recognize(1, recording(), 'fallback-speech-request')
        self.assertEqual(result['text'], 'Резерв распознал вопрос')
        self.assertEqual(result['speech_provider'], 'Yandex SpeechKit')
        self.assertEqual(self.s.speech_status()['fallback'], 'Yandex SpeechKit')
        self.assertGreater(float(self.s.usage.dashboard(1)['usage']['external_cost_rubles']), 0)

    def test_tutor_is_protected_and_reports_missing_configuration(self):
        payload=json.dumps({'question':'Помоги','history':[],'level':'средняя школа'}).encode()
        self.assertEqual(self.request('/api/tutor',payload)[0],403)
        headers={'Origin':self.s.origin,'X-App-Token':self.s.token,'Content-Type':'application/json'}
        code, body = self.request('/api/tutor',payload,headers)
        self.assertEqual(code,400)
        self.assertIn('не настроен',json.loads(body)['error'])
