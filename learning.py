"""Observable learning support, without storing children's questions or diagnosing ability."""
import re

# Stable local tags, never arbitrary model-generated text or personal details.
TOPICS = {
    'addition': ('Сложение и вычитание', 'Сколько будет 18 + 7?', 'Потренировать сложение и вычитание на коротком примере.'),
    'multiplication': ('Умножение и деление', 'Сколько будет 24 : 6?', 'Повторить связь умножения и деления.'),
    'fractions': ('Дроби', 'Сравни дроби 1/2 и 1/4.', 'Повторить дроби на простом примере.'),
    'percentages': ('Проценты', 'Найди 10 процентов от 80.', 'Разобрать нахождение части числа.'),
    'equations': ('Уравнения', 'Реши уравнение x + 7 = 12.', 'Повторить один шаг решения уравнения.'),
    'geometry': ('Геометрия', 'Найди периметр прямоугольника со сторонами 3 см и 5 см.', 'Повторить смысл формулы на небольшом примере.'),
    'spelling': ('Правописание', 'Как проверить безударную гласную в слове «леса»?', 'Повторить правило и подобрать проверочное слово.'),
    'sentence': ('Разбор предложения', 'Найди подлежащее в предложении «Мальчик читает книгу».', 'Разобрать короткое предложение по шагам.'),
    'reading': ('Работа с текстом', 'Как определить главную мысль короткого рассказа?', 'Потренироваться находить главную мысль текста.'),
    'other': ('Другие задания', '', 'Выбрать знакомое короткое задание и попробовать объяснить ход решения.'),
}


def topic_for(question):
    text = str(question).casefold().replace('ё', 'е')[:4000]
    patterns = (
        ('percentages', r'процент|%'), ('fractions', r'дроб|\d+\s*/\s*\d+'),
        ('equations', r'уравнен|\b[xyzх]\b.*=|\d+[xyzх].*='),
        ('geometry', r'периметр|площадь|треугольник|прямоугольник|радиус|окружност'),
        ('spelling', r'орфограм|безударн|проверочн|правопис|как\s+пишется'),
        ('sentence', r'подлежащ|сказуем|част[ьи]\s+речи|член[ыа]?\s+предложен'),
        ('reading', r'главн[а-я]*\s+мысл|пересказ|смысл\s+текст'),
        ('multiplication', r'умнож|раздел|подел|делени|\d+\s*[×*÷:]\s*\d+'),
        ('addition', r'прибав|выч[еи]т|сложен|слагаем|плюс|минус|\d+\s*[+−-]\s*\d+'),
    )
    return next((code for code, pattern in patterns if re.search(pattern, text)), 'other')


def answer_attempt(text):
    """Questions, requests and explanations must not become recorded errors."""
    text = ' '.join(text.casefold().replace('ё', 'е').split()).rstrip(' .!?;:')
    if '?' in text or re.search(r'\b(?:почему|как|какой|сколько|если|повтори|подскажи|понимаю)\b', text):
        return False
    explicit=re.match(r'^(?:(?:у меня )?(?:ответ|получилось)|я думаю)\b(.*)',text)
    if explicit:
        offered=explicit.group(1).strip(' ,:=—-')
        return bool(offered and len(text)<120 and len(offered.split())<=6 and
                    not re.search(r'\b(?:нужно|надо|прибавить|вычесть|разделить)\b',offered))
    if re.search(r'\bчто\b',text):
        return False
    if re.search(r'\d',text) and re.fullmatch(r'[-+−\d.,/()\s]+(?:\s*(?:см|м|кг|руб))?', text):
        return True
    from arithmetic_transcript import normalize_arithmetic
    normalized = normalize_arithmetic('Ответ ' + text)
    if normalized != 'Ответ ' + text and re.fullmatch(r'Ответ\s+[-+−\d.,/()\s]+', normalized):
        return True
    numbers = set(('ноль один одна одно одну два две три четыре пять шесть семь восемь девять '
                   'десять одиннадцать двенадцать тринадцать четырнадцать пятнадцать шестнадцать '
                   'семнадцать восемнадцать девятнадцать двадцать тридцать сорок пятьдесят шестьдесят '
                   'семьдесят восемьдесят девяносто сто двести триста четыреста пятьсот шестьсот '
                   'семьсот восемьсот девятьсот тысяча тысячи тысяч минус плюс целая целых целое '
                   'десятых сотых тысячных вторая треть четверть вторых третьих четвертых').split())
    return bool(text and all(word in numbers for word in text.split()) and
                any(word not in {'плюс','минус','целая','целых','целое'} for word in text.split()))



def plan_turn(plan, state, text, correct, *, repeat=False, help_requested=False):
    """Advance on evidence/request, never merely on the number of messages."""
    stage = state.setdefault('hint_stage', -1)
    state.setdefault('answer_attempts', 0); state.setdefault('incorrect_attempts', 0)
    state.setdefault('repeats', 0); state.setdefault('clarifications', 0); state['event'] = 'clarify'
    if stage >= 0 and correct:
        state['answer_attempts'] += 1; state['event'] = 'solved'
        state['outcome'] = 'solved_light' if stage == 0 and not state['incorrect_attempts'] and not state['clarifications'] else 'solved_supported'
        return ('Верно! Ответ правильный. Отличная работа! Переходим к новому заданию? '
                'Напиши или скажи его условие.'), True, True, False
    if stage >= 0 and repeat:
        state['repeats'] += 1; state['event'] = 'repeat'
        if state.get('last_reply'):
            return state['last_reply'], False, False, bool(state['incorrect_attempts'] or stage >= 2)
    elif stage < 0:
        stage = 0; state['event'] = 'hint'
    elif help_requested:
        if stage >= 2:
            state['event'] = 'explained'; state['outcome'] = 'explained'
            return plan['final_explanation'] or plan['solution'], True, False, True
        stage += 1; state['event'] = 'hint'
    elif answer_attempt(text) and plan.get('acceptable_answers'):
        state['answer_attempts'] += 1; state['incorrect_attempts'] += 1
        # With repeated difficulty, stay on this small step for one extra check.
        if not (state.get('gentle') and state['incorrect_attempts'] == 1):
            stage = min(stage + 1, 2)
        state['event'] = 'hint' if stage > state['hint_stage'] else 'check'
    if stage >= 0 and state['event']=='clarify':
        # Acknowledgements are not extra help; actual questions/explanations are.
        clean=text.casefold().replace('ё','е')
        if '?' in clean or re.search(r'\b(?:как|почему|что|объясни|уточни|означает)\b', clean):
            state['clarifications'] += 1
        else:
            state['event'] = 'acknowledge'
    state['hint_stage'] = stage
    hint = plan['hints'][stage].strip().rstrip(' ,;:')
    if hint and hint[-1] not in '.!?…': hint += '.'
    if state['event'] in ('clarify','check') and len(plan.get('step_explanations',[])) > stage:
        hint = plan['step_explanations'][stage].strip()
        if hint and hint[-1] not in '.!?…': hint += '.'
    prefix = 'Давай проверим этот шаг. ' if state['event'] == 'check' else ''
    reply=f"{prefix}{hint} {plan['control_questions'][stage].strip()}".strip()
    state['last_reply']=reply
    return reply, False, False, bool(state['incorrect_attempts'] or state['clarifications'] or stage >= 2)


def progress_report(rows, now):
    """Summarize only instrumented events; old records remain explicitly unknown."""
    tracked = [r for r in rows if r['learning_version'] == 2]
    topics = {}
    for row in tracked:
        code = row['topic_code'] if row['topic_code'] in TOPICS else 'other'
        item = topics.setdefault(code, dict(code=code, title=TOPICS[code][0], tasks=0, solved=0,
                   light_support=0, explained=0, switched=0, incorrect_attempts=0, clarifications=0, last_at=0))
        item['tasks'] += 1; item['last_at'] = max(item['last_at'], row['started_at'])
        item['solved'] += row['learning_outcome'] in ('solved_light', 'solved_supported')
        item['light_support'] += row['learning_outcome'] == 'solved_light'
        item['explained'] += row['learning_outcome'] == 'explained'
        item['switched'] += row['status'] == 'switched'
        item['incorrect_attempts'] += row['incorrect_attempts']
        item['clarifications'] += row['clarification_requests']
    for code,item in topics.items():
        recent=sorted((r for r in tracked if r['topic_code']==code),key=lambda r:r['started_at'],reverse=True)[:5]
        completed=[r for r in recent if r['learning_outcome'] in ('solved_light','solved_supported','explained')]
        evidence=[r for r in recent if r['learning_outcome'] in ('solved_light','solved_supported','explained')
                  or r['incorrect_attempts'] or r['clarification_requests']]
        recovered=len(evidence)>=2 and all(r['learning_outcome']=='solved_light' for r in evidence[:2])
        item['recent_completed']=len(completed)
        item['recent_explanations']=sum(r['learning_outcome']=='explained' for r in completed)
        item['needs_practice']=not recovered and any(r['incorrect_attempts'] or r['clarification_requests'] or
            r['learning_outcome'] in ('solved_supported','explained') for r in recent)
    topics = sorted(topics.values(), key=lambda r: (-r['last_at'], r['code']))
    def window(lo, hi):
        finished = [r for r in tracked if lo <= r['updated_at'] < hi and r['learning_outcome'] in ('solved_light','solved_supported','explained')]
        light = sum(r['learning_outcome'] == 'solved_light' for r in finished)
        return dict(completed=len(finished),light_support=light,
                    light_support_percent=round(100*light/len(finished)) if finished else None)
    current = window(now-7*86400, now+1); previous = window(now-14*86400, now-7*86400)
    eligible = [t for t in topics if t['needs_practice']]
    priority = max(eligible, key=lambda t:(t['recent_explanations'],t['last_at'],t['incorrect_attempts']),default=None)
    recommendation = None
    if priority:
        code=priority['code']; recommendation=dict(topic=priority['title'],text=TOPICS[code][2],question=TOPICS[code][1])
    return dict(tracked_tasks=len(tracked),untracked_tasks=len(rows)-len(tracked),topics=topics[:10],
                current_week=current,previous_week=previous,recommendation=recommendation,
                comparison_ready=current['completed']>=3 and previous['completed']>=3,
                note='Минимум помощи: ответ совпал с планом после первой подсказки, без дополнительных объяснений и зафиксированных ошибок. Это не оценка знаний и не подтверждение работы без помощи взрослых.')
