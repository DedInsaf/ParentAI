"""Persistent, bounded XTTS worker with cached speaker conditioning and audio chunks."""
import json
import os
from pathlib import Path
import sys
import hashlib
import time


def model_setting(model, name, default):
    """Read an XTTS setting without depending on a particular config wrapper."""
    config = getattr(model, 'config', None)
    if config is None:
        return default
    if isinstance(config, dict):
        return config.get(name, default)
    return getattr(config, name, default)


def conditioning_options(model):
    """Use the complete reference instead of XTTS' low-level six-second default."""
    maximum = max(6, min(30, int(model_setting(model, 'max_ref_len', 30))))
    length = max(6, min(maximum, int(model_setting(model, 'gpt_cond_len', maximum))))
    chunk = max(2, min(length, int(model_setting(model, 'gpt_cond_chunk_len', 4))))
    return {
        'max_ref_length': maximum,
        'gpt_cond_len': length,
        'gpt_cond_chunk_len': chunk,
        'sound_norm_refs': bool(model_setting(model, 'sound_norm_refs', False)),
    }


def inference_options(model):
    return {
        'temperature': float(model_setting(model, 'temperature', .75)),
        'length_penalty': float(model_setting(model, 'length_penalty', 1.0)),
        'repetition_penalty': float(model_setting(model, 'repetition_penalty', 5.0)),
        'top_k': int(model_setting(model, 'top_k', 50)),
        'top_p': float(model_setting(model, 'top_p', .85)),
    }


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
    clone_options=conditioning_options(model)
    generation_options=inference_options(model)
    atomic_json(directory/'ready.json',{'ok':True,'device':device})
    def generate(sentence):
        nonlocal device,conditioning
        emitted=False
        try:
            for tensor in model.inference_stream(
                sentence,'ru',*conditioning,stream_chunk_size=20,
                enable_text_splitting=True,**generation_options):
                emitted=True;yield tensor
        except (RuntimeError,NotImplementedError):
            if device!='mps' or emitted:raise
            # Retry before publishing audio, so the answer never repeats midway.
            device='cpu';model.to(device);conditioning=tuple(x.to(device) for x in conditioning)
            atomic_json(directory/'ready.json',{'ok':True,'device':device})
            yield from model.inference_stream(
                sentence,'ru',*conditioning,stream_chunk_size=20,
                enable_text_splitting=True,**generation_options)
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
                # The low-level XTTS method otherwise considers only the first
                # six seconds. Averaging short chunks across the complete clean
                # sample preserves substantially more of the parent's timbre
                # and speaking manner.
                conditioning=model.get_conditioning_latents(
                    audio_path=[str(reference)],**clone_options)
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
