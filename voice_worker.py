"""Disposable XTTS process: all model memory is released when this process exits."""
import json
import os
from pathlib import Path
import sys


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
    bank = Path(sys.argv[2])
    try:
        reply = Path(sys.argv[3]).read_text(encoding='utf-8') if len(sys.argv) > 3 else None
        synthesize(Path(sys.argv[1]), bank, reply)
    except Exception as exc:
        (bank / 'error.txt').write_text(str(exc))
        raise
