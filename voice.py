"""Reference validation and gentle processing; no microphone access on the server."""
import io
import math
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfiltfilt, resample_poly


def prepare_reference(payload: bytes, direct=False):
    try:
        rate, audio = wavfile.read(io.BytesIO(payload))
    except Exception as exc:
        raise ValueError('Не удалось прочитать WAV. Повторите запись.') from exc
    if not 16000 <= rate <= 96000 or audio.ndim != 1 or audio.dtype != np.int16:
        raise ValueError('Нужен моно WAV PCM16, 16–96 кГц.')
    if not (2 if direct else 10) <= len(audio) / rate <= 35:
        raise ValueError('Запишите не менее 2 секунд.' if direct else 'Запишите 20 секунд спокойной речи.')
    x = audio.astype(np.float64) / 32768
    if np.mean(np.abs(x) >= 0.99) > 0.002:
        raise ValueError('Микрофон перегружен. Отодвиньтесь или уменьшите усиление.')
    # Remove DC/rumble only. Spectral denoising over the entire utterance destroys timbre.
    x = sosfiltfilt(butter(2, 65, fs=rate, btype='highpass', output='sos'), x)
    frame = int(rate * .02)
    frames = x[:len(x) // frame * frame].reshape(-1, frame)
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    floor, peak = np.percentile(rms, [15, 95])
    if peak < 0.012:
        raise ValueError('Голос слишком тихий. Поднесите микрофон ближе и повторите.')
    if peak / max(floor, 1e-6) < 2:
        raise ValueError('Слишком ровный шум. Записывайте в тишине, с паузами между фразами.')
    active = np.flatnonzero(rms > max(.008, floor * 2, peak * .12))
    if len(active) * .02 < (0.6 if direct else 4):
        raise ValueError('Слишком мало активной речи. Поднесите микрофон ближе и повторите.')
    start = max(0, int(active[0] * frame - rate * .2))
    end = min(len(x), int((active[-1] + 1) * frame + rate * .2))
    x = x[start:end]
    gain = min(4, .12 / max(float(np.sqrt(np.mean(x ** 2))), 1e-6), .92 / max(np.max(np.abs(x)), 1e-6))
    x *= gain
    gcd = math.gcd(rate, 24000)
    x = resample_poly(x, 24000 // gcd, rate // gcd)
    out = io.BytesIO()
    wavfile.write(out, 24000, (np.clip(x, -.98, .98) * 32767).astype(np.int16))
    return out.getvalue(), {'seconds': round(len(x) / 24000, 1), 'speech_seconds': round(len(active) * .02, 1)}
