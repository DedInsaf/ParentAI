import sqlite3
import tempfile
import time
import unittest

from usage import BillingConfig, LimitExceeded, UsageStore, rubles_to_micros


def config(assignments=2, llm=2, tts=2, cost='10'):
    return BillingConfig({
        'currency': 'RUB', 'warning_ratio': '0.80',
        'prices': {
            'llm_input_per_1000_tokens': '0.20',
            'llm_output_per_1000_tokens': '0.20',
            'stt_per_15_seconds': '0.1626',
            'tts_v3_per_250_chars': '0.1626',
        },
        'plans': {
            'free': {'title': 'Free', 'monthly_price_rubles': 0, 'sessions': assignments,
                     'session_minutes': 20, 'assignments_per_session': assignments,
                     'yandex_voice_per_session': tts, 'assignments': assignments,
                     'llm_requests': llm, 'stt_billed_seconds': 30, 'tts_blocks': tts,
                     'external_cost_rubles': cost},
            'paid': {'title': 'Paid', 'monthly_price_rubles': 299, 'sessions': 100,
                     'session_minutes': 30, 'assignments_per_session': 10,
                     'yandex_voice_per_session': 100, 'assignments': 100,
                     'llm_requests': 100, 'stt_billed_seconds': 1000, 'tts_blocks': 100,
                     'external_cost_rubles': '85'},
            'ultra': {'title': 'Ultra', 'monthly_price_rubles': 599, 'sessions': 200,
                      'session_minutes': 45, 'assignments_per_session': 20,
                      'yandex_voice_per_session': 200, 'assignments': 200,
                      'llm_requests': 200, 'stt_billed_seconds': 2000, 'tts_blocks': 200,
                      'external_cost_rubles': '170'},
        },
    })


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = UsageStore(self.temp.name + '/usage.sqlite3', config())

    def test_exact_costs_limits_and_duplicate_reservation(self):
        self.assertEqual(self.store.config.llm_cost(1000, 500), rubles_to_micros('0.30'))
        self.assertEqual(self.store.config.stt_cost(15), rubles_to_micros('0.1626'))
        first = self.store.reserve(7, 'llm', 'request-001', lesson_id='lesson-1', new_lesson=True,
                                   estimated_cost=self.store.config.llm_cost(100, 100))
        duplicate = self.store.reserve(7, 'llm', 'request-001', lesson_id='lesson-1', new_lesson=True)
        self.assertTrue(duplicate['duplicate'])
        self.store.complete(first['id'], input_units=80, output_units=20,
                            cost=self.store.config.llm_cost(80, 20), actual_usage=True)
        second = self.store.reserve(7, 'llm', 'request-002', lesson_id='lesson-2', new_lesson=True,
                                    estimated_cost=self.store.config.llm_cost(100, 100))
        self.store.complete(second['id'], input_units=100, output_units=100,
                            cost=self.store.config.llm_cost(100, 100))
        with self.assertRaises(LimitExceeded):
            self.store.reserve(7, 'llm', 'request-003', lesson_id='lesson-3', new_lesson=True,
                               estimated_cost=self.store.config.llm_cost(100, 100))
        summary = self.store.dashboard(7)
        self.assertEqual(summary['report']['assignments'], 2)
        self.assertEqual(summary['usage']['llm_requests'], 2)
        self.assertEqual(summary['remaining']['assignments'], 0)

    def test_reports_only_aggregates_and_percentiles(self):
        event = self.store.reserve(3, 'stt', 'speech-001', duration_ms=4100, billed_units=15,
                                   estimated_cost=self.store.config.stt_cost(15), provider='Yandex SpeechKit')
        self.store.complete(event['id'], duration_ms=4100, billed_units=15,
                            cost=self.store.config.stt_cost(15), actual_usage=True)
        self.store.ensure_lesson(3, 'lesson-a')
        self.store.lesson_hint(3, 'lesson-a', difficult=True)
        self.store.finish_lesson(3, 'lesson-a', solved_independently=False, difficult=True)
        report = self.store.dashboard(3)
        self.assertEqual(report['report']['hints'], 1)
        self.assertEqual(report['report']['difficult'], 1)
        self.assertEqual(self.store.cost_metrics()['active_users'], 1)
        with sqlite3.connect(self.store.path) as connection:
            columns = {row[1] for row in connection.execute('PRAGMA table_info(usage_events)')}
        self.assertFalse({'prompt', 'transcript', 'audio', 'photo'} & columns)

    def test_restart_releases_interrupted_usage_reservations(self):
        event = self.store.reserve(4, 'stt', 'interrupted-speech', duration_ms=3000,
                                   billed_units=15, estimated_cost=self.store.config.stt_cost(15))
        self.assertEqual(self.store.dashboard(4)['usage']['stt_billed_seconds'], 15)
        self.assertEqual(self.store.recover_interrupted_events(), 1)
        self.assertEqual(self.store.dashboard(4)['usage']['stt_billed_seconds'], 0)
        with sqlite3.connect(self.store.path) as connection:
            state = connection.execute('SELECT state FROM usage_events WHERE id=?', (event['id'],)).fetchone()[0]
        self.assertEqual(state, 'failed')

    def test_admin_bypasses_limits_but_cost_is_still_recorded(self):
        for index in range(4):
            event = self.store.reserve(
                9, 'llm', f'admin-{index}', lesson_id=f'lesson-{index}', new_lesson=True,
                estimated_cost=self.store.config.llm_cost(100, 100), bypass_limits=True)
            self.store.complete(event['id'], input_units=100, output_units=100,
                                cost=self.store.config.llm_cost(100, 100), actual_usage=True)
        report = self.store.dashboard(9, unlimited=True)
        self.assertTrue(report['plan']['unlimited'])
        self.assertIsNone(report['remaining']['assignments'])
        self.assertEqual(report['usage']['llm_requests'], 4)
        self.assertNotEqual(report['usage']['external_cost_rubles'], '0.0000')

    def test_confirmed_platega_callback_activates_paid_plan(self):
        provider_id = '11111111-1111-4111-8111-111111111111'
        redirect = 'https://pay.platega.io/subscription/11111111'
        self.store.record_checkout(12, provider_id, redirect, 299)
        self.assertEqual(self.store.pending_checkout(12)['redirect_url'], redirect)
        self.assertEqual(self.store.subscription(12)['plan'], 'free')
        self.store.payment_callback(provider_id, 'CONFIRMED', 299, 'RUB')
        self.assertEqual(self.store.subscription(12)['plan'], 'paid')
        self.store.payment_callback(provider_id, 'SUBSCRIPTION_CANCELLED', 299, 'RUB')
        self.assertEqual(self.store.subscription(12)['plan'], 'free')
        self.store.payment_callback(provider_id, 'CONFIRMED', 299, 'RUB')
        self.store.payment_callback(provider_id, 'SUBSCRIPTION_CANCELED', 299, 'RUB')
        self.assertEqual(self.store.subscription(12)['plan'], 'free')
        with self.assertRaisesRegex(ValueError, 'Сумма'):
            self.store.payment_callback(provider_id, 'CONFIRMED', 300, 'RUB')

    def test_timed_session_groups_tasks_and_applies_voice_limit(self):
        study = self.store.start_study_session(21)
        self.assertEqual(study['limit_seconds'], 20 * 60)
        for index in range(2):
            event = self.store.reserve(
                21, 'llm', f'plan-{index}', lesson_id=f'lesson-{index}',
                study_session_id=study['id'], new_lesson=True,
                estimated_cost=self.store.config.llm_cost(10, 10))
            self.store.complete(event['id'], cost=0)
        report = self.store.dashboard(21)
        self.assertEqual(report['usage']['sessions'], 1)
        self.assertEqual(report['usage']['assignments'], 2)
        for index in range(2):
            event = self.store.reserve(
                21, 'tts', f'voice-{index}', lesson_id='lesson-0',
                study_session_id=study['id'], billed_units=1, estimated_cost=0)
            self.store.complete(event['id'], billed_units=1, cost=0)
        with self.assertRaises(LimitExceeded):
            self.store.reserve(21, 'tts', 'voice-over', lesson_id='lesson-0',
                               study_session_id=study['id'], billed_units=1, estimated_cost=0)
        paused = self.store.control_study_session(21, study['id'], 'pause')
        self.assertEqual(paused['status'], 'paused')
        resumed = self.store.control_study_session(21, study['id'], 'resume')
        self.assertEqual(resumed['status'], 'active')

    def test_every_plan_has_its_own_enforced_session_duration(self):
        for user_id, plan, minutes in ((41, 'free', 20), (42, 'paid', 30), (43, 'ultra', 45)):
            with self.subTest(plan=plan):
                self.store.set_subscription(user_id, plan)
                study = self.store.start_study_session(user_id)
                self.assertEqual(study['status'], 'active')
                self.assertEqual(study['elapsed_seconds'], 0)
                self.assertEqual(study['limit_seconds'], minutes * 60)
                with sqlite3.connect(self.store.path) as connection:
                    connection.execute(
                        'UPDATE study_sessions SET active_started_at=? WHERE id=?',
                        (int(time.time()) - minutes * 60, study['id']))
                with self.assertRaisesRegex(LimitExceeded, 'Время занятия закончилось'):
                    self.store.validate_study_session(user_id, study['id'])

    def test_admin_session_is_not_time_limited(self):
        study = self.store.start_study_session(44, unlimited=True)
        self.assertIsNone(study['limit_seconds'])
        with sqlite3.connect(self.store.path) as connection:
            connection.execute(
                'UPDATE study_sessions SET active_started_at=? WHERE id=?',
                (int(time.time()) - 24 * 60 * 60, study['id']))
        self.assertIsNone(self.store.validate_study_session(44, study['id'], unlimited=True)['limit_seconds'])

    def test_monthly_session_limit_is_rejected_before_empty_session_is_created(self):
        for index in range(2):
            study = self.store.start_study_session(45)
            event = self.store.reserve(
                45, 'llm', f'monthly-session-{index}', lesson_id=f'monthly-lesson-{index}',
                study_session_id=study['id'], new_lesson=True, estimated_cost=0)
            self.store.complete(event['id'], cost=0)
            self.store.control_study_session(45, study['id'], 'stop')
        with self.assertRaisesRegex(LimitExceeded, 'Лимит занятий'):
            self.store.start_study_session(45)

    def test_completed_session_cannot_be_resumed(self):
        study = self.store.start_study_session(46)
        self.store.control_study_session(46, study['id'], 'stop')
        with self.assertRaisesRegex(ValueError, 'уже завершено'):
            self.store.control_study_session(46, study['id'], 'resume')
        stopped = self.store.control_study_session(46, study['id'], 'stop')
        self.assertEqual(stopped['status'], 'complete')

    def test_page_reload_restores_current_session_without_spending_another_slot(self):
        study = self.store.start_study_session(47)
        event = self.store.reserve(
            47, 'llm', 'reload-task', lesson_id='reload-lesson',
            study_session_id=study['id'], new_lesson=True, estimated_cost=0)
        self.store.complete(event['id'], cost=0)
        paused = self.store.control_study_session(47, study['id'], 'pause')
        restored = self.store.start_study_session(47)
        self.assertEqual(restored['id'], study['id'])
        self.assertTrue(restored['restored'])
        self.assertEqual(restored['status'], 'active')
        self.assertEqual(self.store.dashboard(47)['usage']['sessions'], 1)

    def test_expired_session_is_completed_and_replaced(self):
        self.store.set_subscription(48, 'paid')
        study = self.store.start_study_session(48)
        with sqlite3.connect(self.store.path) as connection:
            connection.execute(
                'UPDATE study_sessions SET active_started_at=? WHERE id=?',
                (int(time.time()) - 31 * 60, study['id']))
        replacement = self.store.start_study_session(48)
        self.assertNotEqual(replacement['id'], study['id'])
        self.assertFalse(replacement['restored'])
        with sqlite3.connect(self.store.path) as connection:
            status = connection.execute(
                'SELECT status FROM study_sessions WHERE id=?', (study['id'],)).fetchone()[0]
        self.assertEqual(status, 'complete')

    def test_real_plan_session_and_assignment_boundaries(self):
        product = UsageStore(self.temp.name + '/product.sqlite3', BillingConfig.load())
        for user_id, plan in ((51, 'free'), (52, 'paid'), (53, 'ultra')):
            limits = product.config.plan(plan)
            product.set_subscription(user_id, plan)
            for session_index in range(limits['sessions']):
                study = product.start_study_session(user_id)
                for task_index in range(limits['assignments_per_session']):
                    event = product.reserve(
                        user_id, 'llm', f'{plan}-{session_index}-{task_index}',
                        lesson_id=f'{plan}-lesson-{session_index}-{task_index}',
                        study_session_id=study['id'], new_lesson=True, estimated_cost=0)
                    product.complete(event['id'], cost=0)
                if session_index == 0:
                    with self.assertRaisesRegex(LimitExceeded, 'максимум новых задач'):
                        product.reserve(
                            user_id, 'llm', f'{plan}-too-many',
                            lesson_id=f'{plan}-lesson-too-many',
                            study_session_id=study['id'], new_lesson=True, estimated_cost=0)
                product.control_study_session(user_id, study['id'], 'stop')
            summary = product.dashboard(user_id)
            self.assertEqual(summary['usage']['sessions'], limits['sessions'])
            self.assertEqual(summary['usage']['assignments'], limits['assignments'])
            with self.assertRaisesRegex(LimitExceeded, 'Лимит занятий'):
                product.start_study_session(user_id)

    def test_ultra_checkout_activates_ultra(self):
        provider_id = '22222222-2222-4222-8222-222222222222'
        self.store.record_checkout(22, provider_id, 'https://pay.platega.io/subscription/2', 599, 'ultra')
        self.store.payment_callback(provider_id, 'CONFIRMED', 599, 'RUB')
        self.assertEqual(self.store.subscription(22)['plan'], 'ultra')

    def test_old_two_plan_database_migrates_without_losing_subscription(self):
        path = self.temp.name + '/legacy.sqlite3'
        with sqlite3.connect(path) as connection:
            connection.executescript("""
                CREATE TABLE subscriptions (
                    user_id INTEGER PRIMARY KEY,
                    plan TEXT NOT NULL CHECK(plan IN ('free', 'paid')),
                    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'cancelled')),
                    updated_at INTEGER NOT NULL);
                INSERT INTO subscriptions VALUES (31, 'paid', 'active', 1);
                CREATE TABLE payment_subscriptions (
                    provider_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT NOT NULL,
                    plan TEXT NOT NULL CHECK(plan IN ('paid')), amount_rubles INTEGER NOT NULL,
                    currency TEXT NOT NULL, status TEXT NOT NULL, redirect_url TEXT NOT NULL,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            """)
        migrated = UsageStore(path, config())
        self.assertEqual(migrated.subscription(31)['plan'], 'paid')
        migrated.set_subscription(31, 'ultra')
        self.assertEqual(migrated.subscription(31)['plan'], 'ultra')

    def test_product_pricing_matches_pro_model_and_paid_guardrail(self):
        config = BillingConfig.load()
        self.assertEqual(config.values['llm_model'], 'yandexgpt-5.1')
        self.assertEqual(config.llm_cost(1200, 500), 1_360_000)
        self.assertEqual(config.plan('paid')['monthly_price_rubles'], 490)
        self.assertEqual(config.plan('paid')['assignments'], 60)
        self.assertEqual(config.plan('paid')['external_cost_rubles'], '150.00')
        self.assertEqual(config.plan('ultra')['monthly_price_rubles'], 990)
        self.assertEqual(config.plan('free')['tts_blocks'], 15)


if __name__ == '__main__':
    unittest.main()
