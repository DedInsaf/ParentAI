"""SpeechKit STT bridge. Audio is held in memory and never written to the profile."""
import io
import json
import math
import urllib.error
import urllib.request
import urllib.parse
import wave

import numpy as np
from scipy.signal import resample_poly

STT_ENDPOINT = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize'


def stt_pcm(payload):
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
        return {'enabled':bool(self.key),'provider':'Yandex SpeechKit','voice':'alena'}

    def synthesize(self,text,path):
        if not self.key:raise ValueError('Добавьте YANDEX_TTS_API_KEY для быстрого голоса Яндекса.')
        body=urllib.parse.urlencode({'text':text,'lang':'ru-RU','voice':'alena','format':'lpcm','sampleRateHertz':'16000'}).encode()
        if len(body)>15000:raise ValueError('Ответ слишком длинный для SpeechKit.')
        request=urllib.request.Request('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize',data=body,
            headers={'Authorization':f'Api-Key {self.key}','Content-Type':'application/x-www-form-urlencoded'})
        try:
            with self.opener(request,timeout=25) as response:pcm=response.read(8_000_001)
        except urllib.error.HTTPError as exc:
            if exc.code in (401,403):raise ValueError('Быстрый голос недоступен: нужны yc.ai.speechkitTts.execute и роль ai.speechkit-tts.user.') from None
            raise ValueError(f'SpeechKit временно недоступен (код {exc.code}).') from None
        except (urllib.error.URLError,TimeoutError):raise ValueError('Не удалось получить голос SpeechKit.') from None
        if not pcm or len(pcm)>8_000_000 or len(pcm)%2:raise ValueError('SpeechKit вернул некорректное аудио.')
        with wave.open(str(path),'wb') as audio:
            audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(pcm)
