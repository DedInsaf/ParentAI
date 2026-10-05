import cv2
import time
import os
import sys
import json
import numpy as np
import sounddevice as sd
from scipy.io import wavfile
import random
import threading
import ollama
import mediapipe as mp

# Загрузка движка TTS
print("[ИНФО] Инициализация движка TTS (XTTS v2)...")
from TTS.api import TTS


class LiveAIAvatar:
    def __init__(self):
        # ================= НАСТРОЙКИ =================
        self.MISSING_THRESHOLD = 5.0
        self.RETURN_THRESHOLD = 2.0
        self.RECORD_DURATION = 4.0
        self.PHRASE_BANK_SIZE = 8  # сколько фраз готовим заранее

        self.parent_voice_file = 'parent_reference.wav'
        self.generated_voice_file = 'generated_warning.wav'
        self.phrase_bank_dir = 'phrase_bank'
        # =============================================

        self.state = 'SETUP'

        # Данные аватара (2.5D Кукла)
        self.avatar_head_top = None
        self.avatar_jaw = None

        self.missing_start_time = 0.0
        self.return_start_time = 0.0
        self.record_start_time = 0.0

        # Аудио данные
        self.audio_data = None
        self.alarm_audio_array = None
        self.alarm_sr = 44100
        self.alarm_start_time = 0.0
        self.is_playing = False
        self.is_generating_ai = False

        # НОВОЕ: банк заранее сгенерированных фраз голосом родителя.
        # Идея: LLM (Ollama) и TTS (XTTS) — самые медленные части системы.
        # Раньше они запускались ЖИВЬЁМ в момент, когда ребёнок уже убежал —
        # отсюда и ощущение "долго думает". Теперь они отрабатывают один раз,
        # пока ребёнок ещё сидит за партой, и просто складывают готовые .wav
        # в список. Когда наступает ALARM — берём готовый файл мгновенно.
        self.phrase_bank = []
        self.bank_ready = False
        self.bank_generating = False

        self._init_camera()
        self._init_vision()
        self._init_ai()

    def _init_camera(self):
        self.cap = cv2.VideoCapture(0)
        if not self.cap.isOpened():
            print("[ОШИБКА] Камера недоступна.")
            sys.exit(1)

    def _init_vision(self):
        print("[ИНФО] Инициализация MediaPipe Face Mesh...")
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )

    def _init_ai(self):
        # Используем CPU. На Apple Silicon можно попробовать device="mps",
        # но Coqui TTS не гарантированно поддерживает все операции XTTS на MPS —
        # проверяйте на своей версии, при ошибках откатывайтесь на CPU.
        self.tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cpu")
        print("[УСПЕХ] AI-модули готовы к работе!")

    # ================= БАНК ФРАЗ (генерируется ЗАРАНЕЕ) =================
    def generate_phrase_bank(self):
        """Готовит PHRASE_BANK_SIZE фраз одним пакетом, пока ребёнок ещё
        на месте. Вызывается один раз в фоне сразу после записи голоса
        родителя, до того как мониторинг реально стартует."""
        if self.bank_generating:
            return
        self.bank_generating = True

        os.makedirs(self.phrase_bank_dir, exist_ok=True)
        print(f"[AI] Готовлю банк из {self.PHRASE_BANK_SIZE} фраз...")

        system_prompt = (
            f"Ты ИИ-аватар строгого отца. Придумай {self.PHRASE_BANK_SIZE} РАЗНЫХ "
            "коротких фраз (максимум 7 слов каждая), которыми отец зовёт ребёнка "
            "вернуться за уроки. Без приветствий, без нумерации. "
            "Верни ТОЛЬКО JSON-массив строк на русском языке, ничего больше."
        )
        phrases = None
        try:
            response = ollama.chat(
                model='llama3.1',
                messages=[{'role': 'system', 'content': system_prompt},
                          {'role': 'user', 'content': "Действуй!"}]
            )
            raw = response['message']['content'].strip()
            raw = raw.replace('```json', '').replace('```', '').strip()
            phrases = json.loads(raw)
            if not isinstance(phrases, list) or not phrases:
                raise ValueError("пустой или некорректный список")
        except Exception as e:
            print(f"[AI ОШИБКА Ollama, использую заготовки]: {e}")
            phrases = [
                "Немедленно вернись на свое место!",
                "Хватит бездельничать, за уроки!",
                "Я жду тебя за столом. Живо!",
                "Возвращайся, время не ждёт!",
                "Так, кто разрешил вставать?",
                "Быстро назад, домашка сама не сделается!",
                "Считаю до трёх. Возвращайся!",
                "Я всё вижу — быстро за парту!",
            ]

        for i, phrase in enumerate(phrases[:self.PHRASE_BANK_SIZE]):
            path = os.path.join(self.phrase_bank_dir, f"phrase_{i:02d}.wav")
            try:
                print(f"[AI] Синтез {i + 1}/{len(phrases[:self.PHRASE_BANK_SIZE])}: {phrase}")
                self.tts.tts_to_file(
                    text=phrase,
                    speaker_wav=self.parent_voice_file,
                    language="ru",
                    file_path=path
                )
                self.phrase_bank.append(path)
            except Exception as e:
                print(f"[AI ОШИБКА TTS] '{phrase}': {e}")

        self.bank_ready = len(self.phrase_bank) > 0
        self.bank_generating = False
        print(f"[AI] Банк готов: {len(self.phrase_bank)} фраз.")

    def background_ai_generation(self):
        """Резервный путь "вживую" — используется ТОЛЬКО если банк ещё не
        успел собраться (например, ребёнок убежал сразу после первого
        запуска, до того как фразы досинтезировались)."""
        self.is_generating_ai = True

        print("[AI] Банк ещё не готов — генерирую фразу вживую (Ollama)...")
        system_prompt = "Ты ИИ-аватар строгого отца. Ребенок отошел от уроков. Скажи ему ОЧЕНЬ строго вернуться. Максимум 7 слов. Без приветствий."
        try:
            response = ollama.chat(
                model='llama3.1',
                messages=[{'role': 'system', 'content': system_prompt}, {'role': 'user', 'content': "Действуй!"}]
            )
            phrase = response['message']['content'].strip().replace('"', '')
        except Exception as e:
            print(f"[AI ОШИБКА Ollama]: {e}")
            phrase = "Немедленно вернись на свое место!"

        print(f"[AI] Фраза: {phrase}")
        print("[AI] Синтез речи (XTTS)...")

        try:
            self.tts.tts_to_file(
                text=phrase,
                speaker_wav=self.parent_voice_file,
                language="ru",
                file_path=self.generated_voice_file
            )
            print("[AI] Голос готов!")
        except Exception as e:
            print(f"[AI ОШИБКА TTS]: {e}")

        if self.state == 'WAKING_UP':
            self.state = 'ALARM'
        self.is_generating_ai = False
    # =====================================================================

    def play_audio_and_sync(self):
        """Воспроизводит сгенерированный звук через sounddevice."""
        try:
            self.alarm_sr, self.alarm_audio_array = wavfile.read(self.generated_voice_file)

            # Если аудио стерео - переводим в моно
            if len(self.alarm_audio_array.shape) > 1:
                self.alarm_audio_array = self.alarm_audio_array.mean(axis=1)

            self.is_playing = True
            self.alarm_start_time = time.time()

            sd.play(self.alarm_audio_array, self.alarm_sr)
            sd.wait()  # Ждем окончания аудио

            self.is_playing = False
        except Exception as e:
            print(f"[ОШИБКА АУДИО] {e}")
            self.is_playing = False

    def start_alarm(self):
        if not self.is_playing:
            threading.Thread(target=self.play_audio_and_sync).start()

    def stop_alarm(self):
        if self.is_playing:
            sd.stop()
            self.is_playing = False

    def extract_live_avatar(self, frame, face_landmarks):
        """Создает динамического аватара, разрезая лицо по линии рта."""
        ih, iw, _ = frame.shape

        x_coords = [int(lm.x * iw) for lm in face_landmarks.landmark]
        y_coords = [int(lm.y * ih) for lm in face_landmarks.landmark]

        x_min, x_max = min(x_coords), max(x_coords)
        y_min, y_max = min(y_coords), max(y_coords)

        margin_x = int((x_max - x_min) * 0.3)
        margin_y = int((y_max - y_min) * 0.4)

        x1, y1 = max(0, x_min - margin_x), max(0, y_min - int(margin_y * 1.5))
        x2, y2 = min(iw, x_max + margin_x), min(ih, y_max + margin_y)

        head_crop = frame[y1:y2, x1:x2].copy()

        mouth_y_global = int(face_landmarks.landmark[13].y * ih)
        mouth_y_local = mouth_y_global - y1

        h, w = head_crop.shape[:2]
        side = min(h, w)
        head_crop = cv2.resize(head_crop, (side, side))
        mouth_y_local = int((mouth_y_local / h) * side)

        mask = np.zeros((side, side), dtype=np.uint8)
        cv2.circle(mask, (side // 2, side // 2), side // 2, 255, -1)

        circular_head = cv2.bitwise_and(head_crop, head_crop, mask=mask)
        b, g, r = cv2.split(circular_head)
        rgba_head = cv2.merge((b, g, r, mask))

        self.avatar_head_top = rgba_head[:mouth_y_local, :, :]
        self.avatar_jaw = rgba_head[mouth_y_local:, :, :]

        print("[ИНФО] Аватар успешно создан и разрезан для анимации!")

    def process_state_machine(self, face_detected):
        current_time = time.time()

        if self.state == 'RECORDING':
            if (current_time - self.record_start_time) > self.RECORD_DURATION:
                sd.wait()
                wavfile.write(self.parent_voice_file, 44100, self.audio_data)
                self.state = 'READY'
                # НОВОЕ: сразу запускаем сборку банка фраз в фоне —
                # к моменту, когда пользователь нажмёт 'S', он, скорее всего,
                # уже будет готов (или почти готов).
                threading.Thread(target=self.generate_phrase_bank).start()
            return
        elif self.state in ['SETUP', 'READY']:
            return

        if self.state == 'FOCUS':
            if not face_detected:
                self.state = 'MISSING'
                self.missing_start_time = current_time

        elif self.state == 'MISSING':
            if face_detected:
                self.state = 'RETURN'
                self.return_start_time = current_time
            elif (current_time - self.missing_start_time) > self.MISSING_THRESHOLD:
                if self.bank_ready:
                    # Мгновенно берём готовую фразу — без ожидания генерации.
                    self.generated_voice_file = random.choice(self.phrase_bank)
                    self.state = 'ALARM'
                else:
                    # Банк ещё не собрался — редкий случай (первые секунды
                    # после старта). Используем старый "живой" путь.
                    self.state = 'WAKING_UP'
                    threading.Thread(target=self.background_ai_generation).start()

        elif self.state == 'WAKING_UP':
            if face_detected:
                self.state = 'RETURN'
                self.return_start_time = current_time

        elif self.state == 'ALARM':
            self.start_alarm()
            if face_detected:
                self.state = 'RETURN'
                self.return_start_time = current_time
                self.stop_alarm()

        elif self.state == 'RETURN':
            if not face_detected:
                self.state = 'ALARM'
                self.missing_start_time = current_time
            elif (current_time - self.return_start_time) > self.RETURN_THRESHOLD:
                self.state = 'FOCUS'
                self.stop_alarm()

    def overlay_image(self, background, overlay, x, y):
        """Накладывает RGBA картинку на фоновый RGB массив."""
        h, w = overlay.shape[:2]
        bh, bw = background.shape[:2]

        if x < 0 or y < 0 or x + w > bw or y + h > bh: return background

        alpha = overlay[:, :, 3] / 255.0
        for c in range(3):
            background[y:y + h, x:x + w, c] = (alpha * overlay[:, :, c] + (1 - alpha) * background[y:y + h, x:x + w, c])
        return background

    def draw_dashboard(self, ih, iw):
        dashboard = np.zeros((ih, iw, 3), dtype=np.uint8)
        current_time = time.time()

        if self.avatar_head_top is not None and self.avatar_jaw is not None:
            top_h, av_w = self.avatar_head_top.shape[:2]
            jaw_h = self.avatar_jaw.shape[0]

            base_x = (iw // 2) - (av_w // 2)
            base_y = (ih // 2) - ((top_h + jaw_h) // 2)

            breath_offset = int(10 * np.sin(current_time * 2))
            jaw_drop = 0

            color_overlay = (0, 0, 0)

            if self.state == 'FOCUS':
                color_overlay = (0, 20, 0)
                cv2.putText(dashboard, "AI PARENT IS WATCHING", (iw // 2 - 180, ih - 50), cv2.FONT_HERSHEY_SIMPLEX, 1,
                            (0, 200, 0), 2)

            elif self.state == 'MISSING':
                color_overlay = (0, 60, 150)
                cv2.putText(dashboard, "WARNING: RETURN TO DESK", (iw // 2 - 200, ih - 50), cv2.FONT_HERSHEY_SIMPLEX, 1,
                            (0, 165, 255), 2)

            elif self.state == 'WAKING_UP':
                pulse = int(50 + 50 * np.sin(current_time * 10))
                color_overlay = (0, pulse, pulse * 2)
                cv2.putText(dashboard, "AI PARENT IS THINKING...", (iw // 2 - 180, ih - 50), cv2.FONT_HERSHEY_SIMPLEX,
                            1, (0, 255, 255), 2)

            elif self.state == 'ALARM':
                breath_offset += random.randint(-5, 5)
                base_x += random.randint(-5, 5)

                color_overlay = (0, 0, 150)
                cv2.putText(dashboard, "GET BACK TO WORK!", (iw // 2 - 180, ih - 50), cv2.FONT_HERSHEY_DUPLEX, 1,
                            (0, 0, 255), 3)

                if self.is_playing and self.alarm_audio_array is not None:
                    elapsed = time.time() - self.alarm_start_time
                    idx = int(elapsed * self.alarm_sr)
                    chunk_size = 2048

                    if idx + chunk_size < len(self.alarm_audio_array):
                        chunk = self.alarm_audio_array[idx: idx + chunk_size]
                        rms = np.sqrt(np.mean(np.square(chunk.astype(np.float32) / 32768.0)))
                        jaw_drop = int(rms * 250)
                        jaw_drop = min(jaw_drop, 40)

            tinted_top = self.avatar_head_top.copy()
            tinted_jaw = self.avatar_jaw.copy()
            for c in range(3):
                tinted_top[:, :, c] = cv2.add(tinted_top[:, :, c], color_overlay[2 - c])
                tinted_jaw[:, :, c] = cv2.add(tinted_jaw[:, :, c], color_overlay[2 - c])

            dashboard = self.overlay_image(dashboard, tinted_jaw, base_x, base_y + top_h + breath_offset + jaw_drop)
            dashboard = self.overlay_image(dashboard, tinted_top, base_x, base_y + breath_offset)

        return dashboard

    def run(self):
        print("\n=== СИСТЕМА ЗАПУЩЕНА ===")
        try:
            while True:
                ret, frame = self.cap.read()
                if not ret: break

                frame = cv2.flip(frame, 1)
                ih, iw, _ = frame.shape

                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = self.face_mesh.process(rgb_frame)

                face_detected = bool(results.multi_face_landmarks)

                if not self.is_generating_ai:
                    self.process_state_machine(face_detected)

                if self.state in ['SETUP', 'RECORDING', 'READY']:
                    display_frame = frame.copy()

                    if face_detected:
                        for lm in results.multi_face_landmarks[0].landmark:
                            cv2.circle(display_frame, (int(lm.x * iw), int(lm.y * ih)), 1, (0, 255, 0), -1)

                    if self.state == 'SETUP':
                        cv2.putText(display_frame, "PARENT: Frame face and press 'R'", (20, 50),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)
                    elif self.state == 'RECORDING':
                        cv2.putText(display_frame, "RECORDING VOICE...", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1,
                                    (0, 0, 255), 2)
                    elif self.state == 'READY':
                        bank_status = f"Phrase bank: {len(self.phrase_bank)}/{self.PHRASE_BANK_SIZE}" if self.bank_generating or self.bank_ready else "Phrase bank: pending"
                        cv2.putText(display_frame, "SETUP OK. Press 'S' to start monitor.", (20, 50),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                        cv2.putText(display_frame, bank_status, (20, 85),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                                    (0, 255, 0) if self.bank_ready else (0, 165, 255), 2)
                else:
                    display_frame = self.draw_dashboard(ih, iw)

                cv2.imshow('AI Parent Live Avatar', display_frame)

                key = cv2.waitKey(1) & 0xFF
                if key == ord('q'):
                    break
                elif key == ord('r') and self.state == 'SETUP' and face_detected:
                    self.extract_live_avatar(frame, results.multi_face_landmarks[0])

                    self.record_start_time = time.time()
                    print("[ИНФО] Запись звука (4 сек)... Говорите!")
                    self.audio_data = sd.rec(int(self.RECORD_DURATION * 44100), samplerate=44100, channels=1)
                    self.state = 'RECORDING'
                elif key == ord('s') and self.state == 'READY':
                    self.state = 'FOCUS'

        finally:
            self.stop_alarm()
            self.cap.release()
            cv2.destroyAllWindows()


if __name__ == '__main__':
    app = LiveAIAvatar()
    app.run()