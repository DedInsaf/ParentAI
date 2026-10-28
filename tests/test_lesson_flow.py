from pathlib import Path
import tempfile
import unittest
from dialogue import Dialogues
from runtime import Runtime
from usage import UsageStore
from test_dialogue import recording


class PlanTutor:
    model = 'test'
    def __init__(self):
        self.questions = []
    def public_status(self):
        return {'enabled': True}
    def create_plan(self, question, level):
        self.questions.append(question)
        answer = '12' if len(self.questions) == 1 else '5'
        return {'plan': {'solution': answer, 'hints': ['Подумай.'] * 3,
                         'control_questions': ['Какой ответ?'] * 3,
                         'answer_criterion': 'Ответ ' + answer, 'acceptable_answers': [answer],
                         'final_explanation': 'Разберём решение. Ответ ' + answer + '.',
                         'common_errors': []}, 'usage': {}}


class TestVoice:
    def synthesize(self, text, path):
        Path(path).write_bytes(recording())
        return {'blocks': 1, 'duration_ms': 1000}


class LessonFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = Runtime(self.temp.name)
        self.usage = UsageStore(Path(self.temp.name) / 'usage.sqlite3')
        self.usage.set_subscription(1, 'paid')
        self.study = self.usage.start_study_session(1)['id']
        self.tutor = PlanTutor()
        self.manager = Dialogues(self.runtime, self.tutor, TestVoice(), self.usage)
    def tearDown(self):
        self.manager.close(); self.runtime.close(); self.temp.cleanup()
    def turn(self, text, session=None, **options):
        # Isolate the conversation from the unrelated per-minute abuse timer.
        self.manager.recent[1].clear()
        start = self.manager.start(text, 'начальная школа', session, voice='yandex',
                                   user_id=1, study_session=self.study, **options)
        if start.get('switch_required'):
            return start, None
        self.manager.jobs[start['id']]['thread'].join(2)
        result = self.manager.snapshot(start['id'])
        self.assertEqual(result['state'], 'done')
        return start, result

    def test_two_tasks_count_correct_answers_and_play_new_audio_without_old_context(self):
        first, hint = self.turn('Сколько будет семь плюс пять?')
        wrong, result = self.turn('Тринадцать', first['session'])
        self.assertFalse(result['finished']); self.assertFalse(result['solved'])
        correct, result = self.turn('Ответ двенадцать', first['session'])
        self.assertTrue(result['finished']); self.assertTrue(result['solved'])
        self.assertTrue(result['cues']); self.assertTrue(self.manager.audio(correct['id']).is_file())
        second, result = self.turn('Сколько будет девять минус четыре?', first['session'])
        self.assertNotEqual(second['session'], first['session'])
        self.assertFalse(result['finished'])
        solved, result = self.turn('Пять', second['session'])
        self.assertTrue(result['solved']); self.assertTrue(result['finished'])
        report = self.usage.dashboard(1)['report']
        self.assertEqual(report['assignments'], 2)
        self.assertEqual(report['solved_independently'], 2)
        self.assertEqual(len(self.tutor.questions), 2)

    def test_explaining_the_solution_finishes_without_credit_for_a_correct_answer(self):
        first, _ = self.turn('Сколько будет семь плюс пять?')
        for _ in range(3):
            _, result = self.turn('Не знаю', first['session'])
        self.assertTrue(result['finished']); self.assertFalse(result['solved'])
        self.assertEqual(self.usage.dashboard(1)['report']['solved_independently'], 0)

    def test_unfinished_spoken_task_requires_choice_and_resets_plan_after_confirmation(self):
        first, _ = self.turn('Сколько будет семь плюс пять?')
        choice, _ = self.turn('Сколько будет девять минус четыре?', first['session'])
        self.assertTrue(choice['switch_required']); self.assertEqual(len(self.tutor.questions), 1)
        second, result = self.turn('Сколько будет девять минус четыре?', first['session'], switch_action='new')
        self.assertNotEqual(second['session'], first['session'])
        self.assertEqual(len(self.tutor.questions), 2)
        self.assertEqual(self.usage.dashboard(1)['report']['assignments'], 2)
        self.assertEqual(self.usage.dashboard(1)['report']['solved_independently'], 0)
