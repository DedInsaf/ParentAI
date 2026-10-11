"""Private lesson plans, local hint progression and cancellable voice replies."""
from collections import defaultdict, deque
import re
import shutil
import tempfile
import threading
import time
import uuid
from pathlib import Path

from lipsync import timeline
from runtime import BUSY
from usage import LimitExceeded, estimate_tokens


REPEAT_WORDS = ("повтори", "ещё раз", "не расслышал", "не расслышала")
NEXT_WORDS = ("дальше", "следующая подсказка", "не знаю", "не понимаю", "подскажи ещё")


def _normalized_answer(value):
    value = value.casefold().replace("ё", "е")
    return re.sub(r"[^0-9a-zа-я+\-=/.,]", "", value).replace(",", ".")


def voice_excerpt(text, limit=240):
    """Keep cloud speech to one v3 billing block without chopping a word."""
    clean = " ".join((text or "").split())
    if len(clean) <= limit:
        return clean
    candidate = clean[:limit + 1]
    for marker in (". ", "? ", "! ", "; "):
        position = candidate.rfind(marker)
        if position >= 80:
            return candidate[:position + 1]
    return candidate[:limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"


class Dialogues:
    def __init__(self, runtime, tutor, fast_voice=None, usage=None):
        self.runtime, self.tutor = runtime, tutor
        self.fast_voice, self.usage = fast_voice, usage
        self.lock = threading.RLock()
        self.sessions, self.jobs, self.requests = {}, {}, {}
        self.recent = defaultdict(deque)
        self.storage = tempfile.TemporaryDirectory(prefix='parentai-dialog-')
        self.closed = threading.Event()

    def _rate_limit(self, user_id, now):
        if not user_id:
            return
        recent = self.recent[user_id]
        while recent and now - recent[0] > 60:
            recent.popleft()
        if recent and now - recent[-1] < .7:
            raise ValueError('Подожди секунду перед следующей подсказкой.')
        if len(recent) >= 12:
            raise ValueError('Слишком много быстрых запросов. Сделай короткий перерыв.')
        recent.append(now)

    def start(self, question, level, session=None, voice="parent", user_id=0, request_id=None,
              unlimited=False):
        if voice not in ("parent", "yandex"):
            raise ValueError("Неизвестный голос ответа.")
        if not isinstance(question, str) or not question.strip() or len(question) > 4000:
            raise ValueError('Введите вопрос до 4000 знаков.')
        from tutor import LEVELS
        if level not in LEVELS:
            raise ValueError('Неизвестный уровень объяснения.')
        if not self.tutor.public_status()['enabled']:
            raise ValueError('Настройте YandexGPT в parentai.env.')
        request_id = request_id if isinstance(request_id, str) and 8 <= len(request_id) <= 100 else uuid.uuid4().hex
        with self.lock:
            if self.closed.is_set():
                raise ValueError('Приложение закрывается.')
            duplicate = self.requests.get((user_id, request_id))
            if duplicate and duplicate in self.jobs:
                job = self.jobs[duplicate]
                return {'id': job['id'], 'session': job['session'], 'duplicate': True}
            now = time.monotonic()
            self._rate_limit(user_id, now)
            for key, job in list(self.jobs.items()):
                if now - job['created'] > 1800 and job['state'] in ('done', 'error', 'cancelled'):
                    shutil.rmtree(Path(self.storage.name) / key, ignore_errors=True)
                    self.requests.pop((job['user_id'], job['request_id']), None)
                    del self.jobs[key]
            for key, item in list(self.sessions.items()):
                if now - item['updated'] > 1800:
                    del self.sessions[key]
            if any(j['user_id'] == user_id and j['state'] in ('thinking', 'speaking') for j in self.jobs.values()):
                raise ValueError('Сначала дождись ответа или отмени запрос.')
            if len(self.jobs) >= 100:
                raise ValueError('Слишком много запросов. Сделайте перерыв.')
            if session is not None:
                item = self.sessions.get(session)
                if not item or item['user_id'] != user_id:
                    raise ValueError('Диалог истёк. Нажмите «Новое задание».')
            session = session or uuid.uuid4().hex
            self.sessions.setdefault(session, dict(history=[], attempt=0, updated=now, plan=None,
                                                   user_id=user_id, difficult=False))
            attempt = self.sessions[session]['attempt']
            key = uuid.uuid4().hex
            job = dict(id=key, session=session, state='thinking', created=now, user_id=user_id,
                       request_id=request_id, cancel=threading.Event(), voice=voice, answer='', warning='',
                       limit_warning='', cues=[], chunks=[], unlimited=bool(unlimited))
            self.jobs[key] = job
            self.requests[(user_id, request_id)] = key
            thread = threading.Thread(target=self._run,
                                      args=(job, question.strip(), level, attempt), daemon=True)
            job['thread'] = thread
            thread.start()
            return {'id': key, 'session': session, 'duplicate': False}

    def _owned(self, key, user_id):
        job = self.jobs.get(key)
        if not job or (user_id is not None and job['user_id'] != user_id):
            raise ValueError('Ответ не найден.')
        return job

    def snapshot(self, key, user_id=None):
        with self.lock:
            job = self._owned(key, user_id)
            return {k: job[k] for k in ('id', 'session', 'state', 'answer', 'warning',
                                         'limit_warning', 'cues', 'chunks')}

    def cancel(self, key, user_id=None):
        with self.lock:
            try:
                job = self._owned(key, user_id)
            except ValueError:
                return
            job['cancel'].set()
            job['state'] = 'cancelled'

    def audio(self, key, chunk=None, user_id=None):
        with self.lock:
            job = self._owned(key, user_id)
            if chunk is not None:
                if not isinstance(chunk, int) or not 0 <= chunk < len(job['chunks']):
                    raise ValueError('Фрагмент аудио не найден.')
                return Path(self.storage.name) / key / job['chunks'][chunk]['file']
            if job['state'] != 'done' or not job.get('audio'):
                raise ValueError('Аудио ещё не готово.')
            return Path(self.storage.name) / key / 'phrase-0.wav'

    def _reserve_plan(self, job, question):
        if not self.usage or not job['user_id']:
            return None
        input_tokens, output_tokens = estimate_tokens(question) + 300, 850
        reservation = self.usage.reserve(
            job['user_id'], 'llm', job['request_id'] + ':plan', lesson_id=job['session'],
            input_units=input_tokens, output_units=output_tokens,
            estimated_cost=self.usage.config.llm_cost(input_tokens, output_tokens),
            provider='YandexGPT', model=getattr(self.tutor, 'model', ''), new_lesson=True,
            bypass_limits=job['unlimited'],
        )
        job['limit_warning'] = reservation['warning']
        return reservation['id']

    def _complete_plan_usage(self, event_id, usage):
        if not event_id or not self.usage:
            return
        input_tokens = usage.get('input_tokens') or 0
        output_tokens = usage.get('output_tokens') or 0
        self.usage.complete(event_id, input_units=input_tokens, output_units=output_tokens,
                            cost=self.usage.config.llm_cost(input_tokens, output_tokens),
                            actual_usage=usage.get('actual', False))

    def _from_plan(self, session, question):
        plan, attempt = session['plan'], session['attempt']
        normalized = _normalized_answer(question)
        accepted = {_normalized_answer(item) for item in plan.get('acceptable_answers', []) if item}
        if attempt and any(word in question.casefold() for word in REPEAT_WORDS):
            index = min(attempt - 1, 2)
            return self._hint(plan, index), False, False, False
        if attempt and accepted and normalized in accepted:
            return 'Верно! Ты сам нашёл правильный ответ. Объясни теперь, какой шаг помог тебе больше всего?', True, True, False
        if attempt >= 3:
            return plan['final_explanation'] or plan['solution'], True, False, True
        index = min(attempt, 2)
        difficult = bool(attempt and any(word in question.casefold() for word in NEXT_WORDS)) or index == 2
        return self._hint(plan, index), False, False, difficult

    @staticmethod
    def _hint(plan, index):
        return f"{plan['hints'][index]} {plan['control_questions'][index]}".strip()

    def _answer(self, job, question, level):
        session = self.sessions[job['session']]
        if session['plan'] is None and hasattr(self.tutor, 'create_plan'):
            event_id = self._reserve_plan(job, question)
            usage_completed = False
            try:
                result = self.tutor.create_plan(question, level)
                self._complete_plan_usage(event_id, result.get('usage', {}))
                usage_completed = True
                if job['cancel'].is_set() or self.closed.is_set():
                    raise InterruptedError()
            except Exception as exc:
                provider_usage = getattr(exc, 'usage', None)
                if event_id and self.usage and provider_usage and not usage_completed:
                    self._complete_plan_usage(event_id, provider_usage)
                    usage_completed = True
                if event_id and self.usage and not usage_completed:
                    self.usage.fail(event_id)
                    self.usage.abandon_empty_lesson(job['user_id'], job['session'])
                raise
            session['plan'] = result['plan']
            answer, finished, independent, difficult = self._from_plan(session, question)
        elif session['plan'] is not None:
            answer, finished, independent, difficult = self._from_plan(session, question)
        else:
            result = self.tutor.answer(question, session['history'], level, attempt=session['attempt'])
            answer, finished, independent, difficult = result['answer'], False, False, session['attempt'] >= 2
        if job['cancel'].is_set() or self.closed.is_set():
            raise InterruptedError()
        if not finished:
            session['attempt'] += 1
            if self.usage and job['user_id']:
                self.usage.lesson_hint(job['user_id'], job['session'], difficult)
        elif self.usage and job['user_id']:
            self.usage.finish_lesson(job['user_id'], job['session'], independent, difficult)
        session['difficult'] = session['difficult'] or difficult
        session['history'] = (session['history'] + [
            {'role': 'user', 'text': question}, {'role': 'assistant', 'text': answer}])[-6:]
        session['updated'] = time.monotonic()
        return answer[:1200]

    def _synthesize_yandex(self, job, answer, bank):
        if not self.fast_voice:
            raise ValueError('Быстрый голос Яндекса не настроен.')
        spoken = voice_excerpt(answer)
        event_id = None
        if self.usage and job['user_id']:
            blocks = max(1, (len(spoken) + 249) // 250)
            reservation = self.usage.reserve(
                job['user_id'], 'tts', job['request_id'] + ':tts', lesson_id=job['session'],
                input_units=len(spoken), billed_units=blocks,
                estimated_cost=self.usage.config.tts_cost(blocks), provider='Yandex SpeechKit', model='general-v3',
                bypass_limits=job['unlimited'])
            event_id = reservation['id']
            job['limit_warning'] = job['limit_warning'] or reservation['warning']
        try:
            result = self.fast_voice.synthesize(spoken, bank / 'phrase-0.wav') or {}
            if event_id:
                blocks = result.get('blocks', max(1, (len(spoken) + 249) // 250))
                self.usage.complete(event_id, input_units=len(spoken), duration_ms=result.get('duration_ms', 0),
                                    billed_units=blocks, cost=self.usage.config.tts_cost(blocks), actual_usage=True)
        except Exception:
            if event_id:
                self.usage.fail(event_id)
            raise
        return spoken

    def _run(self, job, question, level, attempt):
        acquired = False
        try:
            answer = self._answer(job, question, level)
            if job['cancel'].is_set() or self.closed.is_set():
                raise InterruptedError()
            with self.lock:
                if job['cancel'].is_set() or self.closed.is_set():
                    raise InterruptedError()
                job['answer'] = answer
            if job['voice'] == 'yandex':
                bank = Path(self.storage.name) / job['id']; bank.mkdir()
                job['state'] = 'speaking'
                try:
                    spoken = self._synthesize_yandex(job, answer, bank)
                except LimitExceeded as exc:
                    job.update(state='done', warning=str(exc))
                    return
                if job['cancel'].is_set() or self.closed.is_set():
                    raise InterruptedError()
                job.update(cues=timeline(bank / 'phrase-0.wav', spoken), audio=True, state='done')
                return
            with self.runtime.lock:
                if job['cancel'].is_set() or self.closed.is_set():
                    raise InterruptedError()
                if (self.runtime.reference_mode != 'clone' or not self.runtime.status['reference']
                        or self.runtime.status['voice'] in BUSY or self.runtime.reply_busy):
                    job.update(state='done', warning='Голос родителя недоступен, но подсказка сохранена на экране.')
                    return
                self.runtime.reply_busy = acquired = True
                bank = Path(self.storage.name) / job['id']
                bank.mkdir()
                shutil.copyfile(self.runtime.data / 'reference.wav', bank / 'reference.wav')
            job['state'] = 'speaking'
            spoken = voice_excerpt(answer)
            def update(value):
                with self.lock:
                    job['chunks'] = list(value.get('chunks', []))
            self.runtime.voice_engine.synthesize(bank / 'reference.wav', bank, spoken, job['cancel'], update)
            if job['cancel'].is_set() or self.closed.is_set():
                raise InterruptedError()
            job.update(cues=timeline(bank / 'phrase-0.wav', spoken), audio=True, state='done')
        except InterruptedError:
            job.update(state='cancelled')
        except Exception as exc:
            if job['cancel'].is_set() or self.closed.is_set():
                job.update(state='cancelled'); return
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
