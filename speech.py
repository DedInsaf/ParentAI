"""SpeechKit STT bridge. Audio is held in memory and never written to the profile."""
import io
import base64
import binascii
import json
import math
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

STT_ENDPOINT = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize'
TTS_ENDPOINT = 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis'


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


class SpeechRecognizer:
    def __init__(self, key='', opener=None):
        self.key = key
        self.opener = opener or urllib.request.urlopen

    def public_status(self):
        return {'enabled': bool(self.key), 'provider': 'Yandex SpeechKit'}

    def recognize(self, payload):
        if not self.key:
            raise ValueError('Для голосовых вопросов добавьте YANDEX_SPEECHKIT_API_KEY в parentai.env.')
        pcm = stt_pcm(payload)
        request = urllib.request.Request(
            STT_ENDPOINT + '?lang=ru-RU&topic=general&format=lpcm&sampleRateHertz=16000&profanityFilter=true',
            data=pcm, headers={'Authorization': f'Api-Key {self.key}', 'Content-Type': 'application/octet-stream'})
        try:
            with self.opener(request, timeout=40) as response:
                result = json.loads(response.read(1_000_000))
            text = result.get('result', '').strip()
            if not text:
                raise ValueError('SpeechKit не разобрал вопрос. Повторите или введите текст.')
            return text
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise ValueError('Ключ SpeechKit не имеет доступа. Нужны yc.ai.speechkitStt.execute и роль ai.speechkit-stt.user.') from None
            raise ValueError(f'SpeechKit временно недоступен (код {exc.code}).') from None
        except (urllib.error.URLError, TimeoutError):
            raise ValueError('Не удалось связаться со SpeechKit. Повторите позже.') from None
        except (json.JSONDecodeError, AttributeError):
            raise ValueError('SpeechKit вернул некорректный ответ.') from None


class SpeechSynthesizer:
    """Optional low latency standard voice. No parent recording leaves the machine."""
    def __init__(self,key='',opener=None):
        self.key=key
        self.opener=opener or urllib.request.urlopen

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
        try:
            with self.opener(request,timeout=25) as response:raw=response.read(8_000_001)
        except urllib.error.HTTPError as exc:
            if exc.code in (401,403):raise ValueError('Быстрый голос недоступен: нужны yc.ai.speechkitTts.execute и роль ai.speechkit-tts.user.') from None
            raise ValueError(f'SpeechKit временно недоступен (код {exc.code}).') from None
        except (urllib.error.URLError,TimeoutError):raise ValueError('Не удалось получить голос SpeechKit.') from None
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
