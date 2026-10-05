"""
Единоразовая настройка: запись голоса родителя -> очистка от шума ->
генерация банка фраз (LLM + клонирование голоса).

Всё, что тут происходит, происходит ОДИН РАЗ, оффлайн, до того как
ребёнок сядет за уроки. Во время самого мониторинга (avatar.html)
никакой генерации уже не требуется — только воспроизведение готовых
файлов, поэтому реакция мгновенная.

Запуск:
    pip install noisereduce
    python setup_voice.py
"""

import os
import json
import time
import numpy as np
import sounddevice as sd
from scipy.io import wavfile
import noisereduce as nr
import ollama

SAMPLE_RATE = 44100
RECORD_SECONDS = 15          # чем длиннее образец — тем стабильнее клонирование
PHRASE_BANK_SIZE = 10
OUTPUT_DIR = "web"
PHRASES_DIR = os.path.join(OUTPUT_DIR, "phrases")
REFERENCE_WAV = os.path.join(OUTPUT_DIR, "parent_reference_clean.wav")

FALLBACK_PHRASES = [
    "Немедленно вернись на свое место!",
    "Хватит бездельничать, за уроки!",
    "Я жду тебя за столом. Живо!",
    "Возвращайся, время не ждёт!",
    "Так, кто разрешил вставать?",
    "Быстро назад, домашка сама не сделается!",
    "Считаю до трёх. Возвращайся!",
    "Я всё вижу — быстро за парту!",
    "А ну быстро назад за стол!",
    "Хватит гулять, садись заниматься!",
]


def record_reference_voice() -> np.ndarray:
    input(f"\nНажми Enter и говори {RECORD_SECONDS} секунд "
          f"(в тишине, обычным голосом, как будто зовёшь ребёнка)...")
    print("[REC] Идёт запись...")
    audio = sd.rec(int(RECORD_SECONDS * SAMPLE_RATE),
                    samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    sd.wait()
    print("[REC] Готово.")
    return audio.flatten()


def denoise(audio: np.ndarray) -> np.ndarray:
    """Убирает фоновый шум/гул/шипение микрофона одним проходом.
    stationary=True хорошо чистит постоянный фон (вентилятор, гул компа);
    если помеха непостоянная (шаги, дверь), можно попробовать
    stationary=False — просто поменяй флаг ниже и перезапусти."""
    print("[CLEAN] Убираю шум...")
    cleaned = nr.reduce_noise(y=audio, sr=SAMPLE_RATE, stationary=True)
    # лёгкая нормализация громкости
    peak = np.max(np.abs(cleaned)) or 1.0
    cleaned = cleaned / peak * 0.95
    return cleaned


def save_wav_float(path: str, audio: np.ndarray):
    int16_audio = np.int16(np.clip(audio, -1.0, 1.0) * 32767)
    wavfile.write(path, SAMPLE_RATE, int16_audio)


def generate_phrase_texts() -> list[str]:
    print("[AI] Прошу Ollama придумать фразы...")
    system_prompt = (
        f"Ты ИИ-аватар строгого отца. Придумай {PHRASE_BANK_SIZE} РАЗНЫХ "
        "коротких фраз (максимум 7 слов каждая), которыми отец зовёт ребёнка "
        "вернуться за уроки. Без приветствий, без нумерации. "
        "Верни ТОЛЬКО JSON-массив строк на русском языке, ничего больше."
    )
    try:
        response = ollama.chat(
            model="llama3.1",
            messages=[{"role": "system", "content": system_prompt},
                      {"role": "user", "content": "Действуй!"}]
        )
        raw = response["message"]["content"].strip()
        raw = raw.replace("```json", "").replace("```", "").strip()
        phrases = json.loads(raw)
        if not isinstance(phrases, list) or not phrases:
            raise ValueError("пустой список")
        return phrases[:PHRASE_BANK_SIZE]
    except Exception as e:
        print(f"[AI] Ollama недоступен или ответ некорректен ({e}), "
              f"использую заготовленные фразы.")
        return FALLBACK_PHRASES[:PHRASE_BANK_SIZE]


def synthesize_phrase_bank(phrases: list[str]):
    # Импортируем TTS только здесь — модель тяжёлая, незачем грузить её,
    # если запись/шумоподавление ещё не готовы.
    print("[TTS] Загружаю XTTS v2 (может занять минуту при первом запуске)...")
    from TTS.api import TTS
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cpu")

    os.makedirs(PHRASES_DIR, exist_ok=True)
    manifest = []

    for i, phrase in enumerate(phrases):
        filename = f"phrase_{i:02d}.wav"
        path = os.path.join(PHRASES_DIR, filename)
        print(f"[TTS] {i + 1}/{len(phrases)}: {phrase}")
        try:
            tts.tts_to_file(
                text=phrase,
                speaker_wav=REFERENCE_WAV,
                language="ru",
                file_path=path,
            )
            manifest.append({"text": phrase, "file": f"phrases/{filename}"})
        except Exception as e:
            print(f"[TTS ОШИБКА] '{phrase}': {e}")

    manifest_path = os.path.join(OUTPUT_DIR, "phrases", "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\n[ГОТОВО] Синтезировано {len(manifest)} фраз в {PHRASES_DIR}/")
    print(f"[ГОТОВО] Манифест: {manifest_path}")


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    raw_audio = record_reference_voice()
    cleaned_audio = denoise(raw_audio)
    save_wav_float(REFERENCE_WAV, cleaned_audio)
    print(f"[OK] Очищенный образец голоса сохранён: {REFERENCE_WAV}")

    phrases = generate_phrase_texts()
    synthesize_phrase_bank(phrases)

    print("\nВсё готово. Теперь запусти:")
    print("    python -m http.server 8000 --directory web")
    print("и открой http://localhost:8000/avatar.html в браузере.")


if __name__ == "__main__":
    main()