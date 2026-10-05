"""Local profile and bounded, cancellable voice generation. No LLM."""
import base64
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
from voice import prepare_reference

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
PHRASES = ['Давай вернёмся к заданию. У тебя получится.', 'Я рядом. Продолжим заниматься?',
           'Если нужна помощь, позови меня.', 'Сделаем ещё один маленький шаг.']
TTS_MODEL = 'tts_models/multilingual/multi-dataset/xtts_v2'
BUSY = ('generating', 'cancelling')


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


class Runtime:
    def __init__(self, data=DATA):
        self.data = Path(data)
        self.data.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.stop = threading.Event()
        self.process = None
        self.worker = None
        self.reply_busy = False
        self.reference_mode = 'clone'
        self.status = {'tts': 'Не загружена', 'assets': 'Ожидание загрузки', 'voice': 'idle',
                       'progress': '', 'error': '', 'reference': False}
        self.manifest = []
        try:
            saved = json.loads((self.data / 'manifest.json').read_text())
            if isinstance(saved, list) and saved and all(
                isinstance(item.get('text'), str) and self.safe_audio(item['file']).is_file() for item in saved
            ):
                self.manifest = saved
                self.status['voice'] = 'ready'
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
        if (self.data / 'reference.wav').is_file():
            self.status['reference'] = True
            try:
                self.reference_mode = json.loads((self.data / 'reference.json').read_text())['mode']
            except (OSError, ValueError, KeyError):
                pass

    def safe_audio(self, relative):
        target = (self.data / relative).resolve()
        if not target.is_relative_to(self.data.resolve()) or target.suffix != '.wav':
            raise ValueError('Некорректный путь аудио')
        return target

    def snapshot(self):
        with self.lock:
            return {**self.status, 'phrases': list(self.manifest), 'reference_mode': self.reference_mode}

    def set(self, **values):
        with self.lock:
            self.status.update(values)

    def start(self):
        threading.Thread(target=self.start_assets, daemon=True).start()

    def start_assets(self):
        try:
            self.set(assets='Загружаю ресурсы камеры…')
            from download_assets import ensure_assets
            ensure_assets()
            self.set(assets='Готово')
        except Exception:
            self.set(assets='Ошибка загрузки. Проверьте интернет и перезапустите приложение.')

    def avatar(self, value=None):
        path = self.data / 'avatar.json'
        with self.lock:
            if value is None:
                try:
                    return json.loads(path.read_text())
                except (OSError, ValueError):
                    return None
            if not isinstance(value, dict):
                raise ValueError('Некорректные данные лица')
            views = value.get('views')
            legacy = views is None
            if legacy:
                views = [{'landmarks': value.get('landmarks'), 'photo': value.get('photo'), 'yaw': 0}]
            if not isinstance(views, list) or len(views) not in (1, 3):
                raise ValueError('Нужно сохранить один или три ракурса головы')
            saved_views, total = [], 0
            for view in views:
                if not isinstance(view, dict):
                    raise ValueError('Некорректный ракурс головы')
                points, photo = view.get('landmarks'), view.get('photo')
                if not isinstance(points, list) or not 468 <= len(points) <= 478:
                    raise ValueError('Некорректная сетка лица')
                if not all(isinstance(p, dict) and all(isinstance(p.get(k), (float, int)) and math.isfinite(p[k]) and abs(p[k]) < 5 for k in ('x','y','z')) for p in points):
                    raise ValueError('Некорректные точки лица')
                if not isinstance(photo, str) or not photo.startswith(('data:image/png;base64,', 'data:image/jpeg;base64,')) or len(photo) > 3_000_000:
                    raise ValueError('Некорректная фотография')
                total += len(photo)
                try:
                    raw = base64.b64decode(photo.split(',', 1)[1], validate=True)
                    if not (raw.startswith(b'\x89PNG\r\n\x1a\n') or raw.startswith(b'\xff\xd8\xff')):
                        raise ValueError()
                except ValueError:
                    raise ValueError('Некорректная фотография') from None
                yaw = view.get('yaw', 0)
                if not isinstance(yaw, (float, int)) or not math.isfinite(yaw) or abs(yaw) > 2:
                    raise ValueError('Некорректный угол головы')
                saved_view={'landmarks': points, 'photo': photo, 'yaw': yaw}
                if value.get('version') == 3:
                    if view.get('role') not in ('front','side'):
                        raise ValueError('Не указан тип ракурса.')
                    saved_view['role']=view['role']
                saved_views.append(saved_view)
            if total > 6_000_000:
                raise ValueError('Фотографии головы слишком большие')
            if value.get('version') == 3 and sum(v['role']=='front' for v in saved_views)!=1:
                raise ValueError('Нужен ровно один фронтальный снимок.')
            saved = ({'landmarks': saved_views[0]['landmarks'], 'photo': saved_views[0]['photo']}
                     if legacy else {'version': 3 if value.get('version')==3 else 2, 'views': saved_views})
            atomic_json(path, saved)
            return {'ok': True}

    def reference(self, payload, mode='clone'):
        if mode not in ('clone', 'direct'):
            raise ValueError('Неизвестный режим голоса')
        with self.lock:
            if self.status['voice'] in BUSY or self.reply_busy:
                raise ValueError('Сначала остановите создание голоса.')
            clean, info = prepare_reference(payload, direct=mode == 'direct')
            temporary = self.data / 'reference.tmp'
            temporary.write_bytes(clean)
            temporary.replace(self.data / 'reference.wav')
            atomic_json(self.data / 'reference.json', {'mode': mode})
            self.reference_mode = mode
            self.status.update(reference=True, voice='recorded', error='', progress='Запись проверена. Прослушайте и сохраните голос.')
            return info

    def generate(self):
        with self.lock:
            if self.stop.is_set():
                raise ValueError('Приложение закрывается.')
            if self.status['voice'] in BUSY or self.reply_busy:
                raise ValueError('Создание голоса уже идёт.')
            if not self.status['reference']:
                raise ValueError('Сначала запишите и прослушайте голос.')
            self.cancel.clear()
            self.status.update(voice='generating', error='', progress='Подготовка голоса…')
            self.worker = threading.Thread(target=self._generate, daemon=True)
            self.worker.start()

    def cancel_generation(self):
        with self.lock:
            if self.status['voice'] in BUSY:
                self.cancel.set()
                self.status.update(voice='cancelling', progress='Останавливаю создание голоса…')

    def _synthesize(self, bank):
        if self.cancel.is_set() or self.stop.is_set():
            raise InterruptedError('Создание голоса отменено')
        self.set(tts='Создание голоса · модель работает временно', progress='Загружаю модель голоса…')
        with (bank / 'worker.log').open('wb') as log:
            process = subprocess.Popen([sys.executable, str(ROOT / 'voice_worker.py'),
                                        str(self.data / 'reference.wav'), str(bank)],
                                       cwd=ROOT, stdout=log, stderr=log)
            self.process = process
            deadline = time.monotonic() + 600
            try:
                while process.poll() is None:
                    if self.cancel.wait(.2) or self.stop.is_set():
                        raise InterruptedError('Создание голоса отменено')
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Создание голоса заняло больше 10 минут. Попробуйте режим «Моя запись».')
                    try:
                        self.set(progress=json.loads((bank / 'progress.json').read_text())['progress'])
                    except (OSError, ValueError, KeyError):
                        pass
                if process.returncode:
                    error = bank / 'error.txt'
                    raise RuntimeError(error.read_text()[:600] if error.exists() else 'Модель не смогла создать голос. Попробуйте режим «Моя запись».')
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)
                self.process = None
                self.set(tts='Не загружена · память модели освобождена')

    def _generate(self):
        bank = self.data / ('bank-' + uuid.uuid4().hex)
        bank.mkdir()
        try:
            if self.reference_mode == 'direct':
                shutil.copyfile(self.data / 'reference.wav', bank / 'phrase-0.wav')
                texts = ['Напоминание голосом родителя']
            else:
                self._synthesize(bank)
                texts = PHRASES
            manifest = []
            from scipy.io import wavfile
            import numpy as np
            for i, phrase in enumerate(texts):
                filename = bank / f'phrase-{i}.wav'
                rate, audio = wavfile.read(filename)
                if len(audio) < rate * .3 or not np.any(audio) or not np.isfinite(audio).all():
                    raise RuntimeError('Получилось пустое аудио. Повторите создание голоса.')
                manifest.append({'text': phrase, 'file': f'{bank.name}/{filename.name}'})
            with self.lock:
                if self.cancel.is_set() or self.stop.is_set():
                    raise InterruptedError('Создание голоса отменено')
                atomic_json(self.data / 'manifest.json', manifest)
                self.manifest = manifest
                self.status.update(voice='ready', progress='Голос сохранён. Прослушайте результат.', error='')
        except Exception as exc:
            shutil.rmtree(bank, ignore_errors=True)
            self.set(voice='recorded' if isinstance(exc, InterruptedError) else 'error', error=str(exc), progress='', tts='Не загружена')

    def close(self):
        self.stop.set()
        self.cancel_generation()
        if self.worker:
            self.worker.join(timeout=8)
