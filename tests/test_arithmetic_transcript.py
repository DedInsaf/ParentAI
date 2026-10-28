import unittest
from arithmetic_transcript import normalize_arithmetic
from transcripts import validated_transcript
from dialogue import _answers_match


class ArithmeticTranscriptTests(unittest.TestCase):
    def test_symbols_are_not_removed_to_make_a_different_numeric_answer(self):
        for answer, wrong in [('2 × 3', '23'), ('12 ÷ 3', '123'), ('2 ± 3', '23'),
                              ('50%', '50'), ('(2)(3)', '23'), ('2:3', '23'), ('2 > 3', '23')]:
            with self.subTest(answer=answer):
                self.assertFalse(_answers_match(answer, [wrong]))
        self.assertTrue(_answers_match('2 × 3', ['2*3']))
        self.assertTrue(_answers_match('12 ÷ 3', ['12/3']))
        self.assertTrue(_answers_match('(5)', ['5']))

    def test_explicit_arithmetic_is_formatted_without_solving_or_correcting_it(self):
        cases = {
            'Сколько будет семь плюс пять?': 'Сколько будет 7 + 5?',
            'Девять минус четыре': '9 - 4',
            '2 умножить на 3 равно 6': '2 × 3 = 6',
            'Двенадцать разделить на три': '12 ÷ 3',
            '8 поделить на 2': '8 ÷ 2',
            'Десять делить на пять': '10 ÷ 5',
            'Два плюс два равно пять': '2 + 2 = 5',
            '10 разделить на 0': '10 ÷ 0',
            '7 ПЛЮС 5': '7 + 5',
        }
        for spoken, expected in cases.items():
            with self.subTest(spoken=spoken):
                self.assertEqual(validated_transcript(spoken), expected)

    def test_chains_brackets_decimals_and_variables(self):
        cases = {
            'Сколько будет (два плюс три) умножить на четыре?': 'Сколько будет (2 + 3) × 4?',
            'два плюс (три минус один)': '2 + (3 - 1)',
            '2,5 плюс 3,1': '2,5 + 3,1',
            'икс плюс три равно семь': 'x + 3 = 7',
            'x умножить на y': 'x × y',
            'A плюс B равно C': 'A + B = C',
            'двадцать три плюс сто пять': '23 + 105',
            'одна вторая плюс одна третья': '(1 / 2) + (1 / 3)',
            'одна вторая разделить на одну третью': '(1 / 2) ÷ (1 / 3)',
            'два целых пять десятых минус один': '2,5 - 1',
            'два плюс минус три': '2 ± 3',
        }
        for spoken, expected in cases.items():
            with self.subTest(spoken=spoken):
                self.assertEqual(normalize_arithmetic(spoken), expected)
                self.assertEqual(normalize_arithmetic(expected), expected)

    def test_unary_signs_require_a_number_answer_or_explicit_calculation(self):
        for spoken, expected in [('Минус пять', '-5'), ('Ответ минус пять.', 'Ответ -5.'),
                                  ('Число плюс три', 'Число +3'),
                                  ('минус пять плюс два', '-5 + 2')]:
            with self.subTest(spoken=spoken):
                self.assertEqual(normalize_arithmetic(spoken), expected)
        self.assertTrue(_answers_match(validated_transcript('Ответ минус пять'), ['-5']))
        self.assertFalse(_answers_match(validated_transcript('Ответ минус пять'), ['5']))
        self.assertTrue(_answers_match(validated_transcript('Ответ минус одна вторая'), ['-0,5']))

    def test_ordinary_words_are_not_math_operators(self):
        cases = [
            'Это плюс такого способа, а это его минус.',
            'У этого решения есть плюс и минус',
            'Плюс пять полезных советов',
            'Минус пять лишних вещей',
            'На улице минус пять градусов',
            'Завтра будет плюс три градуса',
            'Я хочу разделить на группы учеников',
            'Два ученика хотят разделить на группы класс',
            'Мы хотим умножить на практике пользу занятий',
            'Мне всё равно, какой пример решать',
            'Пять плюсов и три минуса',
            'Скажи слово плюс',
            'В слове минус пять букв',
            'Напиши словами два плюс три',
            'Объясни фразу два плюс три',
            'Один два три четыре пять',
        ]
        for text in cases:
            with self.subTest(text=text):
                self.assertEqual(validated_transcript(text), text)

    def test_misheard_and_incomplete_expressions_are_not_guessed(self):
        for text in ['два плюш три', 'два минусы три', 'два умножить три',
                     'пять разделить задачи', '7 плюс', 'плюс', 'икс минус',
                     'один два плюс три', 'двадцать тридцать минус пять',
                     '1 2 плюс 3', 'два плюс плюс три', 'семь минус минус два',
                     '1e3 плюс 4', 'abc2 плюс 3', 'два на три']:
            with self.subTest(text=text):
                self.assertEqual(normalize_arithmetic(text), text)

    def test_punctuation_surrounding_text_and_existing_formulas_are_kept(self):
        self.assertEqual(normalize_arithmetic('Помоги: 7 плюс 5. Потом 9 минус 4!'),
                         'Помоги: 7 + 5. Потом 9 - 4!')
        self.assertEqual(normalize_arithmetic('Сколько будет 2 + 3?'), 'Сколько будет 2 + 3?')
        text = 'Сколько будет (два плюс три) умножить на четыре?'
        once = normalize_arithmetic(text)
        self.assertEqual(normalize_arithmetic(once), once)
