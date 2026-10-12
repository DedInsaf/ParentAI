"""Strict, zero-cost tutoring for tasks we can solve with deterministic arithmetic."""
from __future__ import annotations

import ast
from fractions import Fraction
import re


_SOCIAL = {
    "привет": "Привет! Я рядом. Покажи или напиши задачу, которую будем разбирать.",
    "здравствуй": "Здравствуй! Напиши условие задачи, и начнём с небольшой подсказки.",
    "здравствуйте": "Здравствуйте! Напишите условие задачи, и мы спокойно разберём её по шагам.",
    "спасибо": "Пожалуйста! Ты хорошо поработал. Если есть ещё задача, начинай новое задание.",
    "пока": "До встречи! Ты сегодня сделал важный шаг.",
    "ты тут": "Да, я рядом. Напиши условие задачи или расскажи, что не получается.",
    "помоги": "Конечно. Напиши всё условие задачи — числа, знаки и вопрос.",
    "помоги мне": "Конечно. Напиши всё условие задачи — числа, знаки и вопрос.",
}
_MATH_WORDS = ("посчитай", "вычисли", "сколько", "реши", "найди значение", "пример")
_WORD_EDGE = r"0-9a-zа-яё_"
_EQUATION = re.compile(
    rf"(?<![{_WORD_EDGE}])[0-9xх+\-*/().,\s:]+=[0-9xх+\-*/().,\s:]+(?![{_WORD_EDGE}])", re.I)
_EXPRESSION = re.compile(rf"(?<![{_WORD_EDGE}])[0-9+\-*/().,\s:]+(?![{_WORD_EDGE}])", re.I)


def _clean_phrase(value):
    if not isinstance(value, str):
        return ""
    value = re.sub(r"[^a-zа-яё0-9\s]", " ", (value or "").casefold())
    return " ".join(value.split())


def local_reply(question):
    """Return only exact, harmless conversational replies; never guess a school answer."""
    clean = _clean_phrase(question)
    return _SOCIAL.get(clean) if len(clean) <= 24 else None


def _syntax(value):
    value = value.casefold().replace("х", "x").replace("×", "*").replace("·", "*")
    value = value.replace("÷", "/").replace(":", "/").replace("−", "-").replace(",", ".")
    value = re.sub(r"\s+", "", value)
    value = re.sub(r"(?<=\d)(?=x)|(?<=x)(?=\d)|(?<=\))(?=[x\d])|(?<=[x\d])(?=\()", "*", value)
    return value


def _affine(node):
    """Evaluate an AST as a*x+b, rejecting nonlinear or unsafe syntax."""
    if isinstance(node, ast.Expression):
        return _affine(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return Fraction(str(node.value)), Fraction(0)
    if isinstance(node, ast.Name) and node.id == "x":
        return Fraction(0), Fraction(1)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        b, a = _affine(node.operand)
        sign = -1 if isinstance(node.op, ast.USub) else 1
        return b * sign, a * sign
    if not isinstance(node, ast.BinOp):
        raise ValueError("unsupported")
    lb, la = _affine(node.left)
    rb, ra = _affine(node.right)
    if isinstance(node.op, ast.Add):
        return lb + rb, la + ra
    if isinstance(node.op, ast.Sub):
        return lb - rb, la - ra
    if isinstance(node.op, ast.Mult):
        if la and ra:
            raise ValueError("nonlinear")
        return (lb * rb, la * rb) if not ra else (rb * lb, ra * lb)
    if isinstance(node.op, ast.Div):
        if ra or rb == 0:
            raise ValueError("variable denominator")
        return lb / rb, la / rb
    raise ValueError("unsupported")


def _parse_affine(value):
    value = _syntax(value)
    if not value or len(value) > 160 or "**" in value:
        raise ValueError("unsafe")
    tree = ast.parse(value, mode="eval")
    if sum(1 for _ in ast.walk(tree)) > 60:
        raise ValueError("too complex")
    result = _affine(tree)
    if any(abs(item) > 10 ** 9 for item in result):
        raise ValueError("too large")
    return result


def _format(value):
    if value.denominator == 1:
        return str(value.numerator)
    return f"{value.numerator}/{value.denominator}"


def _answers(value):
    fraction = _format(value)
    values = {fraction}
    if value.denominator != 1:
        decimal = float(value)
        if abs(decimal) <= 10 ** 9:
            values.add((f"{decimal:.8f}").rstrip("0").rstrip("."))
            values.add(fraction.replace("/", " / "))
    return sorted(values)


def _plan(solution, hints, questions, answers):
    return {
        "solution": solution,
        "hints": hints,
        "control_questions": questions,
        "common_errors": ["Изменили только одну часть равенства.", "Потеряли знак минус."],
        "answer_criterion": f"Ответ совпадает с {_format(answers)} и ход вычислений корректен.",
        "acceptable_answers": _answers(answers),
        "final_explanation": solution,
    }


def _equation_plan(question):
    matches = [item.group(0).strip() for item in _EQUATION.finditer(question)]
    if not matches:
        return None
    expression = max(matches, key=len)
    left, right = expression.split("=", 1)
    try:
        lb, la = _parse_affine(left)
        rb, ra = _parse_affine(right)
    except (SyntaxError, ValueError, ZeroDivisionError):
        return None
    coefficient, constant = la - ra, rb - lb
    if coefficient == 0:
        return None
    answer = constant / coefficient
    if abs(answer) > 10 ** 8:
        return None
    shown = _format(answer)
    solution = (
        f"Собираем выражения с x слева, числа справа: "
        f"{_format(coefficient)}·x = {_format(constant)}. "
        f"Делим обе части на {_format(coefficient)} и получаем x = {shown}. "
        f"Проверка подстановкой подтверждает равенство."
    )
    plan = _plan(solution, [
        "Собери все части с x по одну сторону равенства, а числа — по другую.",
        "После переноса приведи подобные слагаемые в каждой части.",
        "Теперь раздели обе части на коэффициент перед x и проверь результат подстановкой.",
    ], [
        "Какое действие нужно выполнить с обеими частями равенства первым?",
        "Какой коэффициент получился перед x?",
        "При подстановке левая и правая части совпали?",
    ], answer)
    plan["acceptable_answers"] += [f"x={shown}", f"х={shown}"]
    return plan


def _arithmetic_plan(question):
    clean = question.casefold().strip()
    if not any(word in clean for word in _MATH_WORDS):
        compact = re.sub(r"\s+", "", clean).strip("?.!=")
        if not re.fullmatch(r"[0-9+\-*/().,:×÷·−]+", compact):
            return None
    candidates = [item.group(0).strip() for item in _EXPRESSION.finditer(question)]
    candidates = [item for item in candidates if re.search(r"[+\-*/:×÷·]", item) and re.search(r"\d", item)]
    if not candidates:
        return None
    expression = max(candidates, key=len)
    try:
        constant, coefficient = _parse_affine(expression)
    except (SyntaxError, ValueError, ZeroDivisionError):
        return None
    if coefficient or abs(constant) > 10 ** 9:
        return None
    shown = _format(constant)
    solution = f"Соблюдаем порядок действий в выражении {expression.strip()}. Получается {shown}."
    return _plan(solution, [
        "Сначала найди действия в скобках, если они есть.",
        "Затем выполни умножение и деление слева направо.",
        "После этого выполни сложение и вычитание и проверь вычисления обратным действием.",
    ], [
        "Есть ли в примере скобки?",
        "Какое умножение или деление нужно выполнить раньше остальных действий?",
        "Как можно проверить получившийся результат?",
    ], constant)


def create_local_plan(question, level=None):
    """Return a plan only when deterministic parsing gives a high-confidence answer."""
    if not isinstance(question, str) or not question.strip() or len(question) > 4000:
        return None
    return _equation_plan(question) or _arithmetic_plan(question)


def emergency_plan():
    """Safe offline coaching for unsupported tasks; deliberately makes no factual claim."""
    return {
        "solution": "Точное решение не определялось локально.",
        "hints": [
            "Перепиши условие коротко: что уже известно и что требуется найти?",
            "Раздели задачу на один маленький шаг и выбери подходящее правило или действие.",
            "Запиши свой вариант решения и проверь каждый шаг обратным действием или по условию.",
        ],
        "control_questions": [
            "Что в условии известно точно?",
            "Какой один шаг можно сделать прямо сейчас?",
            "Все ли данные условия использованы при проверке?",
        ],
        "common_errors": [],
        "answer_criterion": "Без облачного помощника точный ответ не проверяется.",
        "acceptable_answers": [],
        "final_explanation": (
            "Сейчас облачный помощник недоступен, поэтому я не буду придумывать точный ответ. "
            "Сохрани своё решение и попроси взрослого проверить его или повтори позже."
        ),
    }
