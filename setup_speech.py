"""Download and verify the private local speech-recognition model."""
import os
from pathlib import Path

from huggingface_hub import snapshot_download

from runtime import DATA, ROOT
from speech import LOCAL_STT_MODEL, LocalSpeechRecognizer
from tutor import load_local_env


def main():
    load_local_env(Path(ROOT) / 'parentai.env')
    model = os.getenv('PARENTAI_STT_MODEL', LOCAL_STT_MODEL)
    cache = DATA / 'models' / 'huggingface'
    print(f'Загружаю локальное распознавание {model}…', flush=True)
    snapshot_download(
        model,
        cache_dir=cache,
        allow_patterns=['*.json', '*.txt', 'model.safetensors'],
        max_workers=1,
    )
    LocalSpeechRecognizer(model, cache)._pipeline()
    print('Локальное распознавание готово. Аудио не будет отправляться в SpeechKit.')


if __name__ == '__main__':
    main()
