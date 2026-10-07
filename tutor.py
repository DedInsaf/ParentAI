"""Small, server-side YandexGPT client for homework help."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


ENDPOINT = 'https://ai.api.cloud.yandex.net/foundationModels/v1/completion'
LEVELS = {'начальная школа', 'средняя школа', 'старшая школа'}


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
        if key in {'YANDEX_API_KEY', 'YANDEX_FOLDER_ID', 'PARENTAI_TUTOR_MODEL', 'YANDEX_SPEECHKIT_API_KEY', 'YANDEX_TTS_API_KEY', 'PARENTAI_VOICE_DEVICE'}:
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

        body = json.dumps({
            'modelUri': f'gpt://{self.folder_id}/{self.model}',
            'completionOptions': {'stream': False, 'temperature': 0.35, 'maxTokens': '180' if attempt<3 else '450'},
            'messages': messages,
        }, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(ENDPOINT, data=body, method='POST', headers={
            'Authorization': f'Api-Key {self.api_key}',
            'Content-Type': 'application/json',
        })
        try:
            with self.opener(request, timeout=55) as response:
                result = json.loads(response.read())
            text = result['result']['alternatives'][0]['message']['text'].strip()
            usage = result['result'].get('usage', {})
            if not text:
                raise KeyError('empty')
            return {'answer': text, 'usage': {'total_tokens': usage.get('totalTokens')}}
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
