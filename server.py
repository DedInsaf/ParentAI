"""Loopback-only bridge. Avatar scans and voice references stay private on the device."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import CookieError, SimpleCookie
import json
import mimetypes
from pathlib import Path
import secrets
import math
import threading
import time
import uuid
from collections import defaultdict, deque
from urllib.parse import urlsplit, parse_qs
from runtime import ROOT
from tutor import Tutor
from speech import SpeechRecognizer, SpeechSynthesizer, audio_duration_ms
from dialogue import Dialogues
from avatar_model import MAX_MODEL_BYTES, model_path, save_model, scanner_status
from auth import AuthStore, SESSION_LIFETIME
from usage import LimitExceeded, UsageStore, estimate_tokens
import os


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, runtime, port=0):
        self.runtime = runtime
        self.tutor = Tutor.from_environment(ROOT)
        self.speech = SpeechRecognizer(os.getenv('YANDEX_SPEECHKIT_API_KEY') or os.getenv('YANDEX_API_KEY'))
        self.fast_voice=SpeechSynthesizer(os.getenv('YANDEX_TTS_API_KEY') or os.getenv('YANDEX_SPEECHKIT_API_KEY') or os.getenv('YANDEX_API_KEY'))
        self.auth = AuthStore(runtime.data / 'users.sqlite3')
        self.usage = UsageStore(runtime.data / 'usage.sqlite3')
        self.dialogues = Dialogues(runtime,self.tutor,self.fast_voice,self.usage)
        self.speech_lock = threading.RLock()
        self.speech_cache = {}
        self.speech_recent = defaultdict(deque)
        self.token = secrets.token_urlsafe(32)
        super().__init__(('127.0.0.1', port), Handler)
        self.origin = f'http://127.0.0.1:{self.server_port}'

    def server_close(self):
        self.dialogues.close()
        super().server_close()

    def recognize(self, user_id, payload, request_id, unlimited=False):
        request_id = request_id if isinstance(request_id, str) and 8 <= len(request_id) <= 100 else uuid.uuid4().hex
        cache_key = (user_id, request_id)
        with self.speech_lock:
            now = time.monotonic()
            for key, item in list(self.speech_cache.items()):
                if now - item[0] > 300:
                    del self.speech_cache[key]
            if cache_key in self.speech_cache:
                return self.speech_cache[cache_key][1]
            recent = self.speech_recent[user_id]
            while recent and now - recent[0] > 60:
                recent.popleft()
            if recent and now - recent[-1] < .5:
                raise ValueError('Подожди секунду перед следующим голосовым вопросом.')
            if len(recent) >= 12:
                raise ValueError('Слишком много голосовых вопросов подряд. Сделай короткий перерыв.')
            recent.append(now)
            duration = audio_duration_ms(payload)
            billed_seconds = max(15, math.ceil(duration / 15000) * 15)
            reservation = self.usage.reserve(
                user_id, 'stt', request_id, duration_ms=duration, billed_units=billed_seconds,
                estimated_cost=self.usage.config.stt_cost(billed_seconds),
                provider='Yandex SpeechKit', model='general-v1', bypass_limits=unlimited)
            try:
                text = self.speech.recognize(payload)
            except Exception:
                self.usage.fail(reservation['id'])
                raise
            self.usage.complete(reservation['id'], duration_ms=duration, billed_units=billed_seconds,
                                cost=self.usage.config.stt_cost(billed_seconds), actual_usage=True)
            result = {'text': text, 'limit_warning': reservation['warning']}
            self.speech_cache[cache_key] = (now, result)
            return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, body, kind='application/json', headers=None):
        if kind == 'application/json':
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        return self.headers.get('Host') == urlsplit(self.server.origin).netloc

    def session_token(self):
        try:
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            value = cookie.get('parentai_session')
            return value.value if value else None
        except CookieError:
            return None

    def current_user(self):
        return self.server.auth.user_for_session(self.session_token())

    def session_cookie(self, token):
        return (f'parentai_session={token}; Path=/; Max-Age={SESSION_LIFETIME}; '
                'HttpOnly; SameSite=Strict')

    def clear_session_cookie(self):
        return 'parentai_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'

    def do_GET(self):
        if not self.allowed():
            return self.send(403, {'error': 'Invalid host'})
        path = urlsplit(self.path).path
        if path == '/api/session':
            if self.headers.get('Sec-Fetch-Site', 'same-origin') not in ('same-origin', 'none'):
                return self.send(403, {'error': 'Invalid origin'})
            user = self.current_user()
            return self.send(200, {'token': self.server.token, 'user': user.public() if user else None})
        if path in ('/api/parent/summary', '/api/metrics/cost'):
            if self.headers.get('X-App-Token') != self.server.token:
                return self.send(403, {'error': 'Invalid token'})
            user = self.current_user()
            if not user:
                return self.send(401, {'error': 'Войдите в аккаунт.'})
            if path == '/api/metrics/cost' and user.role != 'admin':
                return self.send(403, {'error': 'Метрики стоимости доступны только администратору.'})
            value = (self.server.usage.dashboard(user.id, user.role == 'admin') if path == '/api/parent/summary'
                     else self.server.usage.cost_metrics())
            return self.send(200, value)
        if path.startswith(('/api/dialog/', '/api/dialog-audio/')):
            if self.headers.get('X-App-Token') != self.server.token:
                return self.send(403, {'error': 'Invalid token'})
            user = self.current_user()
            if not user:
                return self.send(401, {'error': 'Войдите в аккаунт.'})
            try:
                key = path.rsplit('/', 1)[1]
                if path.startswith('/api/dialog-audio/'):
                    part=parse_qs(urlsplit(self.path).query).get('chunk',[None])[0]
                    return self.send(200, self.server.dialogues.audio(
                        key, None if part is None else int(part), user.id).read_bytes(), 'audio/wav')
                return self.send(200, self.server.dialogues.snapshot(key, user.id))
            except (ValueError,OSError) as exc:
                return self.send(404, {'error': str(exc)})
        if path in ('/api/status', '/api/avatar', '/api/avatar-model'):
            if self.headers.get('X-App-Token') != self.server.token:
                return self.send(403, {'error': 'Invalid token'})
            user = self.current_user()
            if not user:
                return self.send(401, {'error': 'Войдите в аккаунт.'})
            if path == '/api/avatar-model':
                try:
                    return self.send(200, model_path(self.server.runtime).read_bytes(), 'model/gltf-binary')
                except (ValueError, OSError) as exc:
                    return self.send(404, {'error': str(exc)})
            if path == '/api/avatar':
                value = self.server.runtime.avatar()
            else:
                value = {**self.server.runtime.snapshot(), 'tutor': self.server.tutor.public_status(),
                         'speech': self.server.speech.public_status(),'fast_voice':self.server.fast_voice.public_status()}
                value['voice_engine']=self.server.runtime.voice_engine.status()
                value['scanner']=scanner_status()
                value['usage']=self.server.usage.dashboard(user.id, user.role == 'admin')
            return self.send(200, value)
        root = self.server.runtime.data if path.startswith('/audio/') else ROOT / 'web'
        if root == self.server.runtime.data and not self.current_user():
            return self.send(401, {'error': 'Войдите в аккаунт.'})
        relative = path[len('/audio/'):] if path.startswith('/audio/') else path.lstrip('/') or 'avatar.html'
        target = (root / relative).resolve()
        if not target.is_relative_to(root.resolve()) or not target.is_file():
            return self.send(404, {'error': 'Not found'})
        # Serve only published WAVs, not references/logs or arbitrary backend files.
        if root == self.server.runtime.data:
            allowed = {'reference.wav'} | {item['file'] for item in self.server.runtime.snapshot()['phrases']}
            if relative not in allowed:
                return self.send(404, {'error': 'Not found'})
        self.send(200, target.read_bytes(), mimetypes.guess_type(str(target))[0] or 'application/octet-stream')

    def do_POST(self):
        if (not self.allowed() or self.headers.get('Origin') != self.server.origin
                or self.headers.get('X-App-Token') != self.server.token):
            return self.send(403, {'error': 'Invalid origin or token'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            path = urlsplit(self.path).path
            limit = MAX_MODEL_BYTES if path == '/api/avatar-model' else 10_000_000
            if not 0 <= size <= limit:
                return self.send(413, {'error': 'Модель слишком большая' if path == '/api/avatar-model' else 'Запись слишком большая'})
            self.connection.settimeout(70)
            payload = self.rfile.read(size)
            if len(payload) != size:
                raise ValueError('Передача данных прервалась. Повторите попытку.')
            if path == '/api/auth/register':
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректные данные регистрации.')
                user = self.server.auth.register(
                    value.get('login'), value.get('email'), value.get('password'),
                    value.get('password_confirmation'))
                session = self.server.auth.create_session(user.id)
                return self.send(201, {'user': user.public()}, headers={'Set-Cookie': self.session_cookie(session)})
            if path == '/api/auth/login':
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректные данные входа.')
                user = self.server.auth.authenticate(value.get('identifier'), value.get('password'))
                if not user:
                    return self.send(401, {'error': 'Неверный логин, почта или пароль.'})
                session = self.server.auth.create_session(user.id)
                return self.send(200, {'user': user.public()}, headers={'Set-Cookie': self.session_cookie(session)})
            user = self.current_user()
            if not user:
                return self.send(401, {'error': 'Войдите в аккаунт.'})
            if path == '/api/auth/logout':
                self.server.auth.delete_session(self.session_token())
                return self.send(200, {'ok': True}, headers={'Set-Cookie': self.clear_session_cookie()})
            if path == '/api/avatar-model':
                return self.send(200, save_model(self.server.runtime, payload))
            if path == '/api/avatar':
                return self.send(200, self.server.runtime.avatar(json.loads(payload)))
            if path == '/api/speech':
                return self.send(200, self.server.recognize(
                    user.id, payload, self.headers.get('X-Request-Id'), user.role == 'admin'))
            if path == '/api/voice-warm':
                runtime=self.server.runtime
                with runtime.lock:
                    if runtime.reference_mode=='clone' and runtime.status['reference'] and runtime.status['voice'] not in ('generating','cancelling'):
                        runtime.voice_engine.warm(runtime.data/'reference.wav')
                return self.send(202,{'ok':True})
            if path == '/api/voice-release':
                self.server.runtime.voice_engine.release()
                return self.send(200,{'ok':True})
            if path == '/api/dialog':
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректный запрос.')
                return self.send(202, self.server.dialogues.start(
                    value.get('question'), value.get('level'), value.get('session'),
                    value.get('voice','parent'), user.id, value.get('request_id'), user.role == 'admin'))
            if path == '/api/dialog-cancel':
                value = json.loads(payload)
                if not isinstance(value, dict) or not isinstance(value.get('id'), str):
                    raise ValueError('Некорректный запрос.')
                self.server.dialogues.cancel(value['id'], user.id)
                return self.send(200, {'ok': True})
            if path == '/api/tutor':
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректный запрос помощнику.')
                question = value.get('question')
                estimated_input = estimate_tokens(question or '') + 250
                estimated_output = 450
                request_id = self.headers.get('X-Request-Id') or uuid.uuid4().hex
                lesson_id = uuid.uuid4().hex
                reservation = self.server.usage.reserve(
                    user.id, 'llm', request_id, lesson_id=lesson_id, input_units=estimated_input, output_units=estimated_output,
                    estimated_cost=self.server.usage.config.llm_cost(estimated_input, estimated_output),
                    provider='YandexGPT', model=self.server.tutor.model, new_lesson=True,
                    bypass_limits=user.role == 'admin')
                if reservation['duplicate']:
                    raise ValueError('Этот запрос уже обрабатывался. Отправьте новый вопрос.')
                try:
                    result = self.server.tutor.answer(question, value.get('history', []), value.get('level'))
                except Exception:
                    self.server.usage.fail(reservation['id'])
                    self.server.usage.abandon_empty_lesson(user.id, lesson_id)
                    raise
                usage = result.get('usage', {})
                input_tokens, output_tokens = usage.get('input_tokens', estimated_input), usage.get('output_tokens', estimated_output)
                self.server.usage.complete(
                    reservation['id'], input_units=input_tokens, output_units=output_tokens,
                    cost=self.server.usage.config.llm_cost(input_tokens, output_tokens),
                    actual_usage=usage.get('actual', False))
                result['limit_warning'] = reservation['warning']
                return self.send(200, result)
            if path == '/api/cancel':
                self.server.runtime.cancel_generation()
                return self.send(200, {'ok': True})
            if path == '/api/reference':
                mode = parse_qs(urlsplit(self.path).query).get('mode', ['clone'])[0]
                return self.send(200, self.server.runtime.reference(payload, mode))
            if self.path == '/api/generate':
                self.server.runtime.generate()
                return self.send(202, {'ok': True})
            self.send(404, {'error': 'Not found'})
        except LimitExceeded as exc:
            self.send(429, {'error': str(exc), 'limit': True})
        except ValueError as exc:
            self.send(400, {'error': str(exc)})
        except Exception as exc:
            self.send(500, {'error': str(exc)})
