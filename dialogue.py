"""Ephemeral tutor conversations and cancellable, disposable XTTS replies."""
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from runtime import ROOT, BUSY
from lipsync import timeline


class Dialogues:
    def __init__(self, runtime, tutor):
        self.runtime, self.tutor = runtime, tutor
        self.lock = threading.RLock()
        self.sessions, self.jobs = {}, {}
        self.storage = tempfile.TemporaryDirectory(prefix='parentai-dialog-')
        self.closed = threading.Event()

    def start(self, question, level, session=None):
        if not isinstance(question, str) or not question.strip() or len(question) > 4000:
            raise ValueError('Введите вопрос до 4000 знаков.')
        from tutor import LEVELS
        if level not in LEVELS:
            raise ValueError('Неизвестный уровень объяснения.')
        if not self.tutor.public_status()['enabled']:
            raise ValueError('Настройте YandexGPT в parentai.env.')
        with self.lock:
            if self.closed.is_set():
                raise ValueError('Приложение закрывается.')
            now = time.monotonic()
            for key, job in list(self.jobs.items()):
                if now - job['created'] > 1800 and job['state'] in ('done', 'error', 'cancelled'):
                    shutil.rmtree(Path(self.storage.name) / key, ignore_errors=True)
                    del self.jobs[key]
            for key, item in list(self.sessions.items()):
                if now - item['updated'] > 1800:
                    del self.sessions[key]
            if any(j['state'] in ('thinking', 'speaking') for j in self.jobs.values()):
                raise ValueError('Сначала дождитесь ответа или отмените запрос.')
            if len(self.jobs) >= 100:
                raise ValueError('Слишком много запросов. Сделайте перерыв.')
            if session is not None and (not isinstance(session, str) or session not in self.sessions):
                raise ValueError('Диалог истёк. Нажмите «Новое задание».')
            session = session or uuid.uuid4().hex
            history = self.sessions.get(session, {}).get('history', [])
            while sum(len(item['text']) for item in history) + len(question) > 12000:
                history = history[2:]
            attempt = self.sessions.get(session, {}).get('attempt', 0)
            key = uuid.uuid4().hex
            job = dict(id=key, session=session, state='thinking', created=now,
                       cancel=threading.Event(), answer='', warning='', cues=[])
            self.jobs[key] = job
            thread = threading.Thread(target=self._run, args=(job, question.strip(), level, history, attempt), daemon=True)
            job['thread'] = thread
            thread.start()
            return {'id': key, 'session': session}

    def snapshot(self, key):
        with self.lock:
            job = self.jobs.get(key)
            if not job:
                raise ValueError('Ответ не найден.')
            return {k: job[k] for k in ('id', 'session', 'state', 'answer', 'warning', 'cues')}

    def cancel(self, key):
        with self.lock:
            if key in self.jobs:
                self.jobs[key]['cancel'].set()

    def audio(self, key):
        with self.lock:
            job = self.jobs.get(key)
            if not job or job['state'] != 'done' or not job.get('audio'):
                raise ValueError('Аудио ещё не готово.')
            return Path(self.storage.name) / key / 'phrase-0.wav'

    def _run(self, job, question, level, history, attempt):
        acquired = False
        try:
            result = self.tutor.answer(question, history, level, attempt=attempt)
            if job['cancel'].is_set() or self.closed.is_set():
                raise InterruptedError()
            answer = result['answer'][:1200]
            with self.lock:
                job['answer'] = answer
                self.sessions[job['session']] = dict(history=(history + [
                    {'role': 'user', 'text': question}, {'role': 'assistant', 'text': answer}])[-6:],
                    attempt=attempt + 1, updated=time.monotonic())
            # Text remains available if no clone exists or synthesis fails.
            with self.runtime.lock:
                if (self.runtime.reference_mode != 'clone' or not self.runtime.status['reference']
                        or self.runtime.status['voice'] in BUSY or self.runtime.reply_busy):
                    job.update(state='done', warning='Для озвучивания новых ответов запишите образец и выберите клонирование XTTS.')
                    return
                self.runtime.reply_busy = acquired = True
                bank = Path(self.storage.name) / job['id']
                bank.mkdir()
                shutil.copyfile(self.runtime.data / 'reference.wav', bank / 'reference.wav')
            job['state'] = 'speaking'
            textfile = bank / 'reply.txt'
            textfile.write_text(answer, encoding='utf-8')
            with (bank / 'worker.log').open('wb') as log:
                process = subprocess.Popen([sys.executable, str(ROOT / 'voice_worker.py'),
                                            str(bank / 'reference.wav'), str(bank), str(textfile)],
                                           cwd=ROOT, stdout=log, stderr=log)
                deadline = time.monotonic() + 600
                try:
                    while process.poll() is None:
                        if job['cancel'].wait(.2) or self.closed.is_set():
                            raise InterruptedError()
                        if time.monotonic() > deadline:
                            raise ValueError('Озвучивание заняло больше 10 минут.')
                    if process.returncode:
                        raise ValueError('XTTS не создал ответ. Проверьте установку модели голоса.')
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=3)
            job.update(cues=timeline(bank / 'phrase-0.wav', answer), audio=True, state='done')
        except InterruptedError:
            job.update(state='cancelled')
        except Exception as exc:
            job.update(state='done' if job['answer'] else 'error', warning=str(exc))
        finally:
            if acquired:
                with self.runtime.lock:
                    self.runtime.reply_busy = False

    def close(self):
        self.closed.set()
        with self.lock:
            jobs = list(self.jobs.values())
            for job in jobs:
                job['cancel'].set()
        for job in jobs:
            job['thread'].join(timeout=6)
        self.storage.cleanup()
