import unittest

from local_tutor import create_local_plan, emergency_plan, local_reply


class LocalTutorTests(unittest.TestCase):
    def test_solves_linear_equations_without_guessing_nonlinear_tasks(self):
        plan = create_local_plan('Реши уравнение 2x + 3 = 11', 'средняя школа')
        self.assertIn('4', plan['acceptable_answers'])
        self.assertIn('x=4', plan['acceptable_answers'])
        self.assertNotIn('x = 4', plan['hints'][0])
        self.assertIsNone(create_local_plan('Реши x*x = 16', 'средняя школа'))
        self.assertIsNone(create_local_plan('Докажи теорему Пифагора', 'средняя школа'))

    def test_solves_safe_arithmetic_and_rejects_numbers_inside_word_problem(self):
        plan = create_local_plan('Вычисли (12 + 8) : 4', 'начальная школа')
        self.assertIn('5', plan['acceptable_answers'])
        self.assertIsNone(create_local_plan(
            'У Маши было 12 яблок, она отдала 4. Почему ответ такой?', 'начальная школа'))
        self.assertIsNone(create_local_plan('__import__("os")', 'средняя школа'))
        self.assertIsNone(create_local_plan('Вычисли 1e2+3', 'средняя школа'))

    def test_conversation_and_outage_plan_never_claim_an_unverified_answer(self):
        self.assertIn('условие', local_reply('Помоги').casefold())
        self.assertIsNone(local_reply(123))
        self.assertIsNone(local_reply('Помоги решить 2x+3=11'))
        fallback = emergency_plan()
        self.assertEqual(fallback['acceptable_answers'], [])
        self.assertIn('не буду придумывать', fallback['final_explanation'])


if __name__ == '__main__':
    unittest.main()
