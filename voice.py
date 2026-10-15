"""Reference validation and gentle processing; no microphone access on the server."""
import io
import math
import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfiltfilt, resample_poly


def compact_clone_speech(audio, active_frames, frame, rate):
    """Keep natural phrases while removing long pauses that dilute XTTS conditioning."""
    indices = np.flatnonzero(active_frames)
    if not len(indices):
        return audio
    groups = []
    start = previous = int(indices[0])
    active_count = 1
    for index in map(int, indices[1:]):
        # Short pauses carry phrasing; pauses longer than 0.4 s waste the
        # bounded reference window and make the cloned voice less stable.
        if index - previous > 20:
            if active_count >= 5:
                groups.append((start, previous + 1))
            start, active_count = index, 1
        else:
            active_count += 1
        previous = index
    if active_count >= 5:
        groups.append((start, previous + 1))
    if not groups:
        return audio
    padding = int(rate * .08)
    join = np.zeros(int(rate * .07), dtype=audio.dtype)
    pieces = []
    for start_frame, end_frame in groups:
        left = max(0, start_frame * frame - padding)
        right = min(len(audio), end_frame * frame + padding)
        piece = audio[left:right].copy()
        fade = min(int(rate * .008), len(piece) // 4)
        if fade:
            ramp = np.linspace(0, 1, fade, endpoint=False)
            piece[:fade] *= ramp
            piece[-fade:] *= ramp[::-1]
        if pieces:
            pieces.append(join)
        pieces.append(piece)
    return np.concatenate(pieces)


def prepare_reference(payload: bytes, direct=False):
    try:
        rate, audio = wavfile.read(io.BytesIO(payload))
    except Exception as exc:
        raise ValueError('Не удалось прочитать WAV. Повторите запись.') from exc
    if not 16000 <= rate <= 96000 or audio.ndim != 1 or audio.dtype != np.int16:
        raise ValueError('Нужен моно WAV PCM16, 16–96 кГц.')
    if not (2 if direct else 10) <= len(audio) / rate <= 35:
        raise ValueError('Запишите не менее 2 секунд.' if direct else 'Запишите полный 30-секундный образец спокойной речи.')
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
    active_frames = rms > max(.008, floor * 2, peak * .12)
    active = np.flatnonzero(active_frames)
    speech_seconds = len(active) * .02
    if speech_seconds < (0.6 if direct else 12):
        raise ValueError('Слишком мало активной речи. Для создания голоса спокойно читайте весь текст без длинных пауз.' if not direct else 'Слишком мало активной речи. Поднесите микрофон ближе и повторите.')
    start = max(0, int(active[0] * frame - rate * .2))
    end = min(len(x), int((active[-1] + 1) * frame + rate * .2))
    x = x[start:end]
    if not direct:
        first_frame = max(0, active[0] - 10)
        last_frame = min(len(active_frames), active[-1] + 11)
        x = compact_clone_speech(
            x, active_frames[first_frame:last_frame], frame, rate)
    gain = min(4, .12 / max(float(np.sqrt(np.mean(x ** 2))), 1e-6), .92 / max(np.max(np.abs(x)), 1e-6))
    x *= gain
    gcd = math.gcd(rate, 24000)
    x = resample_poly(x, 24000 // gcd, rate // gcd)
    out = io.BytesIO()
    wavfile.write(out, 24000, (np.clip(x, -.98, .98) * 32767).astype(np.int16))
    return out.getvalue(), {
        'seconds': round(len(x) / 24000, 1),
        'speech_seconds': round(speech_seconds, 1),
    }
