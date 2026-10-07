"""Loopback-only bridge. Avatar scans and voice references stay private on the device."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import secrets
from urllib.parse import urlsplit, parse_qs
from runtime import ROOT
from tutor import Tutor
from speech import SpeechRecognizer, SpeechSynthesizer
from dialogue import Dialogues
from avatar_model import MAX_MODEL_BYTES, model_path, save_model, scanner_status
import os


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, runtime, port=0):
        self.runtime = runtime
        self.tutor = Tutor.from_environment(ROOT)
        self.speech = SpeechRecognizer(os.getenv('YANDEX_SPEECHKIT_API_KEY') or os.getenv('YANDEX_API_KEY'))
        self.fast_voice=SpeechSynthesizer(os.getenv('YANDEX_TTS_API_KEY') or os.getenv('YANDEX_SPEECHKIT_API_KEY') or os.getenv('YANDEX_API_KEY'))
        self.dialogues = Dialogues(runtime,self.tutor,self.fast_voice)
        self.token = secrets.token_urlsafe(32)
        super().__init__(('127.0.0.1', port), Handler)
        self.origin = f'http://127.0.0.1:{self.server_port}'

    def server_close(self):
        self.dialogues.close()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, body, kind='application/json'):
        if kind == 'application/json':
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        return self.headers.get('Host') == urlsplit(self.server.origin).netloc

    def do_GET(self):
        if not self.allowed():
            return self.send(403, {'error': 'Invalid host'})
        path = urlsplit(self.path).path
        if path.startswith(('/api/dialog/', '/api/dialog-audio/')):
            if self.headers.get('X-App-Token') != self.server.token:
                return self.send(403, {'error': 'Invalid token'})
            try:
                key = path.rsplit('/', 1)[1]
                if path.startswith('/api/dialog-audio/'):
                    part=parse_qs(urlsplit(self.path).query).get('chunk',[None])[0]
                    return self.send(200, self.server.dialogues.audio(key,None if part is None else int(part)).read_bytes(), 'audio/wav')
                return self.send(200, self.server.dialogues.snapshot(key))
            except (ValueError,OSError) as exc:
                return self.send(404, {'error': str(exc)})
        if path in ('/api/status', '/api/avatar', '/api/avatar-model'):
            if self.headers.get('X-App-Token') != self.server.token:
                return self.send(403, {'error': 'Invalid token'})
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
            return self.send(200, value)
        if path == '/api/session':
            if self.headers.get('Sec-Fetch-Site', 'same-origin') not in ('same-origin', 'none'):
                return self.send(403, {'error': 'Invalid origin'})
            return self.send(200, {'token': self.server.token})
        root = self.server.runtime.data if path.startswith('/audio/') else ROOT / 'web'
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
            if path == '/api/avatar-model':
                return self.send(200, save_model(self.server.runtime, payload))
            if path == '/api/avatar':
                return self.send(200, self.server.runtime.avatar(json.loads(payload)))
            if path == '/api/speech':
                return self.send(200, {'text': self.server.speech.recognize(payload)})
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
                return self.send(202, self.server.dialogues.start(value.get('question'), value.get('level'), value.get('session'),value.get('voice','parent')))
            if path == '/api/dialog-cancel':
                value = json.loads(payload)
                if not isinstance(value, dict) or not isinstance(value.get('id'), str):
                    raise ValueError('Некорректный запрос.')
                self.server.dialogues.cancel(value['id'])
                return self.send(200, {'ok': True})
            if path == '/api/tutor':
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError('Некорректный запрос помощнику.')
                return self.send(200, self.server.tutor.answer(
                    value.get('question'), value.get('history', []), value.get('level')))
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
        except ValueError as exc:
            self.send(400, {'error': str(exc)})
        except Exception as exc:
            self.send(500, {'error': str(exc)})
