"""Format explicit spoken arithmetic; never guess operators from ordinary prose."""
from dataclasses import dataclass
from fractions import Fraction
import re

_ONES = {'ноль': 0, 'нуль': 0, 'один': 1, 'одна': 1, 'одно': 1, 'одну': 1,
         'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6,
         'семь': 7, 'восемь': 8, 'девять': 9}
_TEENS = dict(zip(('десять одиннадцать двенадцать тринадцать четырнадцать '
                  'пятнадцать шестнадцать семнадцать восемнадцать девятнадцать').split(), range(10, 20)))
_TENS = dict(zip('двадцать тридцать сорок пятьдесят шестьдесят семьдесят восемьдесят девяносто'.split(), range(20, 100, 10)))
_HUNDREDS = dict(zip('сто двести триста четыреста пятьсот шестьсот семьсот восемьсот девятьсот'.split(), range(100, 1000, 100)))
_NUMBERS = {**_ONES, **_TEENS, **_TENS, **_HUNDREDS, 'тысяча': 1000}
_DENOMINATORS = {'вторая': 2, 'вторую': 2, 'вторых': 2, 'третья': 3, 'третью': 3, 'третьих': 3,
                 'четвертая': 4, 'четвертую': 4, 'четвертых': 4,
                 'десятая': 10, 'десятую': 10, 'десятых': 10,
                 'сотая': 100, 'сотую': 100, 'сотых': 100,
                 'тысячная': 1000, 'тысячную': 1000, 'тысячных': 1000}
_WHOLE = {'целая', 'целых', 'целое', 'целые'}
_NUMBER_WORDS = set(_NUMBERS) | set(_DENOMINATORS) | _WHOLE
_VARIABLES = {'икс': 'x', 'игрек': 'y', 'зет': 'z', 'х': 'x',
              **{letter: letter for letter in 'xyzabc'}}
_OPERATORS = [(('плюс', '-', 'минус'), '±'), (('плюс', 'минус'), '±'),
              (('умножить', 'на'), '×'), (('разделить', 'на'), '÷'),
              (('поделить', 'на'), '÷'), (('делить', 'на'), '÷'),
              (('плюс',), '+'), (('минус',), '-'),
              (('равно',), '='), (('равняется',), '='), (('равен',), '='),
              (('равна',), '='), (('равны',), '=')]
_SYMBOLS = {'+': '+', '-': '-', '−': '-', '*': '×', '×': '×', '/': '/', '÷': '÷', '=': '='}
_TOKEN = re.compile(r'(?<!\w)\d+(?:[.,]\d+)?(?!\w)|\w+|[^\w\s]', re.UNICODE)
_DIGITS = re.compile(r'\d+(?:[.,]\d+)?\Z')
_MATH_CUE = re.compile(r'\b(?:ответ|число|пример|вычисли|посчитай|реши|уравнение|получилось|получается)\b', re.I)
_LANGUAGE_CUE = re.compile(r'\b(?:слово|слова|словами|термин|название|написание|фраза|фразу|фразы)\b', re.I)


def _integer(words):
    if not words or any(word not in _NUMBERS for word in words):
        return None
    if len(words) == 1:
        return _NUMBERS[words[0]]
    total = 0
    if words[0] in _HUNDREDS:
        total = _HUNDREDS[words[0]]
        words = words[1:]
    if len(words) == 1 and 0 < _NUMBERS[words[0]] < 100:
        return total + _NUMBERS[words[0]]
    if len(words) == 2 and words[0] in _TENS and 0 < _ONES.get(words[1], 0) < 10:
        return total + _TENS[words[0]] + _ONES[words[1]]
    return None


def _number(words):
    whole = 0
    marker = next((i for i, word in enumerate(words) if word in _WHOLE), None)
    if marker is not None:
        whole = _integer(words[:marker])
        if whole is None:
            return None
        words = words[marker + 1:]
    if words and words[-1] in _DENOMINATORS:
        numerator = _integer(words[:-1])
        if numerator is not None:
            denominator = _DENOMINATORS[words[-1]]
            if denominator in (10, 100, 1000):
                integer, tail = divmod(whole * denominator + numerator, denominator)
                fraction = str(tail).zfill(len(str(denominator)) - 1).rstrip('0')
                return str(integer) + (',' + fraction if fraction else '')
            value = whole + Fraction(numerator, denominator)
            return str(value.numerator) if value.denominator == 1 else f'({value.numerator} / {value.denominator})'
        return None
    return str(value) if marker is None and (value := _integer(words)) is not None else None


@dataclass
class _Expression:
    end: int
    text: str
    operation: bool = False
    word_sign: bool = False


def normalize_arithmetic(text):
    tokens = list(_TOKEN.finditer(text))
    values = [token.group().casefold().replace('ё', 'е') for token in tokens]

    def atom(index, depth=0):
        if index >= len(tokens) or depth > 8:
            return None
        word = values[index]
        if _DIGITS.fullmatch(word):
            return _Expression(index + 1, tokens[index].group())
        if word in _NUMBER_WORDS:
            end = index + 1
            while end < len(tokens) and values[end] in _NUMBER_WORDS:
                end += 1
            number = _number(values[index:end])
            return _Expression(end, number) if number is not None else None
        if word in _VARIABLES:
            variable = tokens[index].group() if word in 'xyzabc' else _VARIABLES[word]
            return _Expression(index + 1, variable)
        if word == '(':
            inner = expression(index + 1, depth + 1)
            if inner and inner.end < len(tokens) and values[inner.end] == ')':
                return _Expression(inner.end + 1, '(' + inner.text + ')', inner.operation, inner.word_sign)
        if word in ('минус', 'плюс', '-', '−', '+'):
            # Repeated spoken signs may be a stutter; do not invent a formula.
            if index + 1 < len(tokens) and values[index + 1] in ('минус', 'плюс', '-', '−', '+'):
                return None
            number = atom(index + 1, depth + 1)
            if number:
                return _Expression(number.end, ('-' if word in ('минус', '-', '−') else '+') + number.text,
                                   number.operation, word in ('минус', 'плюс') or number.word_sign)
        return None

    def expression(index, depth=0):
        left = atom(index, depth)
        if left is None:
            return None
        while left.end < len(tokens):
            position = left.end
            operator, end = _SYMBOLS.get(values[position]), position + 1
            if operator is None:
                for phrase, symbol in _OPERATORS:
                    if tuple(values[position:position + len(phrase)]) == phrase:
                        operator, end = symbol, position + len(phrase)
                        break
            if operator is None:
                break
            if (values[position] in ('плюс', 'минус') and operator != '±'
                    and end < len(tokens) and values[end] in ('плюс', 'минус')):
                break
            right = atom(end, depth + 1)
            if right is None:
                break
            left = _Expression(right.end, left.text + ' ' + operator + ' ' + right.text, True,
                               left.word_sign or right.word_sign)
        return left

    replacements = []
    index = 0
    while index < len(tokens):
        # Do not salvage the tail of an invalid spoken number or identifier.
        if (index and (values[index] in _NUMBER_WORDS or _DIGITS.fullmatch(values[index]))
                and (values[index - 1] in _NUMBER_WORDS or _DIGITS.fullmatch(values[index - 1]))):
            index += 1
            continue
        result = expression(index)
        if not result:
            index += 1
            continue
        start, end = tokens[index].start(), tokens[result.end - 1].end()
        prefix = re.split(r'[.!?;\n]', text[:start])[-1][-100:]
        whole_utterance = not text[:start].strip() and not text[end:].strip(' .!?')
        if (result.operation or result.word_sign and (whole_utterance or _MATH_CUE.search(prefix))) and not _LANGUAGE_CUE.search(prefix):
            replacements.append((start, end, result.text))
        index = max(index + 1, result.end)
    for start, end, value in reversed(replacements):
        text = text[:start] + value + text[end:]
    return text
