import unittest
from dialogue import _answers_match, _looks_like_new_task


class LessonAnswerTests(unittest.TestCase):
    def test_minus_in_a_numeric_answer_is_not_removed_as_a_separator(self):
        for offered in ['Ответ -5', 'Ответ: -5', 'Ответ - 5', 'Равно -5', 'x равно -5',
                        'Ответ - пять', 'x равно - пять']:
            with self.subTest(offered=offered):
                self.assertTrue(_answers_match(offered, ['-5']))
                self.assertFalse(_answers_match(offered, ['5']))
        self.assertTrue(_answers_match('Ответ — 5', ['5']))

    def test_spoken_numbers_follow_grammar_instead_of_summing_any_words(self):
        for offered, accepted in [('один два', '3'), ('двадцать тридцать', '50'),
                                  ('сто сто', '200'), ('один ноль', '1')]:
            with self.subTest(offered=offered):
                self.assertFalse(_answers_match(offered, [accepted]))
        for offered, accepted in [('Ответ двенадцать', '12'), ('двадцать три', '23'),
                                  ('сто двадцать три', '123'), ('двести пять', '205'),
                                  ('минус сорок два', '-42'), ('ноль', '0'),
                                  ('одна целая двадцать пять сотых', '1.25'),
                                  ('Икс равен четырем', 'x=4')]:
            with self.subTest(offered=offered):
                self.assertTrue(_answers_match(offered, [accepted]))

    def test_spoken_length_and_money_answers_keep_their_units(self):
        for offered, accepted in [('Ответ два метра', '2 м'),
                                  ('Это будет двенадцать рублей', '12 рублей'),
                                  ('Получилось двадцать пять копеек', '25 коп')]:
            with self.subTest(offered=offered):
                self.assertTrue(_answers_match(offered, [accepted]))
        self.assertFalse(_answers_match('два метра', ['2 см']))
        self.assertFalse(_answers_match('двенадцать рублей', ['12 коп']))

    def test_a_new_spoken_task_can_contain_numbers_as_words(self):
        session = {'plan': {'solution': '12'}, 'attempt': 1}
        for question in ['Сколько будет девять минус четыре?',
                         'Помоги решить пример семь плюс пять',
                         'Вычисли сорок два разделить на шесть']:
            with self.subTest(question=question):
                self.assertTrue(_looks_like_new_task(question, session))
        for answer in ['У меня получилось двенадцать', 'Ответ двадцать три',
                       'Почему здесь прибавляется два?', 'Повтори ещё раз']:
            with self.subTest(answer=answer):
                self.assertFalse(_looks_like_new_task(answer, session))
