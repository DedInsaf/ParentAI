import tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from learning import topic_for,plan_turn,answer_attempt
from usage import UsageStore

PLAN=dict(hints=['Первый шаг','Второй шаг','Третий шаг'],control_questions=['Вопрос 1?','Вопрос 2?','Вопрос 3?'],
          acceptable_answers=['12'],solution='12',final_explanation='Полный разбор: 12')
class AdaptiveTests(unittest.TestCase):
    def turn(self,state,text,correct=False,repeat=False,help_requested=False):
        return plan_turn(PLAN,state,text,correct,repeat=repeat,help_requested=help_requested)
    def test_repeat_and_questions_do_not_reveal_answer_or_consume_hint_steps(self):
        state={};self.turn(state,'Сколько 7+5?')
        for _ in range(8):
            answer,finished,_,_=self.turn(state,'Почему?',repeat=False)
            self.assertFalse(finished);self.assertEqual(state['hint_stage'],0);self.assertNotIn('12',answer)
            self.turn(state,'Повтори',repeat=True)
        self.assertEqual(state['repeats'],8);self.assertEqual(state['incorrect_attempts'],0)
    def test_wrong_answers_never_automatically_reveal_full_solution(self):
        state={};self.turn(state,'7+5')
        for _ in range(6):
            text,finished,_,_=self.turn(state,'13')
            self.assertFalse(finished);self.assertNotIn('12',text)
        self.assertEqual(state['hint_stage'],2);self.assertEqual(state['incorrect_attempts'],6)
        text,finished,solved,_=self.turn(state,'Помоги',help_requested=True)
        self.assertTrue(finished);self.assertFalse(solved);self.assertEqual(state['outcome'],'explained')
    def test_help_and_correct_answer_have_distinct_observable_outcomes(self):
        state={};self.turn(state,'7+5');self.turn(state,'12',correct=True)
        self.assertEqual(state['outcome'],'solved_light');self.assertEqual(state['answer_attempts'],1)
        state={};self.turn(state,'7+5');self.turn(state,'13');self.turn(state,'12',correct=True)
        self.assertEqual(state['outcome'],'solved_supported');self.assertEqual(state['incorrect_attempts'],1)
    def test_clarification_uses_the_current_steps_explanation_without_advancing(self):
        plan={**PLAN,'step_explanations':['Объяснение первого шага','Второго','Третьего']}
        state={};plan_turn(plan,state,'7+5',False)
        answer,finished,_,_=plan_turn(plan,state,'Почему?',False)
        self.assertIn('Объяснение первого шага',answer);self.assertFalse(finished)
        self.assertEqual(state['hint_stage'],0);self.assertEqual(state['incorrect_attempts'],0)

    def test_clarification_is_not_minimum_help_and_repeat_repeats_last_explanation(self):
        plan={**PLAN,'step_explanations':['Пояснение к первому шагу','Второму','Третьему']}
        state={};plan_turn(plan,state,'7+5',False)
        clarified=plan_turn(plan,state,'Почему?',False)[0]
        repeated=plan_turn(plan,state,'Повтори',False,repeat=True)[0]
        self.assertEqual(repeated,clarified);self.assertEqual(state['clarifications'],1)
        plan_turn(plan,state,'12',True);self.assertEqual(state['outcome'],'solved_supported')
        state={};self.turn(state,'7+5');self.turn(state,'Понятно');self.turn(state,'12',True)
        self.assertEqual(state['outcome'],'solved_light')

    def test_asr_punctuation_compound_numbers_and_uncertain_answers_are_attempts(self):
        for text in ['Тринадцать.','13.','13?','Сто двадцать три.','Я думаю, что тринадцать.', 'Минус пять!', 'У меня получилось тринадцать.']:
            self.assertTrue(answer_attempt(text),text)
        for text in ['Ответ','Я думаю','Минус','Плюс','-','Я думаю, что надо прибавить','Почему 13?']:
            self.assertFalse(answer_attempt(text),text)

    def test_gentle_mode_keeps_one_extra_check_on_the_same_step(self):
        state={'gentle':True};self.turn(state,'7+5');self.turn(state,'13')
        self.assertEqual(state['hint_stage'],0);self.turn(state,'14');self.assertEqual(state['hint_stage'],1)
    def test_only_answer_attempts_and_known_topic_tags_are_counted(self):
        for text in ['Почему 13?','Если получится 13, что дальше?','Как получить ответ?','Я читаю условие','Понятно']:
            self.assertFalse(answer_attempt(text),text)
        self.assertTrue(answer_attempt('13'));self.assertTrue(answer_attempt('Ответ двенадцать'))
        for text,code in [('7 плюс 5','addition'),('24 : 6','multiplication'),('x + 7 = 12','equations'),
                          ('1/2','fractions'),('10 процентов','percentages'),('Найди подлежащее','sentence')]:
            self.assertEqual(topic_for(text),code)
        self.assertEqual(topic_for('Меня зовут Иван'),'other')

class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.store=UsageStore(Path(self.tmp.name)/'usage.sqlite3')
    def tearDown(self):self.tmp.cleanup()
    def record(self,uid,key,outcome,topic='fractions',incorrect=0):
        self.store.ensure_lesson(uid,key)
        self.store.record_learning(uid,key,topic,dict(hint_stage=0,answer_attempts=1,incorrect_attempts=incorrect,repeats=0,outcome=outcome))
        self.store.finish_lesson(uid,key,outcome.startswith('solved'),bool(incorrect))
    def test_private_reports_survive_restart_and_recommend_only_from_real_evidence(self):
        self.record(1,'a','solved_light');self.record(1,'b','explained',incorrect=2)
        self.record(2,'private','explained',topic='geometry',incorrect=5)
        self.store.ensure_lesson(1,'old')
        progress=UsageStore(self.store.path).learning_progress(1)
        self.assertEqual(progress['tracked_tasks'],2);self.assertEqual(progress['untracked_tasks'],1)
        self.assertEqual([t['code'] for t in progress['topics']],['fractions'])
        self.assertEqual(progress['topics'][0]['incorrect_attempts'],2)
        self.assertEqual(progress['current_week']['completed'],2)
        self.assertEqual(progress['current_week']['light_support_percent'],50)
        self.assertFalse(progress['comparison_ready']);self.assertEqual(progress['recommendation']['topic'],'Дроби')
        self.store.delete_user_data(1);self.assertEqual(self.store.learning_progress(1)['tracked_tasks'],0)
        self.assertEqual(self.store.learning_progress(2)['tracked_tasks'],1)
    def test_repeated_persistence_is_idempotent_and_no_raw_questions_are_stored(self):
        self.record(1,'a','solved_supported',incorrect=2);self.record(1,'a','solved_supported',incorrect=2)
        self.assertEqual(self.store.learning_progress(1)['topics'][0]['incorrect_attempts'],2)
        with self.store._connect() as c:
            names={r[1] for r in c.execute('PRAGMA table_info(lessons)')}
        self.assertFalse({'question','answer','transcript','history'} & names)
    def test_small_or_empty_samples_do_not_claim_improvement(self):
        p=self.store.learning_progress(1);self.assertIsNone(p['recommendation']);self.assertFalse(p['comparison_ready'])
        self.assertIsNone(p['current_week']['light_support_percent'])


    def test_recommendation_recovers_after_two_light_solutions_not_just_task_switch(self):
        self.store.ensure_lesson(1,'abandoned')
        self.store.record_learning(1,'abandoned','geometry',dict(hint_stage=0,answer_attempts=0,incorrect_attempts=0,repeats=0))
        self.store.switch_lesson(1,'abandoned')
        self.assertIsNone(self.store.learning_progress(1)['recommendation'])
        self.record(1,'hard','explained',incorrect=2)
        self.assertEqual(self.store.learning_progress(1)['recommendation']['topic'],'Дроби')
        self.record(1,'practice-1','solved_light')
        self.assertIsNotNone(self.store.learning_progress(1)['recommendation'])
        self.record(1,'practice-2','solved_light')
        report=self.store.learning_progress(1)
        self.assertIsNone(report['recommendation'])
        topic=next(t for t in report['topics'] if t['code']=='fractions')
        self.assertFalse(topic['needs_practice']);self.assertEqual(topic['explained'],1)
        # Historical evidence remains visible without forcing stale recommendations.
        self.assertEqual(topic['incorrect_attempts'],2)

    def test_old_counters_without_clarification_events_are_not_reinterpreted(self):
        self.record(1,'legacy','solved_light')
        with self.store._connect() as c:c.execute("UPDATE lessons SET learning_version=1 WHERE id='legacy'")
        report=self.store.learning_progress(1)
        self.assertEqual(report['tracked_tasks'],0);self.assertEqual(report['untracked_tasks'],1)


    def test_new_active_difficulty_reopens_recommendation_after_recovery(self):
        self.record(1,'old','explained',incorrect=1)
        self.record(1,'clean-1','solved_light');self.record(1,'clean-2','solved_light')
        self.assertIsNone(self.store.learning_progress(1)['recommendation'])
        self.store.record_learning(1,'new-active','fractions',dict(hint_stage=1,answer_attempts=1,incorrect_attempts=1,repeats=0))
        self.assertEqual(self.store.learning_progress(1)['recommendation']['topic'],'Дроби')
