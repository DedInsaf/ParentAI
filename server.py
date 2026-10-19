"""Authenticated web application server for local use and small hosted betas."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import CookieError, SimpleCookie
from email.utils import formatdate
import json
import logging
import mimetypes
from pathlib import Path
import secrets
import math
import shutil
import threading
import time
import uuid
from collections import defaultdict, deque
from urllib.parse import urlsplit, parse_qs
from runtime import ROOT, Runtime
from tutor import Tutor
from speech import LocalSpeechRecognizer, SpeechRecognizer, SpeechSynthesizer, audio_duration_ms
from dialogue import Dialogues
from avatar_model import MAX_MODEL_BYTES, model_path, save_model, scanner_status
from auth import AuthStore, SESSION_LIFETIME
from usage import LimitExceeded, UsageStore, estimate_tokens
from payments import PlategaClient
import os


LOGGER = logging.getLogger(__name__)


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, runtime, port=0, warm_speech=True, bind=None, public_origin=None):
        self.runtime = runtime
        self.profile_lock = threading.RLock()
        self.profile_runtimes = {}
        self.tutor = Tutor.from_environment(ROOT)
        # PRODUCT INVARIANT: speech recognition is local-first by default. If
        # the installed model cannot handle a fragment and a SpeechKit key is
        # configured, the bounded fragment gets one cloud fallback path.
        stt_engine = os.getenv('PARENTAI_STT_ENGINE', 'local').strip().lower()
        speechkit_key = os.getenv('YANDEX_SPEECHKIT_API_KEY') or os.getenv('YANDEX_API_KEY')
        local_speech = LocalSpeechRecognizer(
            os.getenv('PARENTAI_STT_MODEL', 'openai/whisper-small'),
            runtime.data / 'models' / 'huggingface')
        yandex_speech = SpeechRecognizer(speechkit_key)
        if stt_engine == 'yandex':
            self.speech, self.speech_fallbacks = yandex_speech, [local_speech]
        else:
            self.speech = local_speech
            self.speech_fallbacks = [yandex_speech] if speechkit_key else []
        self.fast_voice=SpeechSynthesizer(os.getenv('YANDEX_TTS_API_KEY') or os.getenv('YANDEX_SPEECHKIT_API_KEY') or os.getenv('YANDEX_API_KEY'))
        self.auth = AuthStore(runtime.data / 'users.sqlite3')
        self.usage = UsageStore(runtime.data / 'usage.sqlite3')
        self.usage.recover_interrupted_events()
        self.platega = PlategaClient(os.getenv('PLATEGA_MERCHANT_ID'), os.getenv('PLATEGA_SECRET'))
        self.dialogues = Dialogues(runtime,self.tutor,self.fast_voice,self.usage,
                                   runtime_for=self.profile_runtime)
        self.speech_lock = threading.RLock()
        self.speech_cache = {}
        self.speech_recent = defaultdict(deque)
        self.payment_locks = defaultdict(threading.Lock)
        self.auth_lock = threading.RLock()
        self.auth_attempts = defaultdict(deque)
        self.token = secrets.token_urlsafe(32)
        bind = bind or os.getenv('PARENTAI_BIND', '127.0.0.1')
        super().__init__((bind, port), Handler)
        local_host = '127.0.0.1' if bind in ('0.0.0.0', '::') else bind
        self.listen_origin = f'http://{local_host}:{self.server_port}'
        self.origin = (public_origin or os.getenv('PARENTAI_PUBLIC_ORIGIN', '') or self.listen_origin).rstrip('/')
        if warm_speech and local_speech.public_status().get('enabled'):
            threading.Thread(target=local_speech.warm, name='speech-warmup', daemon=True).start()

    def server_close(self):
        self.dialogues.close()
        with self.profile_lock:
            profiles = list(self.profile_runtimes.values())
            self.profile_runtimes.clear()
        for runtime in profiles:
            runtime.close()
        super().server_close()

    def profile_runtime(self, user_id):
        """Return an isolated avatar/voice store for exactly one account."""
        user_id = int(user_id)
        if user_id < 1:
            raise ValueError('Некорректный профиль пользователя.')
        with self.profile_lock:
            runtime = self.profile_runtimes.get(user_id)
            if runtime is None:
                runtime = Runtime(self.runtime.data / 'profiles' / str(user_id))
                self.profile_runtimes[user_id] = runtime
            return runtime

    def delete_profile(self, user_id):
        user_id = int(user_id)
        self.unload_profile(user_id)
        target = (self.runtime.data / 'profiles' / str(user_id)).resolve()
        profiles = (self.runtime.data / 'profiles').resolve()
        if target.parent == profiles:
            shutil.rmtree(target, ignore_errors=True)

    def unload_profile(self, user_id):
        """Stop per-user workers and caches without deleting the saved profile."""
        user_id = int(user_id)
        with self.profile_lock:
            runtime = self.profile_runtimes.pop(user_id, None)
        if runtime:
            runtime.cancel_generation()
            runtime.close()
        with self.speech_lock:
            for key in [key for key in self.speech_cache if key[0] == user_id]:
                del self.speech_cache[key]
            self.speech_recent.pop(user_id, None)

    def admin_account(self, user_id):
        account = self.auth.user_for_admin(user_id)
        if not account:
            raise ValueError('Пользователь не найден.')
        usage = self.usage.admin_overviews([user_id]).get(int(user_id), {})
        return {**account, **usage}

    def admin_accounts(self, search='', limit=50, offset=0):
        page = self.auth.list_users(search, limit, offset)
        overviews = self.usage.admin_overviews(item['id'] for item in page['users'])
        page['users'] = [{**item, **overviews.get(item['id'], {})} for item in page['users']]
        page['stats'] = {**self.auth.user_counts(), **self.usage.admin_plan_counts()}
        return page

    def allow_auth_attempt(self, key, action):
        now = time.monotonic()
        window, maximum = (3600, 5) if action == 'register' else (300, 10)
        with self.auth_lock:
            bucket = self.auth_attempts[(key, action)]
            while bucket and now - bucket[0] > window:
                bucket.popleft()
            if len(bucket) >= maximum:
                return False
            bucket.append(now)
            return True

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
            warning = ''
            engines = [self.speech, *getattr(self, 'speech_fallbacks', [])]
            for index, engine in enumerate(engines):
                speech_status = engine.public_status()
                if not speech_status.get('enabled'):
                    continue
                local_speech = bool(speech_status.get('local'))
                billed_seconds = 0 if local_speech else max(15, math.ceil(duration / 15000) * 15)
                operation_id = request_id if index == 0 else f'{request_id}-fallback-{index}'
                reservation = self.usage.reserve(
                    user_id, 'stt', operation_id, duration_ms=duration, billed_units=billed_seconds,
                    estimated_cost=0 if local_speech else self.usage.config.stt_cost(billed_seconds),
                    provider=speech_status.get('provider', ''),
                    model=speech_status.get('model', 'general-v1'), bypass_limits=unlimited)
                try:
                    text = engine.recognize(payload)
                except Exception as exc:
                    self.usage.fail(reservation['id'])
                    LOGGER.warning('Speech recognition failed for user %s via %s: %s',
                                   user_id, speech_status.get('provider', 'unknown'), exc)
                    continue
                self.usage.complete(
                    reservation['id'], duration_ms=duration, billed_units=billed_seconds,
                    cost=0 if local_speech else self.usage.config.stt_cost(billed_seconds),
                    actual_usage=not local_speech)
                warning = reservation['warning']
                break
            else:
                raise ValueError('Не удалось распознать вопрос. Повторите чуть медленнее или напишите его текстом.')
            result = {'text': text, 'limit_warning': warning,
                      'speech_provider': speech_status.get('provider', '')}
            self.speech_cache[cache_key] = (now, result)
            return result

    def speech_status(self):
        statuses = [engine.public_status()
                    for engine in [self.speech, *getattr(self, 'speech_fallbacks', [])]]
        enabled = [item for item in statuses if item.get('enabled')]
        if not enabled:
            return {**statuses[0], 'enabled': False, 'fallback': None}
        primary = enabled[0]
        fallback = enabled[1].get('provider') if len(enabled) > 1 else None
        return {**primary, 'enabled': True, 'fallback': fallback,
                'providers': [item.get('provider') for item in enabled]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def response_headers(self, kind, length, cache='no-store', headers=None):
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' "
                         "'sha256-y0joblgLTLFGhbj/xXhGS1SyGmxly/oZpyENyx9LBXI='; "
                         "style-src 'self' 'unsafe-inline'; "
                         "img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; "
                         "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
                         "form-action 'self'")
        self.send_header('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()')
        if self.server.origin.startswith('https://'):
            self.send_header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
        for name, value in (headers or {}).items():
            self.send_header(name, value)

    def send(self, code, body, kind='application/json', headers=None, cache='no-store'):
        if kind == 'application/json':
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.response_headers(kind, len(body), cache, headers)
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, target, kind=None, cache='private, no-store'):
        stat = target.stat()
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get('If-None-Match') == etag:
            self.send_response(304)
            self.response_headers(kind or 'application/octet-stream', 0, cache, {'ETag': etag})
            self.end_headers()
            return
        self.send_response(200)
        self.response_headers(kind or mimetypes.guess_type(str(target))[0] or 'application/octet-stream',
                              stat.st_size, cache, {'ETag': etag})
        self.end_headers()
        try:
            with target.open('rb') as source:
                shutil.copyfileobj(source, self.wfile, length=256 * 1024)
        except (BrokenPipeError, ConnectionResetError):
            # Closing a tab may stop a large model or audio download midway.
            return

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

    def client_key(self):
        address = self.client_address[0]
        if address in ('127.0.0.1', '::1'):
            forwarded = self.headers.get('X-Forwarded-For', '').split(',', 1)[0].strip()
            if forwarded:
                address = forwarded
        return address

    def session_cookie(self, token):
        expires = formatdate(time.time() + SESSION_LIFETIME, usegmt=True)
        secure = '; Secure' if self.server.origin.startswith('https://') else ''
        return (f'parentai_session={token}; Path=/; Max-Age={SESSION_LIFETIME}; Expires={expires}; '
                f'HttpOnly; SameSite=Strict{secure}')

    def clear_session_cookie(self):
        secure = '; Secure' if self.server.origin.startswith('https://') else ''
        return f'parentai_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict{secure}'

    def platega_webhook(self):
        if not self.server.platega.valid_callback(
                self.headers.get('X-MerchantId'), self.headers.get('X-Secret')):
            return self.send(403, {'error': 'Invalid Platega credentials'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 1 <= size <= 64_000:
                return self.send(413, {'error': 'Invalid callback size'})
            value = json.loads(self.rfile.read(size))
            if not isinstance(value, dict):
                raise ValueError('Некорректный callback Platega.')
            get = lambda *names: next((value[name] for name in names if name in value), None)
            provider_id = get('SubscriptionId', 'subscriptionId', 'Id', 'id')
            self.server.usage.payment_callback(
                provider_id, get('Status', 'status'), get('Amount', 'amount'),
                get('Currency', 'currency'))
            return self.send(200, {'ok': True})
        except (json.JSONDecodeError, ValueError) as exc:
            return self.send(400, {'error': str(exc)})

    def do_GET(self):
        if not self.allowed():
            return self.send(403, {'error': 'Invalid host'})
        path = urlsplit(self.path).path
        if path == '/api/health':
            return self.send(200, {'ok': True, 'service': 'adym'})
        if path == '/api/session':
            if self.headers.get('Sec-Fetch-Site', 'same-origin') not in ('same-origin', 'none'):
                return self.send(403, {'error': 'Invalid origin'})
            token = self.session_token()
            user = self.server.auth.user_for_session(token, renew=True)
            headers = {'Set-Cookie': self.session_cookie(token)} if user else None
            return self.send(200, {'token': self.server.token, 'user': user.public() if user else None},
                             headers=headers)
        if path in ('/api/admin/users', '/api/admin/audit'):
            if self.headers.get('X-App-Token') != self.server.token:
                return self.send(403, {'error': 'Invalid token'})
            user = self.current_user()
            if not user:
                return self.send(401, {'error': 'Войдите в аккаунт.'})
            if user.role != 'admin':
                return self.send(403, {'error': 'Доступно только администратору.'})
            query = parse_qs(urlsplit(self.path).query)
            if path == '/api/admin/audit':
                limit = query.get('limit', ['40'])[0]
                return self.send(200, {'entries': self.server.auth.admin_audit(limit)})
            return self.send(200, self.server.admin_accounts(
                query.get('q', [''])[0], query.get('limit', ['50'])[0],
                query.get('offset', ['0'])[0]))
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
                    return self.send_file(self.server.dialogues.audio(
                        key, None if part is None else int(part), user.id), 'audio/wav')
                return self.send(200, self.server.dialogues.snapshot(key, user.id))
            except (ValueError,OSError) as exc:
                return self.send(404, {'error': str(exc)})
        if path in ('/api/status', '/api/avatar', '/api/avatar-model'):
            if self.headers.get('X-App-Token') != self.server.token:
                return self.send(403, {'error': 'Invalid token'})
            user = self.current_user()
            if not user:
                return self.send(401, {'error': 'Войдите в аккаунт.'})
            runtime = self.server.profile_runtime(user.id)
            if path == '/api/avatar-model':
                try:
                    return self.send_file(model_path(runtime), 'model/gltf-binary')
                except (ValueError, OSError) as exc:
                    return self.send(404, {'error': str(exc)})
            if path == '/api/avatar':
                value = runtime.avatar()
            else:
                value = {**runtime.snapshot(), 'tutor': self.server.tutor.public_status(),
                         'speech': self.server.speech_status(),'fast_voice':self.server.fast_voice.public_status()}
                value['assets'] = self.server.runtime.snapshot().get('assets', value.get('assets'))
                value['voice_engine']=runtime.voice_engine.status()
                value['scanner']=scanner_status()
                value['usage']=self.server.usage.dashboard(user.id, user.role == 'admin')
                value['billing']={'provider':self.server.platega.public_status(),
                                  'plans':self.server.usage.catalog()}
            return self.send(200, value)
        audio_user = self.current_user() if path.startswith('/audio/') else None
        if path.startswith('/audio/') and not audio_user:
            return self.send(401, {'error': 'Войдите в аккаунт.'})
        runtime = self.server.profile_runtime(audio_user.id) if audio_user else None
        root = runtime.data if runtime else ROOT / 'web'
        relative = path[len('/audio/'):] if path.startswith('/audio/') else path.lstrip('/') or 'avatar.html'
        target = (root / relative).resolve()
        if not target.is_relative_to(root.resolve()) or not target.is_file():
            return self.send(404, {'error': 'Not found'})
        # Serve only published WAVs, not references/logs or arbitrary backend files.
        if runtime:
            allowed = {path.name for path in runtime.reference_paths()} | {item['file'] for item in runtime.snapshot()['phrases']}
            if relative not in allowed:
                return self.send(404, {'error': 'Not found'})
        cache = ('public, max-age=31536000, immutable'
                 if not runtime and relative.startswith('vendor/') else
                 'private, no-store' if runtime else 'no-cache')
        self.send_file(target, cache=cache)

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == '/api/webhooks/platega':
            return self.platega_webhook()
        if (not self.allowed() or self.headers.get('Origin') != self.server.origin
                or self.headers.get('X-App-Token') != self.server.token):
            return self.send(403, {'error': 'Invalid origin or token'})
        try:
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except (TypeError, ValueError):
                return self.send(400, {'error': 'Некорректный размер запроса.'})
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
                if not self.server.allow_auth_attempt(self.client_key(), 'register'):
                    return self.send(429, {'error': 'Слишком много попыток регистрации. Повторите позже.'})
                if value.get('legal_accepted') is not True or value.get('parent_confirmed') is not True:
                    raise ValueError('Регистрацию должен подтвердить совершеннолетний родитель, приняв документы.')
                user = self.server.auth.register(
                    value.get('login'), value.get('email'), value.get('password'),
                    value.get('password_confirmation'), legal_accepted=True, parent_confirmed=True)
                session = self.server.auth.create_session(user.id)
                return self.send(201, {'user': user.public()}, headers={'Set-Cookie': self.session_cookie(session)})
            if path == '/api/auth/login':
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректные данные входа.')
                if not self.server.allow_auth_attempt(self.client_key(), 'login'):
                    return self.send(429, {'error': 'Слишком много попыток входа. Повторите через несколько минут.'})
                user, login_status = self.server.auth.authenticate_with_status(
                    value.get('identifier'), value.get('password'))
                if login_status == 'banned':
                    return self.send(403, {'error': 'Аккаунт заблокирован. Обратитесь в поддержку Адым.'})
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
            if path == '/api/auth/delete':
                value = json.loads(payload)
                if not isinstance(value, dict) or value.get('confirmation') != 'УДАЛИТЬ':
                    raise ValueError('Введите слово УДАЛИТЬ для подтверждения.')
                if not self.server.auth.verify_password(user.id, value.get('password')):
                    raise ValueError('Неверный пароль.')
                subscription = self.server.usage.subscription(user.id)
                if subscription['plan'] in ('paid', 'ultra') or self.server.usage.pending_checkout(user.id):
                    raise ValueError('Сначала отмените подписку через поддержку, затем удалите аккаунт.')
                self.server.dialogues.cancel_user(user.id)
                self.server.delete_profile(user.id)
                self.server.usage.delete_user_data(user.id)
                self.server.auth.delete_user(user.id)
                return self.send(200, {'ok': True}, headers={'Set-Cookie': self.clear_session_cookie()})
            if path == '/api/admin/user':
                if user.role != 'admin':
                    return self.send(403, {'error': 'Доступно только администратору.'})
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректное действие администратора.')
                try:
                    target_id = int(value.get('user_id'))
                except (TypeError, ValueError):
                    raise ValueError('Пользователь не найден.') from None
                target = self.server.auth.user_for_admin(target_id)
                if not target:
                    raise ValueError('Пользователь не найден.')
                if target_id == user.id or target['role'] == 'admin':
                    raise ValueError('Другие администраторы защищены от изменений в панели.')
                action = value.get('action')
                details = {}
                if action == 'ban':
                    reason = value.get('reason', '')
                    result = self.server.auth.set_banned(target_id, True, reason)
                    self.server.dialogues.cancel_user(target_id)
                    self.server.unload_profile(target_id)
                    details = {'reason': ' '.join(str(reason or '').split())[:240]}
                elif action == 'unban':
                    result = self.server.auth.set_banned(target_id, False)
                elif action == 'set_plan':
                    plan = value.get('plan')
                    if plan not in ('free', 'paid', 'ultra'):
                        raise ValueError('Неизвестный тариф.')
                    self.server.usage.set_subscription(target_id, plan)
                    result = {'id': target_id, 'login': target['login'], 'plan': plan}
                    details = {'plan': plan}
                elif action == 'revoke_sessions':
                    result = self.server.auth.revoke_user_sessions(target_id)
                    self.server.dialogues.cancel_user(target_id)
                    self.server.unload_profile(target_id)
                else:
                    raise ValueError('Неизвестное действие администратора.')
                self.server.auth.record_admin_action(
                    user.id, target_id, target['login'], action, details)
                return self.send(200, {'ok': True, 'result': result,
                                       'user': self.server.admin_account(target_id)})
            if path == '/api/billing/checkout':
                value = json.loads(payload)
                plan = value.get('plan') if isinstance(value, dict) else None
                if plan not in ('paid', 'ultra'):
                    raise ValueError('Неизвестный тариф подписки.')
                if user.role == 'admin':
                    raise ValueError('У администратора уже есть тестовый доступ без ограничений.')
                current_plan = self.server.usage.subscription(user.id)['plan']
                if current_plan == plan:
                    raise ValueError('Этот тариф уже подключён.')
                if current_plan in ('paid', 'ultra'):
                    raise ValueError(
                        'Сначала отмените действующую подписку через Platega или обратитесь в поддержку. '
                        'Это защищает от двух одновременных списаний.'
                    )
                with self.server.payment_locks[user.id]:
                    pending = self.server.usage.pending_checkout(user.id)
                    if pending:
                        if pending['plan'] != plan:
                            raise ValueError('Сначала завершите уже начатое оформление подписки.')
                        return self.send(200, {'provider':'Platega', 'redirect':pending['redirect_url'],
                                               'status':'pending', 'duplicate':True})
                    catalog = self.server.usage.catalog()[plan]
                    amount = catalog['monthly_price_rubles']
                    checkout = self.server.platega.create_subscription(amount, catalog['title'])
                    self.server.usage.record_checkout(
                        user.id, checkout['provider_id'], checkout['redirect'], amount, plan)
                return self.send(201, {'provider':'Platega', 'redirect':checkout['redirect'],
                                       'status':'pending', 'duplicate':False})
            if path == '/api/study-session':
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректное управление занятием.')
                action = value.get('action')
                if action == 'start':
                    return self.send(201, self.server.usage.start_study_session(
                        user.id, user.role == 'admin'))
                return self.send(200, self.server.usage.control_study_session(
                    user.id, value.get('id'), action, user.role == 'admin'))
            runtime = self.server.profile_runtime(user.id)
            if path == '/api/avatar-model':
                return self.send(200, save_model(runtime, payload))
            if path == '/api/avatar':
                return self.send(200, runtime.avatar(json.loads(payload)))
            if path == '/api/speech':
                # XTTS and Whisper are both large CPU models. A speculative
                # XTTS warm-up must not compete with recognition for RAM/CPU.
                # It will be started again only after the tutor has an answer.
                runtime.voice_engine.release()
                return self.send(200, self.server.recognize(
                    user.id, payload, self.headers.get('X-Request-Id'), user.role == 'admin'))
            if path == '/api/voice-warm':
                with runtime.lock:
                    if runtime.reference_mode=='clone' and runtime.status['reference'] and runtime.status['voice'] not in ('generating','cancelling'):
                        runtime.voice_engine.warm(runtime.reference_paths())
                return self.send(202,{'ok':True})
            if path == '/api/voice-release':
                runtime.voice_engine.release()
                return self.send(200,{'ok':True})
            if path == '/api/dialog':
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректный запрос.')
                return self.send(202, self.server.dialogues.start(
                    value.get('question'), value.get('level'), session=value.get('session'),
                    voice=value.get('voice','parent'), user_id=user.id,
                    request_id=value.get('request_id'), unlimited=user.role == 'admin',
                    study_session=value.get('study_session')))
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
                study = self.server.usage.start_study_session(user.id, user.role == 'admin')
                reservation = self.server.usage.reserve(
                    user.id, 'llm', request_id, lesson_id=lesson_id, study_session_id=study['id'],
                    input_units=estimated_input, output_units=estimated_output,
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
                    self.server.usage.control_study_session(user.id, study['id'], 'stop', user.role == 'admin')
                    raise
                usage = result.get('usage', {})
                input_tokens, output_tokens = usage.get('input_tokens', estimated_input), usage.get('output_tokens', estimated_output)
                self.server.usage.complete(
                    reservation['id'], input_units=input_tokens, output_units=output_tokens,
                    cost=self.server.usage.config.llm_cost(input_tokens, output_tokens),
                    actual_usage=usage.get('actual', False))
                result['limit_warning'] = reservation['warning']
                self.server.usage.control_study_session(user.id, study['id'], 'stop', user.role == 'admin')
                return self.send(200, result)
            if path == '/api/cancel':
                runtime.cancel_generation()
                return self.send(200, {'ok': True})
            if path == '/api/reference':
                query = parse_qs(urlsplit(self.path).query)
                mode = query.get('mode', ['clone'])[0]
                take = query.get('take', ['1'])[0]
                return self.send(200, runtime.reference(payload, mode, take))
            if path == '/api/generate':
                runtime.generate()
                return self.send(202, {'ok': True})
            self.send(404, {'error': 'Not found'})
        except LimitExceeded as exc:
            self.send(429, {'error': str(exc), 'limit': True})
        except ValueError as exc:
            self.send(400, {'error': str(exc)})
        except Exception:
            LOGGER.exception('Необработанная ошибка API %s', path)
            self.send(500, {'error': 'Внутренняя ошибка приложения. Повторите попытку.'})
