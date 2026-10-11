import sqlite3
import tempfile
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
            'free': {'title': 'Free', 'monthly_price_rubles': 0, 'assignments': assignments,
                     'llm_requests': llm, 'stt_billed_seconds': 30, 'tts_blocks': tts,
                     'external_cost_rubles': cost},
            'paid': {'title': 'Paid', 'monthly_price_rubles': 299, 'assignments': 100,
                     'llm_requests': 100, 'stt_billed_seconds': 1000, 'tts_blocks': 100,
                     'external_cost_rubles': '85'},
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


if __name__ == '__main__':
    unittest.main()
