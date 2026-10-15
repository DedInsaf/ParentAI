"""Private lesson plans, local hint progression and cancellable voice replies."""
from collections import defaultdict, deque
from decimal import Decimal, InvalidOperation
from fractions import Fraction
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

# PRODUCT INVARIANT: answers are spoken in the parent's voice unless the
# parent explicitly chooses another provider in the lesson settings. Do not
# change this default to Yandex and do not silently substitute another person.
DEFAULT_REPLY_VOICE = "parent"


def _normalized_answer(value):
    value = value.casefold().replace("ё", "е").replace("−", "-")
    return re.sub(r"[^0-9a-zа-я+\-=/.,]", "", value).replace(",", ".")


_NUMBER_WORDS = {
    'ноль': 0, 'ноля': 0, 'один': 1, 'одна': 1, 'одно': 1, 'одну': 1,
    'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'четырем': 4, 'пять': 5,
    'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10,
    'одиннадцать': 11, 'двенадцать': 12, 'тринадцать': 13, 'четырнадцать': 14,
    'пятнадцать': 15, 'шестнадцать': 16, 'семнадцать': 17, 'восемнадцать': 18,
    'девятнадцать': 19, 'двадцать': 20, 'тридцать': 30, 'сорок': 40,
    'пятьдесят': 50, 'шестьдесят': 60, 'семьдесят': 70, 'восемьдесят': 80,
    'девяносто': 90, 'сто': 100, 'двести': 200, 'триста': 300, 'четыреста': 400,
    'пятьсот': 500, 'шестьсот': 600, 'семьсот': 700, 'восемьсот': 800, 'девятьсот': 900,
}
_DENOMINATORS = {
    'вторая': 2, 'вторых': 2, 'третья': 3, 'третьих': 3, 'четвертая': 4, 'четвертых': 4,
    'пятая': 5, 'пятых': 5, 'десятая': 10, 'десятых': 10, 'сотая': 100, 'сотых': 100,
    'тысячная': 1000, 'тысячных': 1000,
}
_UNIT_ALIASES = {
    r'\bсантиметр(?:а|ов|ы)?\b': 'см', r'\bмиллиметр(?:а|ов|ы)?\b': 'мм',
    r'\bкилометр(?:а|ов|ы)?\b': 'км', r'\bкилограмм(?:а|ов|ы)?\b': 'кг',
    r'\bграмм(?:а|ов|ы)?\b': 'г', r'\bлитр(?:а|ов|ы)?\b': 'л',
    r'\bсекунд(?:а|ы|у|ам|ами)?\b': 'с', r'\bминут(?:а|ы|у|ам|ами)?\b': 'мин',
    r'\bпроцент(?:а|ов|ы)?\b': '%',
}


def _integer_words(words):
    if not words or any(word not in _NUMBER_WORDS for word in words):
        return None
    return sum(_NUMBER_WORDS[word] for word in words)


def _spoken_number(value):
    """Convert a short Russian spoken number to an exact fraction."""
    words = re.findall(r'[a-zа-я]+', value.casefold().replace('ё', 'е'))
    if not words:
        return None
    sign = -1 if words[0] == 'минус' else 1
    if sign < 0:
        words = words[1:]
    whole_markers = {'целая', 'целых', 'целое', 'целые'}
    marker = next((i for i, word in enumerate(words) if word in whole_markers), None)
    if marker is not None and words[-1] in _DENOMINATORS:
        whole = _integer_words(words[:marker])
        numerator = _integer_words(words[marker + 1:-1])
        if whole is not None and numerator is not None:
            return sign * (Fraction(whole) + Fraction(numerator, _DENOMINATORS[words[-1]]))
    if len(words) > 1 and words[-1] in _DENOMINATORS:
        numerator = _integer_words(words[:-1])
        if numerator is not None:
            return sign * Fraction(numerator, _DENOMINATORS[words[-1]])
    integer = _integer_words(words)
    return sign * Fraction(integer) if integer is not None else None


def _numeric_answer(value):
    compact = re.sub(r'\s+', '', value).replace(',', '.').replace('−', '-')
    try:
        if re.fullmatch(r'[+-]?\d+(?:\.\d+)?', compact):
            return Fraction(Decimal(compact))
        match = re.fullmatch(r'([+-]?\d+)\/([+-]?\d+)', compact)
        if match and int(match.group(2)):
            return Fraction(int(match.group(1)), int(match.group(2)))
    except (InvalidOperation, ValueError, ZeroDivisionError):
        return None
    return _spoken_number(value)


def _answer_variants(value):
    """Return conservative equivalents for typed and speech-recognized answers."""
    text = value.casefold().replace('ё', 'е').replace('−', '-').strip()
    text = re.sub(r'\bикс\b', 'x', text)
    for pattern, replacement in _UNIT_ALIASES.items():
        text = re.sub(pattern, replacement, text)
    candidates, pending = set(), [text]
    prefix = re.compile(
        r'^(?:(?:я\s+думаю|мне\s+кажется)\s*,?\s*(?:что\s+)?|'
        r'(?:у\s+меня\s+)?(?:ответ|получил(?:ось|ся|а)?|получается|вышло|выходит|итог|будет|это)'
        r'\s*(?:[:=—-]\s*)?)', re.I)
    marker = re.compile(r'\b(?:ответ|получил(?:ось|ся|а)?|получается|вышло|итог|равно|равна|равен)\b\s*(?:[:=—-]\s*)?(.+)$', re.I)
    while pending:
        candidate = pending.pop().strip(' \t\r\n.!?;:')
        if not candidate or candidate in candidates:
            continue
        candidates.add(candidate)
        stripped = prefix.sub('', candidate, count=1).strip()
        if stripped and stripped != candidate:
            pending.append(stripped)
        found = marker.search(candidate)
        if found:
            pending.append(found.group(1))
        if '=' in candidate:
            pending.append(candidate.rsplit('=', 1)[1])
    variants = {_normalized_answer(candidate) for candidate in candidates}
    units = {'см', 'мм', 'км', 'кг', 'г', 'л', 'с', 'мин', '%'}
    unit_pattern = '|'.join(map(re.escape, sorted(units, key=len, reverse=True)))
    for candidate in candidates:
        unit_match = re.fullmatch(r'(.+?)\s*(' + unit_pattern + r')', candidate)
        number_text = unit_match.group(1) if unit_match else candidate
        number = _numeric_answer(number_text)
        if number is not None:
            unit = ':' + unit_match.group(2) if unit_match else ''
            variants.add(f'#number:{number.numerator}/{number.denominator}{unit}')
    return {item for item in variants if item}


def _answers_match(value, acceptable_answers):
    offered = _answer_variants(value)
    return any(offered.intersection(_answer_variants(answer)) for answer in acceptable_answers if answer)


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
    def __init__(self, runtime, tutor, fast_voice=None, usage=None, runtime_for=None):
        self.runtime, self.tutor = runtime, tutor
        self.runtime_for = runtime_for or (lambda _user_id: runtime)
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

    def start(self, question, level, session=None, voice=DEFAULT_REPLY_VOICE,
              user_id=0, request_id=None, unlimited=False, study_session=None):
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
        if self.usage and user_id:
            if not study_session and session:
                with self.lock:
                    study_session = (self.sessions.get(session) or {}).get('study_session')
            if not study_session:
                study_session = self.usage.start_study_session(user_id, unlimited)['id']
            self.usage.validate_study_session(user_id, study_session, unlimited)
        with self.lock:
            if self.closed.is_set():
                raise ValueError('Приложение закрывается.')
            duplicate = self.requests.get((user_id, request_id))
            if duplicate and duplicate in self.jobs:
                job = self.jobs[duplicate]
                return {'id': job['id'], 'session': job['session'],
                        'study_session': job.get('study_session'), 'duplicate': True}
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
                if item.get('study_session') != study_session:
                    raise ValueError('Эта задача относится к другому занятию. Начните новую задачу.')
                # A solved task is immutable. Even if an older browser keeps its
                # session id while the final audio is finishing, the next input
                # must start a fresh task instead of reopening old hints.
                if item.get('finished'):
                    session = None
            session = session or uuid.uuid4().hex
            self.sessions.setdefault(session, dict(history=[], attempt=0, updated=now, plan=None,
                                                   user_id=user_id, study_session=study_session,
                                                   difficult=False, finished=False))
            attempt = self.sessions[session]['attempt']
            key = uuid.uuid4().hex
            job = dict(id=key, session=session, state='thinking', created=now, user_id=user_id,
                       request_id=request_id, cancel=threading.Event(), voice=voice, answer='', warning='',
                       limit_warning='', cues=[], chunks=[], unlimited=bool(unlimited), finished=False,
                       study_session=study_session)
            self.jobs[key] = job
            self.requests[(user_id, request_id)] = key
            thread = threading.Thread(target=self._run,
                                      args=(job, question.strip(), level, attempt), daemon=True)
            job['thread'] = thread
            thread.start()
            return {'id': key, 'session': session, 'study_session': study_session, 'duplicate': False}

    def _owned(self, key, user_id):
        job = self.jobs.get(key)
        if not job or (user_id is not None and job['user_id'] != user_id):
            raise ValueError('Ответ не найден.')
        return job

    def snapshot(self, key, user_id=None):
        with self.lock:
            job = self._owned(key, user_id)
            return {k: job[k] for k in ('id', 'session', 'state', 'answer', 'warning',
                                         'limit_warning', 'cues', 'chunks', 'finished')}

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
            study_session_id=job['study_session'],
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
        accepted = [*plan.get('acceptable_answers', []), plan.get('answer_criterion', '')]
        if attempt and any(word in question.casefold() for word in REPEAT_WORDS):
            index = min(attempt - 1, 2)
            return self._hint(plan, index), False, False, False
        if attempt and accepted and _answers_match(question, accepted):
            return ('Верно! Ответ правильный. Отличная работа! Переходим к новому заданию? '
                    'Напиши или скажи его условие.'), True, True, False
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
        session['finished'] = finished
        session['history'] = (session['history'] + [
            {'role': 'user', 'text': question}, {'role': 'assistant', 'text': answer}])[-6:]
        session['updated'] = time.monotonic()
        job['finished'] = finished
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
                study_session_id=job['study_session'],
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
        runtime = self.runtime_for(job['user_id'])
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
            with runtime.lock:
                if job['cancel'].is_set() or self.closed.is_set():
                    raise InterruptedError()
                if (runtime.reference_mode != 'clone' or not runtime.status['reference']
                        or runtime.status['voice'] in BUSY or runtime.reply_busy):
                    job.update(state='done', warning='Голос родителя недоступен, но подсказка сохранена на экране.')
                    return
                runtime.reply_busy = acquired = True
                bank = Path(self.storage.name) / job['id']
                bank.mkdir()
                references=[]
                for index, source in enumerate(runtime.reference_paths(), 1):
                    target=bank / ('reference.wav' if index == 1 else f'reference-{index}.wav')
                    shutil.copyfile(source, target);references.append(target)
            job['state'] = 'speaking'
            spoken = voice_excerpt(answer)
            def update(value):
                with self.lock:
                    job['chunks'] = list(value.get('chunks', []))
            runtime.voice_engine.synthesize(references, bank, spoken, job['cancel'], update)
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
                with runtime.lock:
                    runtime.reply_busy = False

    def close(self):
        self.closed.set()
        with self.lock:
            jobs = list(self.jobs.values())
            for job in jobs:
                job['cancel'].set()
        for job in jobs:
            job['thread'].join(timeout=6)
        self.storage.cleanup()

    def cancel_user(self, user_id):
        """Stop and forget temporary dialogue data before an account is deleted."""
        with self.lock:
            jobs = [job for job in self.jobs.values() if job['user_id'] == user_id]
            for job in jobs:
                job['cancel'].set()
        for job in jobs:
            job['thread'].join(timeout=6)
        with self.lock:
            for job in jobs:
                self.jobs.pop(job['id'], None)
                self.requests.pop((user_id, job['request_id']), None)
                shutil.rmtree(Path(self.storage.name) / job['id'], ignore_errors=True)
            for key, value in list(self.sessions.items()):
                if value.get('user_id') == user_id:
                    del self.sessions[key]
            self.recent.pop(user_id, None)
