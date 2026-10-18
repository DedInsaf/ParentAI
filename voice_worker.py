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
    # Lower randomness keeps the cloned identity stable between short lesson
    # replies. XTTS' more creative defaults can noticeably change age, pitch
    # and accent from one generation to the next.
    return {
        'temperature': min(.68, float(model_setting(model, 'temperature', .75))),
        'length_penalty': float(model_setting(model, 'length_penalty', 1.0)),
        'repetition_penalty': float(model_setting(model, 'repetition_penalty', 5.0)),
        'top_k': min(45, int(model_setting(model, 'top_k', 50))),
        'top_p': min(.84, float(model_setting(model, 'top_p', .85))),
    }


def reference_tail_embedding(model, reference, seconds=6):
    """Extract identity from the clean end of the strongest recorded take."""
    import numpy as np
    import torch
    from scipy.io import wavfile

    rate, audio = wavfile.read(reference)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if np.issubdtype(audio.dtype, np.integer):
        limit = max(abs(np.iinfo(audio.dtype).min), np.iinfo(audio.dtype).max)
        audio = audio.astype(np.float32) / limit
    else:
        audio = audio.astype(np.float32)
    audio = audio[-int(rate * seconds):]
    if len(audio) < int(rate * 2):
        raise ValueError('Слишком короткий образец голоса.')
    tensor = torch.from_numpy(np.ascontiguousarray(audio))[None]
    return model.get_speaker_embedding(tensor, rate)


def build_style_conditionings(model, references, options):
    """Keep one coherent delivery and the strongest identity take."""
    paths = [str(reference) for reference in references]
    # The user's listening tests favored the complete take over an average of
    # four-second style chunks.  Each take remains available for its intended
    # delivery, while the final firm take anchors identity for every reply.
    style_options = {**options, 'gpt_cond_chunk_len': options['gpt_cond_len']}
    style_latents = [model.get_conditioning_latents(
        audio_path=[path], **style_options)[0] for path in paths]
    speaker = reference_tail_embedding(model, paths[-1]) * 1.24
    return {
        'neutral': (style_latents[0], speaker),
        'supportive': (style_latents[min(1, len(style_latents) - 1)], speaker),
        'firm': (style_latents[-1], speaker),
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
    cached_key=None;conditioning=None;conditionings={};conditioning_style='neutral'
    clone_options=conditioning_options(model)
    generation_options=inference_options(model)
    atomic_json(directory/'ready.json',{'ok':True,'device':device})
    def generate(sentence):
        nonlocal device,conditioning,conditionings
        emitted=False
        # Keep short replies reproducible; random seeds were a major source of
        # audible voice changes between otherwise identical lesson prompts.
        torch.manual_seed(29)
        try:
            for tensor in model.inference_stream(
                sentence,'ru',*conditioning,stream_chunk_size=20,
                enable_text_splitting=True,**generation_options):
                emitted=True;yield tensor
        except (RuntimeError,NotImplementedError):
            if device!='mps' or emitted:raise
            # Retry before publishing audio, so the answer never repeats midway.
            device='cpu';model.to(device)
            conditionings={name:tuple(x.to(device) for x in values)
                           for name,values in conditionings.items()}
            conditioning=conditionings[conditioning_style]
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
            raw_references=value.get('references',value.get('reference'))
            if isinstance(raw_references,str): raw_references=[raw_references]
            references=[Path(path) for path in raw_references or []]
            if not references: raise ValueError('Не найдены образцы голоса.')
            digest=hashlib.sha256()
            for reference in references:
                reference_bytes=reference.read_bytes()
                digest.update(len(reference_bytes).to_bytes(8,'big'))
                digest.update(reference_bytes)
            key=digest.digest()
            if key!=cached_key:
                # Reference feature extraction stays on CPU; synthesis uses Metal.
                model.to('cpu')
                conditionings=build_style_conditionings(model,references,clone_options)
                try:
                    model.to(device)
                    conditionings={name:tuple(x.to(device) for x in values)
                                   for name,values in conditionings.items()}
                except (RuntimeError,NotImplementedError):
                    if device!='mps':raise
                    device='cpu';model.to(device)
                    conditionings={name:tuple(x.to(device) for x in values)
                                   for name,values in conditionings.items()}
                    atomic_json(directory/'ready.json',{'ok':True,'device':device})
                cached_key=key
            conditioning_style=value.get('style','neutral')
            if conditioning_style not in conditionings: conditioning_style='neutral'
            conditioning=conditionings[conditioning_style]
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
        references=list(reference) if isinstance(reference,(list,tuple)) else [reference]
        tts.tts_to_file(text=text, speaker_wav=[str(path) for path in references], language='ru',
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
