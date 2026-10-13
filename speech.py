"""SpeechKit STT bridge. Audio is held in memory and never written to the profile."""
import io
import base64
import binascii
import json
import math
import importlib.util
import threading
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

STT_ENDPOINT = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize'
TTS_ENDPOINT = 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis'
RETRYABLE_SPEECHKIT_CODES = frozenset((408, 500, 501, 502, 503, 504))
LOCAL_STT_MODEL = 'openai/whisper-small'


def _json_stream(payload):
    """Decode one or more JSON values returned by the streaming REST endpoint."""
    text = payload.decode('utf-8')
    decoder, position, values = json.JSONDecoder(), 0, []
    while position < len(text):
        while position < len(text) and text[position].isspace():
            position += 1
        if position >= len(text):
            break
        value, position = decoder.raw_decode(text, position)
        values.extend(value if isinstance(value, list) else [value])
    return values


def inspect_wav(payload):
    try:
        with wave.open(io.BytesIO(payload), 'rb') as audio:
            rate, channels, width, frames = audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getnframes()
            if channels != 1 or width != 2 or not 8000 <= rate <= 96000 or not .25 <= frames/rate <= 29:
                raise ValueError('Вопрос должен быть моно PCM16 WAV длительностью до 29 секунд.')
            raw = audio.readframes(frames)
            if len(raw) != frames*2:
                raise ValueError('Запись вопроса неполная.')
    except (wave.Error, EOFError):
        raise ValueError('Некорректная запись вопроса.') from None
    return rate, frames, raw


def audio_duration_ms(payload):
    rate, frames, _ = inspect_wav(payload)
    return math.ceil(frames * 1000 / rate)


def stt_pcm(payload):
    rate, frames, raw = inspect_wav(payload)
    samples = np.frombuffer(raw, dtype='<i2').astype(np.float32)/32768
    if np.sqrt(np.mean(samples*samples)) < .002:
        raise ValueError('Не слышно речи. Подойдите ближе к микрофону.')
    divisor = math.gcd(rate, 16000)
    samples = resample_poly(samples, 16000//divisor, rate//divisor)
    return (np.clip(samples, -1, 1)*32767).astype('<i2').tobytes()


class LocalSpeechRecognizer:
    """Private, zero-provider-cost Russian STT using a local Whisper model."""
    def __init__(self, model=LOCAL_STT_MODEL, cache_dir=None, pipeline_factory=None):
        self.model = model
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.pipeline_factory = pipeline_factory
        self.pipeline = None
        self.lock = threading.RLock()

    def public_status(self):
        dependencies = (importlib.util.find_spec('torch') is not None and
                        importlib.util.find_spec('transformers') is not None)
        available = bool(self.pipeline_factory or self.pipeline) or (
            dependencies and self._model_is_cached())
        return {'enabled': available, 'provider': 'Локальный Whisper',
                'model': self.model, 'local': True, 'external_cost': 0,
                'message': ('готов' if available else
                            'локальная модель не установлена; доступен резервный SpeechKit')}

    def _model_is_cached(self):
        if not self.cache_dir:
            return True
        return self._local_model_path() is not None

    def _local_model_path(self):
        if not self.cache_dir:
            return None
        model_root = self.cache_dir / ('models--' + self.model.replace('/', '--')) / 'snapshots'
        try:
            snapshots = sorted(
                (snapshot for snapshot in model_root.iterdir()
                 if snapshot.is_dir()
                 and (snapshot / 'config.json').is_file()
                 and (snapshot / 'preprocessor_config.json').is_file()
                 and any(snapshot.glob('model*.safetensors'))),
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            )
            return snapshots[0] if snapshots else None
        except OSError:
            return None

    def _pipeline(self):
        with self.lock:
            if self.pipeline is not None:
                return self.pipeline
            try:
                if self.pipeline_factory:
                    self.pipeline = self.pipeline_factory()
                else:
                    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
                    if self.cache_dir:
                        self.cache_dir.mkdir(parents=True, exist_ok=True)
                    source = self._local_model_path() if self.cache_dir else self.model
                    if self.cache_dir and source is None:
                        raise FileNotFoundError('Whisper model snapshot is incomplete')
                    # Passing the resolved snapshot directory is important:
                    # some transformers versions probe optional processor files
                    # online even with local_files_only=True when given a model ID.
                    local = {'local_files_only': True}
                    processor = AutoProcessor.from_pretrained(str(source), **local)
                    model = AutoModelForSpeechSeq2Seq.from_pretrained(str(source), **local)
                    self.pipeline = pipeline(
                        'automatic-speech-recognition', model=model, device='cpu',
                        tokenizer=processor.tokenizer, feature_extractor=processor.feature_extractor)
            except Exception as exc:
                raise ValueError('Локальная модель распознавания не загрузилась. Проверьте установку Whisper.') from exc
            return self.pipeline

    def recognize(self, payload):
        pcm = stt_pcm(payload)
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
        try:
            result = self._pipeline()(
                {'array': samples, 'sampling_rate': 16000},
                generate_kwargs={'language': 'ru', 'task': 'transcribe'})
            text = result.get('text', '').strip()
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError('Локальное распознавание не смогло обработать запись.') from exc
        if not text:
            raise ValueError('Локальный Whisper не разобрал вопрос. Повторите или введите текст.')
        return text


class SpeechRecognizer:
    def __init__(self, key='', opener=None, sleeper=None):
        self.key = key
        self.opener = opener or urllib.request.urlopen
        self.sleeper = sleeper or time.sleep

    def public_status(self):
        return {'enabled': bool(self.key), 'provider': 'Yandex SpeechKit'}

    def recognize(self, payload):
        if not self.key:
            raise ValueError('Для голосовых вопросов добавьте YANDEX_SPEECHKIT_API_KEY в parentai.env.')
        pcm = stt_pcm(payload)
        request = urllib.request.Request(
            STT_ENDPOINT + '?lang=ru-RU&topic=general&format=lpcm&sampleRateHertz=16000&profanityFilter=true',
            data=pcm, headers={'Authorization': f'Api-Key {self.key}', 'Content-Type': 'application/octet-stream'})
        for attempt in range(3):
            try:
                with self.opener(request, timeout=40) as response:
                    result = json.loads(response.read(1_000_000))
                text = result.get('result', '').strip()
                if not text:
                    raise ValueError('SpeechKit не разобрал вопрос. Повторите или введите текст.')
                return text
            except urllib.error.HTTPError as exc:
                # Yandex documents 500/501/503/504 as provider-side transient
                # failures. Retry the same in-memory audio briefly; never retry
                # access, malformed-request, or quota errors automatically.
                if exc.code in RETRYABLE_SPEECHKIT_CODES and attempt < 2:
                    self.sleeper((.4, 1.0)[attempt])
                    continue
                if exc.code == 401:
                    raise ValueError('Ключ SpeechKit недействителен. Проверьте YANDEX_SPEECHKIT_API_KEY.') from None
                if exc.code == 403:
                    raise ValueError('Ключ SpeechKit не имеет доступа. Нужны yc.ai.speechkitStt.execute и роль ai.speechkit-stt.user.') from None
                if exc.code == 400:
                    raise ValueError('SpeechKit отклонил формат записи (код 400).') from None
                if exc.code == 429:
                    raise ValueError('Превышена квота SpeechKit (код 429). Повторите позже или проверьте лимиты Yandex Cloud.') from None
                raise ValueError(f'SpeechKit временно недоступен после 3 попыток (код {exc.code}).') from None
            except (urllib.error.URLError, TimeoutError):
                if attempt < 2:
                    self.sleeper((.4, 1.0)[attempt])
                    continue
                raise ValueError('Не удалось связаться со SpeechKit после 3 попыток.') from None
            except (json.JSONDecodeError, AttributeError):
                raise ValueError('SpeechKit вернул некорректный ответ.') from None


class SpeechSynthesizer:
    """Optional low latency standard voice. No parent recording leaves the machine."""
    def __init__(self,key='',opener=None,sleeper=None):
        self.key=key
        self.opener=opener or urllib.request.urlopen
        self.sleeper=sleeper or time.sleep

    def public_status(self):
        return {'enabled':bool(self.key),'provider':'Yandex SpeechKit','voice':'alena','api_version':'v3'}

    def synthesize(self,text,path):
        if not self.key:raise ValueError('Добавьте YANDEX_TTS_API_KEY для быстрого голоса Яндекса.')
        if not isinstance(text,str) or not text.strip() or len(text)>240:
            raise ValueError('Голосовой ответ должен содержать от 1 до 240 символов.')
        body=json.dumps({
            'text':text,
            'hints':[{'voice':'alena'}],
            'outputAudioSpec':{'containerAudio':{'containerAudioType':'WAV'}},
        },ensure_ascii=False).encode()
        request=urllib.request.Request(TTS_ENDPOINT,data=body,
            headers={'Authorization':f'Api-Key {self.key}','Content-Type':'application/json'})
        for attempt in range(3):
            try:
                with self.opener(request,timeout=25) as response:raw=response.read(8_000_001)
                break
            except urllib.error.HTTPError as exc:
                if exc.code in RETRYABLE_SPEECHKIT_CODES and attempt < 2:
                    self.sleeper((.4, 1.0)[attempt])
                    continue
                if exc.code in (401,403):raise ValueError('Быстрый голос недоступен: нужны yc.ai.speechkitTts.execute и роль ai.speechkit-tts.user.') from None
                raise ValueError(f'SpeechKit временно недоступен после 3 попыток (код {exc.code}).') from None
            except (urllib.error.URLError,TimeoutError):
                if attempt < 2:
                    self.sleeper((.4, 1.0)[attempt])
                    continue
                raise ValueError('Не удалось получить голос SpeechKit после 3 попыток.') from None
        if not raw or len(raw)>8_000_000:raise ValueError('SpeechKit вернул некорректное аудио.')
        try:
            envelopes=_json_stream(raw)
            chunks=[]
            for envelope in envelopes:
                value=envelope.get('result',envelope) if isinstance(envelope,dict) else {}
                data=value.get('audioChunk',{}).get('data')
                if data:chunks.append(base64.b64decode(data,validate=True))
            wav=b''.join(chunks)
            with wave.open(io.BytesIO(wav),'rb') as audio:
                if audio.getnchannels()!=1 or audio.getsampwidth()!=2 or audio.getnframes()<1:
                    raise ValueError()
                duration_ms=math.ceil(audio.getnframes()*1000/audio.getframerate())
        except (json.JSONDecodeError,KeyError,TypeError,ValueError,wave.Error,binascii.Error):
            raise ValueError('SpeechKit вернул некорректное аудио.') from None
        Path(path).write_bytes(wav)
        return {'blocks':math.ceil(len(text)/250),'characters':len(text),'duration_ms':duration_ms}
