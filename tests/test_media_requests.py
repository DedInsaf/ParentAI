import concurrent.futures
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
from runtime import Runtime
from server import AppServer
from test_dialogue import recording


class MediaRequestTests(unittest.TestCase):
    def setUp(self):
        self.iterations = patch('auth.PASSWORD_ITERATIONS', 1000)
        self.iterations.start()
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Runtime(self.temp.name)
        self.server = AppServer(self.runtime, warm_speech=False, bind='127.0.0.1')
        # A deployment's .env must never send isolated tests to the live site.
        self.server.origin = self.server.listen_origin
        self.user = self.server.auth.register('media-user', 'media@example.com', 'password-123', 'password-123')
        self.session = self.server.auth.create_session(self.user.id)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.headers = {'Cookie': 'parentai_session=' + self.session,
                        'X-App-Token': self.server.token, 'Origin': self.server.origin}

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.temp.cleanup(); self.iterations.stop()

    def request(self, path, value=None):
        raw = None if value is None else json.dumps(value).encode()
        req = urllib.request.Request(self.server.origin + path, data=raw, headers=self.headers)
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def slow_recognition(self, entered, release):
        def recognize(*args):
            entered.set()
            if not release.wait(5):
                raise ValueError('test timed out')
            return {'text': 'тестовый вопрос'}
        self.server.recognize = recognize

    def test_decoder_loop_uses_fallback_without_forwarding_invented_question(self):
        class Decoder:
            def __init__(self, text, provider):
                self.text, self.provider = text, provider
            def public_status(self):
                return {'enabled': True, 'local': True, 'provider': self.provider}
            def recognize(self, payload):
                return self.text
        self.server.speech = Decoder('Спасибо. ' * 77, 'test-loop')
        self.server.speech_fallbacks = [Decoder('Сколько будет два плюс два?', 'test-fallback')]
        result = self.server.recognize(self.user.id, recording(), 'media-loop-request')
        self.assertEqual(result['text'], 'Сколько будет два плюс два?')
        self.assertEqual(result['speech_provider'], 'test-fallback')

    def test_status_and_pause_resume_do_not_wait_for_speech_recognition(self):
        entered, release = threading.Event(), threading.Event()
        self.slow_recognition(entered, release)
        lesson = self.request('/api/study-session', {'action': 'start'})[1]['id']
        with concurrent.futures.ThreadPoolExecutor() as pool:
            speech = pool.submit(self.request, '/api/speech', {})
            try:
                self.assertTrue(entered.wait(2))
                began = time.monotonic()
                self.assertEqual(self.request('/api/status')[0], 200)
                for action in ('pause', 'resume', 'pause'):
                    self.assertEqual(self.request('/api/study-session', {'action': action, 'id': lesson})[0], 200)
                self.assertLess(time.monotonic() - began, 2)
                self.assertFalse(speech.done())
            finally:
                release.set()
            self.assertEqual(speech.result()[0], 200)

    def test_erasure_waits_for_inflight_speech_and_revokes_queued_access(self):
        entered, release = threading.Event(), threading.Event()
        self.slow_recognition(entered, release)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            speech = pool.submit(self.request, '/api/speech', {})
            try:
                self.assertTrue(entered.wait(2))
                erase = pool.submit(self.request, '/api/auth/delete', {
                    'password': 'password-123', 'confirmation': 'УДАЛИТЬ'})
                gate = self.server.account_locks[self.user.id]
                with gate.condition:
                    self.assertTrue(gate.condition.wait_for(lambda: gate.waiting_writers > 0, timeout=2))
                self.assertIsNotNone(self.server.auth.user_for_admin(self.user.id))
                self.assertFalse(erase.done())
                status = pool.submit(self.request, '/api/status')
                release.set()
                self.assertEqual(speech.result()[0], 200)
                self.assertEqual(erase.result()[0], 200)
                self.assertEqual(status.result()[0], 401)
                self.assertIsNone(self.server.auth.user_for_admin(self.user.id))
                self.assertFalse((self.runtime.data / 'profiles' / str(self.user.id)).exists())
            finally:
                release.set()
