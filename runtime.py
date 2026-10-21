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
from portrait import validate_anchors

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
PHRASES = [
    'Давай вернёмся к заданию. У тебя получится.',
    'Я рядом. Продолжим заниматься?',
    'Вернись, пожалуйста, в кадр, чтобы я видел, что ты рядом.',
    'Ты уже давно отошёл. Возвращайся, пожалуйста, продолжим занятие вместе.',
]
PHRASE_PURPOSES = ['lesson', 'lesson', 'camera', 'away']
TTS_MODEL = 'tts_models/multilingual/multi-dataset/xtts_v2'
BUSY = ('generating', 'cancelling')


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


class Runtime:
    def __init__(self, data=DATA, voice_engine=None):
        self.data = Path(data)
        self.data.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.stop = threading.Event()
        self.process = None
        self.worker = None
        self.reply_busy = False
        # PRODUCT INVARIANT: Adym speaks in the parent's recorded/cloned
        # voice by default. A generic provider voice makes the avatar feel like
        # an unrelated assistant and defeats the core promise of the product.
        # Deployments that cannot use XTTS under their chosen licence must opt
        # out explicitly with PARENTAI_ENABLE_XTTS=0; never silently make a
        # third-party voice the default.
        configured_provider = os.getenv('PARENTAI_VOICE_PROVIDER', '').strip().lower()
        legacy_xtts = os.getenv('PARENTAI_ENABLE_XTTS', '1').strip().lower() not in ('0','false','no')
        self.voice_provider = configured_provider or ('xtts' if legacy_xtts else 'none')
        self.voice_clone_enabled = self.voice_provider in ('xtts', 'qwen')
        # Kept in the status payload for older clients; it now means that a
        # cloning provider is available, not specifically XTTS.
        self.xtts_enabled = self.voice_clone_enabled
        from voice_engine import VoiceEngine
        self._owns_voice_engine = voice_engine is None
        self.voice_engine=voice_engine or VoiceEngine()
        self.reference_mode = 'clone' if self.voice_clone_enabled else 'direct'
        self.reference_takes = []
        self.status = {'tts': 'Не загружена', 'assets': 'Ожидание загрузки', 'voice': 'idle',
                       'progress': '', 'error': '', 'reference': False,
                       'reference_count': 0, 'reference_takes': []}
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
        try:
            reference_settings = json.loads((self.data / 'reference.json').read_text())
            saved_mode = reference_settings['mode']
            self.reference_mode = saved_mode if saved_mode == 'direct' or self.voice_clone_enabled else 'direct'
        except (OSError, ValueError, KeyError, TypeError):
            reference_settings = {}
        saved_takes = reference_settings.get('takes') if isinstance(reference_settings, dict) else None
        if self.reference_mode == 'clone' and isinstance(saved_takes, list):
            self.reference_takes = [take for take in saved_takes
                                    if take in (1, 2, 3) and self.reference_path(take).is_file()]
        elif self.reference_path().is_file():
            self.reference_takes = [1]
        if self.reference_takes:
            self.status['reference'] = True
            self.status.update(reference_count=len(self.reference_takes),
                               reference_takes=list(self.reference_takes))

    def safe_audio(self, relative):
        target = (self.data / relative).resolve()
        if not target.is_relative_to(self.data.resolve()) or target.suffix != '.wav':
            raise ValueError('Некорректный путь аудио')
        return target

    def reference_path(self, take=1):
        return self.data / ('reference.wav' if take == 1 else f'reference-{take}.wav')

    def reference_paths(self):
        """Active cloning samples, preserving one-file profiles from older releases."""
        takes = self.reference_takes if self.reference_mode == 'clone' else [1]
        if not takes and self.reference_path().is_file():
            takes = [1]
        paths = [self.reference_path(take) for take in takes]
        return [path for path in paths if path.is_file()]

    def snapshot(self):
        with self.lock:
            return {**self.status, 'phrases': list(self.manifest), 'reference_mode': self.reference_mode,
                    'xtts_enabled': self.voice_clone_enabled,
                    'voice_clone_enabled': self.voice_clone_enabled,
                    'voice_provider': self.voice_provider}

    def set(self, **values):
        with self.lock:
            self.status.update(values)

    def start(self):
        if self.voice_clone_enabled and self.reference_mode=="clone" and self.status["reference"]:
            self.voice_engine.warm(self.reference_paths())
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
            version=value.get('version')
            if not isinstance(views, list) or len(views) not in ((1,3,6) if version==7 else (1,3)):
                raise ValueError('Некорректное число ракурсов головы')
            portrait=value.get('portrait')
            if version in (4,5):
                if not isinstance(portrait,dict) or len(views)!=(1 if version==5 else 3):
                    raise ValueError('Для модели с плечами нужен дополнительный снимок по грудь.')
                views=views+[portrait]
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
                if version in (3,4,5,7):
                    allowed=('front','left','right','left_outer','right_outer','portrait') if version==7 else (('front','portrait') if version==5 else ('front','side','portrait') if version==4 else ('front','side'))
                    if view.get('role') not in allowed:
                        raise ValueError('Не указан тип ракурса.')
                    saved_view['role']=view['role']
                saved_views.append(saved_view)
            if total > (9_000_000 if version==7 else 8_000_000 if version==4 else 6_000_000):
                raise ValueError('Фотографии головы слишком большие')
            if version in (3,4,5,7) and sum(v['role']=='front' for v in saved_views)!=1:
                raise ValueError('Нужен ровно один фронтальный снимок.')
            saved = ({'landmarks': saved_views[0]['landmarks'], 'photo': saved_views[0]['photo']}
                     if legacy else {'version': 3 if value.get('version') in (3,4) else 2, 'views': saved_views[:3]})
            if value.get('version')==4:
                if [v['role'] for v in saved_views]!=['front','side','side','portrait']:
                    raise ValueError('Некорректная последовательность снимков.')
                saved.update(version=4,portrait=saved_views[3])
            if version==5:
                if [v['role'] for v in saved_views]!=['front','portrait']:
                    raise ValueError('Нужны фронтальный снимок и портрет по грудь.')
                if any(abs(v['yaw'])>.08 for v in saved_views):
                    raise ValueError('Снимки должны быть сделаны прямо в камеру.')
                anchors=validate_anchors(value.get('anchors'),saved_views[1]['landmarks'])
                saved=dict(version=5,views=[saved_views[0]],portrait=saved_views[1],anchors=anchors)
            if version==7:
                if [v['role'] for v in saved_views] != ['front','left','right','left_outer','right_outer','portrait']:
                    raise ValueError('Некорректная последовательность локального сканирования.')
                ranges={'front':(-.09,.09),'left':(.055,.40),'right':(-.40,-.055),'left_outer':(.18,.75),'right_outer':(-.75,-.18),'portrait':(-.09,.09)}
                if any(not ranges[v['role']][0] <= v['yaw'] <= ranges[v['role']][1] for v in saved_views):
                    raise ValueError('Некорректные углы локального сканирования.')
                anchors=validate_anchors(value.get('anchors'),saved_views[-1]['landmarks'])
                saved={'version':7,'engine':'mediapipe-local','views':saved_views,'anchors':anchors}
                analysis=value.get('portraitAnalysis')
                if analysis is not None:
                    if not isinstance(analysis,dict):
                        raise ValueError('Некорректный сохранённый анализ портрета.')
                    clean={}
                    for name,field in (('segmentation','data'),('matte','alpha')):
                        plane=analysis.get(name)
                        if not isinstance(plane,dict):
                            raise ValueError('Некорректный сохранённый анализ портрета.')
                        width,height,encoded=plane.get('width'),plane.get('height'),plane.get(field)
                        if (not isinstance(width,int) or not isinstance(height,int) or width<1 or height<1
                                or width*height>2_100_000 or not isinstance(encoded,str) or len(encoded)>3_000_004):
                            raise ValueError('Некорректный сохранённый анализ портрета.')
                        try: raw=base64.b64decode(encoded,validate=True)
                        except (ValueError,TypeError): raise ValueError('Некорректный сохранённый анализ портрета.') from None
                        if len(raw)!=width*height:
                            raise ValueError('Некорректный сохранённый анализ портрета.')
                        clean[name]={'width':width,'height':height,field:encoded}
                    saved['portraitAnalysis']=clean
            atomic_json(path, saved)
            return {'ok': True}

    def reference(self, payload, mode='clone', take=1):
        if mode not in ('clone', 'direct'):
            raise ValueError('Неизвестный режим голоса')
        try:
            take = int(take)
        except (TypeError, ValueError):
            raise ValueError('Неизвестный образец голоса') from None
        if take not in ((1,) if mode == 'direct' else (1, 2, 3)):
            raise ValueError('Неизвестный образец голоса')
        if mode == 'clone' and not self.voice_clone_enabled:
            raise ValueError('Клонирование голоса сейчас выключено: лицензия XTTS-v2 не подходит, а Qwen не настроен. Выберите точную запись без клонирования.')
        with self.lock:
            if self.status['voice'] in BUSY or self.reply_busy:
                raise ValueError('Сначала остановите создание голоса.')
            clean, info = prepare_reference(
                payload, direct=mode == 'direct',
                min_speech_seconds=None if mode == 'direct' else 7)
            target = self.reference_path(take)
            temporary = target.with_suffix('.tmp')
            temporary.write_bytes(clean)
            temporary.replace(target)
            active = set(self.reference_takes) if self.reference_mode == mode == 'clone' else set()
            active.add(take)
            self.reference_takes = sorted(active) if mode == 'clone' else [1]
            atomic_json(self.data / 'reference.json', {'mode': mode, 'takes': self.reference_takes})
            self.reference_mode = mode
            self.status.update(
                reference=True, reference_count=len(self.reference_takes),
                reference_takes=list(self.reference_takes), voice='recorded', error='',
                progress=(f'Образец {take} из 3 проверен. Запишите остальные для максимального сходства.'
                          if mode == 'clone' and len(self.reference_takes) < 3
                          else 'Все три образца готовы. Прослушайте их и создайте голос.'
                          if mode == 'clone' else
                          'Запись проверена. Прослушайте и сохраните напоминание.'))
            return info

    def generate(self):
        with self.lock:
            if self.stop.is_set():
                raise ValueError('Приложение закрывается.')
            if self.status['voice'] in BUSY or self.reply_busy:
                raise ValueError('Создание голоса уже идёт.')
            if not self.status['reference']:
                raise ValueError('Сначала запишите и прослушайте голос.')
            if self.reference_mode == 'clone' and not self.voice_clone_enabled:
                raise ValueError('Клонирование голоса выключено из-за лицензии XTTS-v2; Qwen не настроен.')
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
        if self.voice_provider == 'qwen':
            # Exact recordings are both instant and more natural for recurring
            # presence reminders. Qwen is reserved for genuinely new replies.
            references = self.reference_paths()
            if len(references) < 3:
                raise ValueError('Для Qwen запишите все три образца голоса.')
            for index, source_index in enumerate((0, 1, 2, 2)):
                shutil.copyfile(references[source_index], bank / f'phrase-{index}.wav')
            self.set(tts='Qwen будет озвучивать новые ответы в общей очереди',
                     progress='Записи готовы. Новые ответы могут создаваться несколько минут.')
            return
        self.set(tts='Модель прогревается для быстрых ответов',progress='Загружаю модель голоса…')
        styles = ('firm', 'supportive', 'firm', 'firm')
        for i,text in enumerate(PHRASES):
            self.set(progress=f'Создаю фразу {i+1} из {len(PHRASES)}')
            folder=bank/f'part-{i}';folder.mkdir()
            self.voice_engine.synthesize(
                self.reference_paths(),folder,text,self.cancel,style=styles[i])
            shutil.copyfile(folder/'phrase-0.wav',bank/f'phrase-{i}.wav')
            shutil.rmtree(folder)
        self.set(tts='Голос прогрет · память освобождается после занятия или 5 минут простоя')

    def _generate(self):
        bank = self.data / ('bank-' + uuid.uuid4().hex)
        bank.mkdir()
        try:
            if self.reference_mode == 'direct':
                shutil.copyfile(self.data / 'reference.wav', bank / 'phrase-0.wav')
                texts = ['Напоминание голосом родителя']
                purposes = ['manual']
            else:
                self._synthesize(bank)
                texts = PHRASES
                purposes = PHRASE_PURPOSES
            manifest = []
            from scipy.io import wavfile
            import numpy as np
            for i, phrase in enumerate(texts):
                filename = bank / f'phrase-{i}.wav'
                rate, audio = wavfile.read(filename)
                if len(audio) < rate * .3 or not np.any(audio) or not np.isfinite(audio).all():
                    raise RuntimeError('Получилось пустое аудио. Повторите создание голоса.')
                manifest.append({'text': phrase, 'file': f'{bank.name}/{filename.name}',
                                 'purpose': purposes[i]})
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
        if self._owns_voice_engine:
            self.voice_engine.close()
