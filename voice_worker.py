"""Persistent, bounded XTTS worker with cached speaker conditioning and audio chunks."""
import json
import os
from pathlib import Path
import sys
import hashlib
import time


def load_model():
    import torch
    torch.set_num_threads(max(1,min(4,(os.cpu_count() or 2)//2)))
    from TTS.api import TTS
    from trainer.io import get_user_data_dir
    from runtime import TTS_MODEL
    cache=Path(get_user_data_dir('tts'))/TTS_MODEL.replace('/','--')
    if not (cache/'tos_agreed.txt').exists():
        raise RuntimeError('Установите голосовую модель: python setup_voice.py --install-model')
    return TTS(TTS_MODEL).to('cpu')


def serve(directory):
    from runtime import atomic_json
    import numpy as np
    from scipy.io import wavfile
    from lipsync import timeline
    import re
    import torch
    tts=load_model(); model=tts.synthesizer.tts_model
    device='mps' if os.getenv('PARENTAI_VOICE_DEVICE','auto')!='cpu' and torch.backends.mps.is_available() else 'cpu'
    cached_key=None;conditioning=None
    atomic_json(directory/'ready.json',{'ok':True,'device':device})
    def generate(sentence):
        nonlocal device,conditioning
        emitted=False
        try:
            for tensor in model.inference_stream(sentence,'ru',*conditioning,stream_chunk_size=20,enable_text_splitting=True):
                emitted=True;yield tensor
        except (RuntimeError,NotImplementedError):
            if device!='mps' or emitted:raise
            # Retry before publishing audio, so the answer never repeats midway.
            device='cpu';model.to(device);conditioning=tuple(x.to(device) for x in conditioning)
            atomic_json(directory/'ready.json',{'ok':True,'device':device})
            yield from model.inference_stream(sentence,'ru',*conditioning,stream_chunk_size=20,enable_text_splitting=True)
    last_activity=time.monotonic()
    while True:
        requests=sorted(directory.glob('*.request.json'),key=lambda p:p.stat().st_mtime)
        if not requests:
            if time.monotonic()-last_activity>300: return
            time.sleep(.05);continue
        last_activity=time.monotonic()
        request=requests[0];value=json.loads(request.read_text());request.unlink()
        output=Path(value['output']);output.mkdir(exist_ok=True)
        manifest={'state':'speaking','chunks':[]}
        try:
            reference=Path(value['reference'])
            key=hashlib.sha256(reference.read_bytes()).digest()
            if key!=cached_key:
                # Reference feature extraction stays on CPU; synthesis uses Metal.
                model.to('cpu')
                conditioning=model.get_conditioning_latents(audio_path=[str(reference)])
                try:
                    model.to(device);conditioning=tuple(x.to(device) for x in conditioning)
                except (RuntimeError,NotImplementedError):
                    if device!='mps':raise
                    device='cpu';model.to(device);conditioning=tuple(x.to(device) for x in conditioning)
                    atomic_json(directory/'ready.json',{'ok':True,'device':device})
                cached_key=key
            if not value['text']:
                for _ in generate('Привет.'):pass
                manifest['state']='done';atomic_json(output/'stream.json',manifest);continue
            sentences=re.split(r'(?<=[.!?])\s+',value['text'].strip())
            all_audio=[]
            for sentence in filter(None,sentences):
                elapsed=0
                for tensor in generate(sentence):
                    audio=tensor.detach().cpu().numpy().astype(np.float32).reshape(-1)
                    if not len(audio): continue
                    if not np.isfinite(audio).all(): raise ValueError('Некорректное аудио XTTS.')
                    filename=f'chunk-{len(manifest["chunks"])}.wav'
                    wavfile.write(output/filename,24000,audio)
                    # Approximate grapheme duration for early chunks. Full audio is
                    # aligned again after generation; never restart text per chunk.
                    a=int(elapsed/.075);elapsed+=len(audio)/24000;b=int(elapsed/.075)
                    fragment=sentence[a:b]
                    manifest['chunks'].append({'file':filename,'cues':timeline(output/filename,fragment)})
                    atomic_json(output/'stream.json',manifest)
                    all_audio.append(audio)
            if not all_audio: raise ValueError('XTTS создал пустой ответ.')
            wavfile.write(output/'phrase-0.wav',24000,np.concatenate(all_audio))
            manifest['state']='done';atomic_json(output/'stream.json',manifest)
            last_activity=time.monotonic()
        except Exception:
            manifest.update(state='error',error='XTTS не смог озвучить ответ. Попробуйте ещё раз.')
            atomic_json(output/'stream.json',manifest)


def synthesize(reference, bank, reply=None):
    import torch
    torch.set_num_threads(max(1, min(4, (os.cpu_count() or 2) // 2)))
    from TTS.api import TTS
    from trainer.io import get_user_data_dir
    from runtime import PHRASES, TTS_MODEL
    cache = Path(get_user_data_dir('tts')) / TTS_MODEL.replace('/', '--')
    if not (cache / 'tos_agreed.txt').exists() and os.environ.get('COQUI_TOS_AGREED') != '1':
        raise RuntimeError('Установите голосовую модель: python setup_voice.py --install-model')
    tts = TTS(TTS_MODEL).to('cpu')
    texts = [reply] if reply is not None else PHRASES
    for i, text in enumerate(texts):
        progress = bank / 'progress.tmp'
        progress.write_text(json.dumps({'progress': f'Создаю фразу {i + 1} из {len(texts)}'}))
        progress.replace(bank / 'progress.json')
        tts.tts_to_file(text=text, speaker_wav=str(reference), language='ru',
                        file_path=str(bank / f'phrase-{i}.wav'), split_sentences=True)


if __name__ == '__main__':
    if sys.argv[1]=='--serve':
        directory=Path(sys.argv[2])
        try: serve(directory)
        except Exception:
            from runtime import atomic_json
            atomic_json(directory/'fatal.json',{'error':'XTTS не запустился'})
            raise
        sys.exit(0)
    bank = Path(sys.argv[2])
    try:
        reply = Path(sys.argv[3]).read_text(encoding='utf-8') if len(sys.argv) > 3 else None
        synthesize(Path(sys.argv[1]), bank, reply)
    except Exception as exc:
        (bank / 'error.txt').write_text(str(exc))
        raise
