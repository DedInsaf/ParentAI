"""Small, server-side YandexGPT client for homework help."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

from usage import estimate_tokens


ENDPOINT = 'https://ai.api.cloud.yandex.net/foundationModels/v1/completion'
LEVELS = {'начальная школа', 'средняя школа', 'старшая школа'}


class ProviderOutputError(ValueError):
    def __init__(self, message, usage):
        super().__init__(message)
        self.usage = usage


def load_local_env(path):
    """Load simple KEY=VALUE settings without overriding the process environment."""
    try:
        lines = Path(path).read_text(encoding='utf-8').splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key in {'YANDEX_API_KEY', 'YANDEX_FOLDER_ID', 'PARENTAI_TUTOR_MODEL', 'YANDEX_SPEECHKIT_API_KEY', 'YANDEX_TTS_API_KEY', 'PARENTAI_VOICE_DEVICE', 'PARENTAI_ENABLE_XTTS'}:
            os.environ.setdefault(key, value)


class Tutor:
    def __init__(self, api_key=None, folder_id=None, model=None, opener=None):
        self.api_key = api_key or ''
        self.folder_id = folder_id or ''
        self.model = model or 'yandexgpt-5-lite'
        self.opener = opener or urllib.request.urlopen

    @classmethod
    def from_environment(cls, root):
        load_local_env(Path(root) / 'parentai.env')
        return cls(os.getenv('YANDEX_API_KEY'), os.getenv('YANDEX_FOLDER_ID'),
                   os.getenv('PARENTAI_TUTOR_MODEL'))

    def public_status(self):
        enabled = bool(self.api_key and self.folder_id)
        return {
            'enabled': enabled,
            'provider': 'YandexGPT',
            'model': self.model,
            'message': ('Помощник YandexGPT готов' if enabled else
                        'Добавьте ключ YandexGPT и ID каталога в parentai.env'),
        }

    @staticmethod
    def _usage(result, request_text, answer_text):
        raw = result.get('result', {}).get('usage', {})
        def integer(*names):
            for name in names:
                try:
                    if raw.get(name) is not None:
                        return int(raw[name])
                except (TypeError, ValueError):
                    pass
            return None
        input_tokens = integer('inputTextTokens', 'inputTokens')
        output_tokens = integer('completionTokens', 'outputTextTokens', 'outputTokens')
        total_tokens = integer('totalTokens')
        actual = input_tokens is not None and output_tokens is not None
        if input_tokens is None:
            input_tokens = max(1, (total_tokens - estimate_tokens(answer_text)) if total_tokens else estimate_tokens(request_text))
        if output_tokens is None:
            output_tokens = max(1, (total_tokens - input_tokens) if total_tokens else estimate_tokens(answer_text))
        return {'input_tokens': input_tokens, 'output_tokens': output_tokens,
                'total_tokens': total_tokens or input_tokens + output_tokens, 'actual': actual}

    def _complete(self, messages, max_tokens, timeout=55):
        body = json.dumps({
            'modelUri': f'gpt://{self.folder_id}/{self.model}',
            'completionOptions': {'stream': False, 'temperature': 0.25, 'maxTokens': str(max_tokens)},
            'messages': messages,
        }, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(ENDPOINT, data=body, method='POST', headers={
            'Authorization': f'Api-Key {self.api_key}',
            'Content-Type': 'application/json',
        })
        try:
            with self.opener(request, timeout=timeout) as response:
                result = json.loads(response.read())
            text = result['result']['alternatives'][0]['message']['text'].strip()
            if not text:
                raise KeyError('empty')
            return text, self._usage(result, body.decode('utf-8'), text)
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise ValueError('YandexGPT отклонил ключ или доступ к каталогу.') from None
            if exc.code == 429:
                raise ValueError('Лимит YandexGPT исчерпан. Попробуйте позже.') from None
            raise ValueError(f'YandexGPT временно недоступен (ошибка {exc.code}).') from None
        except (urllib.error.URLError, TimeoutError):
            raise ValueError('Нет связи с YandexGPT. Проверьте интернет и повторите.') from None
        except (json.JSONDecodeError, KeyError, IndexError, TypeError):
            raise ValueError('YandexGPT вернул неполный ответ. Повторите запрос.') from None

    def create_plan(self, question, level):
        """Build one private solution plan; later hints can be served locally."""
        if not self.api_key or not self.folder_id:
            raise ValueError('Помощник не настроен. Добавьте ключ YandexGPT и ID каталога в parentai.env.')
        if not isinstance(question, str) or not question.strip() or len(question) > 4000:
            raise ValueError('Введите задание длиной до 4000 знаков.')
        if level not in LEVELS:
            raise ValueError('Неизвестный уровень объяснения.')
        messages = [
            {'role': 'system', 'text': (
                f'Ты доброжелательный школьный наставник. Уровень: {level}. '
                'Составь внутренний план помощи, но не обращайся к ребёнку и не добавляй Markdown. '
                'Верни только JSON-объект с полями: solution (внутреннее решение), hints (ровно 3 короткие '
                'последовательные подсказки без готового ответа, каждая до 170 знаков), control_questions '
                '(ровно 3 коротких вопроса), common_errors (массив коротких описаний), answer_criterion '
                '(критерий правильности), acceptable_answers (массив только однозначных кратких ответов, '
                'пустой если надёжная локальная проверка невозможна), final_explanation (объяснение по шагам '
                'после трёх подсказок, до 550 знаков). Не запрашивай и не включай личные данные.'
            )},
            {'role': 'user', 'text': question.strip()},
        ]
        text, usage = self._complete(messages, 850)
        def invalid(message):
            raise ProviderOutputError(message, usage)
        candidate = text.strip()
        if candidate.startswith('```'):
            candidate = candidate.split('\n', 1)[-1].rsplit('```', 1)[0].strip()
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            try:
                value = json.loads(candidate[candidate.index('{'):candidate.rindex('}') + 1])
            except (ValueError, json.JSONDecodeError):
                invalid('Помощник не смог подготовить план. Повторите запрос.')
        required = ('solution', 'hints', 'control_questions', 'common_errors',
                    'answer_criterion', 'acceptable_answers', 'final_explanation')
        if not isinstance(value, dict) or any(key not in value for key in required):
            invalid('Помощник вернул неполный план. Повторите запрос.')
        if not all(isinstance(value[key], str) for key in ('solution', 'answer_criterion', 'final_explanation')):
            invalid('Помощник вернул некорректный план. Повторите запрос.')
        for key in ('hints', 'control_questions', 'common_errors', 'acceptable_answers'):
            if not isinstance(value[key], list) or not all(isinstance(item, str) for item in value[key]):
                invalid('Помощник вернул некорректный план. Повторите запрос.')
        if len(value['hints']) < 3 or len(value['control_questions']) < 3:
            invalid('Помощник вернул слишком короткий план. Повторите запрос.')
        plan = {
            'solution': value['solution'][:4000],
            'hints': [item.strip()[:180] for item in value['hints'][:3]],
            'control_questions': [item.strip()[:160] for item in value['control_questions'][:3]],
            'common_errors': [item.strip()[:160] for item in value['common_errors'][:5]],
            'answer_criterion': value['answer_criterion'].strip()[:800],
            'acceptable_answers': [item.strip()[:120] for item in value['acceptable_answers'][:12] if item.strip()],
            'final_explanation': value['final_explanation'].strip()[:600],
        }
        return {'plan': plan, 'usage': usage}

    def answer(self, question, history, level, attempt=0):
        if not self.api_key or not self.folder_id:
            raise ValueError('Помощник не настроен. Добавьте ключ YandexGPT и ID каталога в parentai.env.')
        if not isinstance(question, str) or not question.strip() or len(question) > 4000:
            raise ValueError('Введите задание длиной до 4000 знаков.')
        if level not in LEVELS:
            raise ValueError('Неизвестный уровень объяснения.')
        if not isinstance(history, list) or len(history) > 12:
            raise ValueError('История диалога слишком длинная.')

        messages = [{'role': 'system', 'text': (
            f'Ты доброжелательный школьный наставник. Уровень: {level}. '
            'Помогай понять ход решения простыми словами. Сначала уточни условие, если данных не хватает. '
            'Объясняй по шагам, давай небольшую подсказку и вопрос для самостоятельного шага. '
            'Не выдавай себя за настоящего родителя. Не проси личные данные. '
            'Если не уверен в факте, прямо скажи об этом. Ответ — не более 1200 знаков.'
            f' Сейчас этап {min(attempt + 1, 4)}. '
            + ('Дай только одну маленькую подсказку и один наводящий вопрос, всего до 300 знаков. Не сообщай итоговый ответ, '
               'даже если ребёнок просит его. При повторной просьбе предложи другую подсказку. '
               if attempt < 3 else 'После трёх подсказок можно объяснить полное решение по шагам. ')
            + 'Если ребёнок предлагает решение, проверь его: при правильном ответе похвали за конкретный шаг; '
            'при ошибке мягко помоги найти её. Общайся тепло, без давления. Не используй Markdown: ответ будет озвучен.'
        )}]
        total = len(question)
        for item in history:
            if not isinstance(item, dict) or item.get('role') not in ('user', 'assistant'):
                raise ValueError('Некорректная история диалога.')
            text = item.get('text')
            if not isinstance(text, str) or len(text) > 4000:
                raise ValueError('Некорректная история диалога.')
            total += len(text)
            messages.append({'role': item['role'], 'text': text})
        if total > 12000:
            raise ValueError('Диалог получился слишком длинным. Нажмите «Новое задание».')
        messages.append({'role': 'user', 'text': question.strip()})

        text, usage = self._complete(messages, 180 if attempt < 3 else 450)
        return {'answer': text, 'usage': usage}
