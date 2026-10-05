"""Audio-grounded Russian viseme approximation; not a phoneme forced aligner."""
import re
import numpy as np
from scipy.io import wavfile


def viseme(letter):
    if letter in 'бпм': return 'closed'
    if letter in 'оуёю': return 'round'
    if letter in 'иыей': return 'wide'
    if letter in 'фв': return 'teeth'
    if letter in 'аэя': return 'open'
    return 'neutral'


def timeline(path, text):
    rate, audio = wavfile.read(path)
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError('XTTS вернул пустое или повреждённое аудио.')
    if audio.ndim > 1: audio = audio.mean(axis=1)
    audio = audio.astype(np.float32)
    audio /= max(1, float(np.max(np.abs(audio))))
    hop = max(1, int(rate*.04))
    levels = [float(np.sqrt(np.mean(audio[i:i+hop]**2))) for i in range(0,len(audio),hop)]
    active = [i for i,level in enumerate(levels) if level > .035]
    letters = re.findall('[а-яё]', text.lower())
    cues = []
    for i,level in enumerate(levels):
        cues.append({'time': round(i*hop/rate,3), 'open': round(min(1,level*3.5),3), 'shape':'silence' if level <= .035 else 'neutral'})
    # Distribute graphemes over measured speech (exclude pauses), never over the whole WAV.
    if active and letters:
        for ordinal,index in enumerate(active):
            letter = letters[min(len(letters)-1, int(ordinal/len(active)*len(letters)))]
            cues[index]['shape'] = viseme(letter)
    cues.append({'time':round(len(audio)/rate,3),'open':0,'shape':'silence'})
    return cues
