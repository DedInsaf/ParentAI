from pathlib import Path
import tempfile
import unittest

from scripts.preflight import ROOT as PROJECT_ROOT, read_env, validate


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'web').mkdir()
        for name in ('avatar.html', 'app.js'):
            (self.root / 'web' / name).write_text('ok', encoding='utf-8')
        (self.root / 'billing.json').write_text('{}', encoding='utf-8')
        snapshot = (self.root / 'data/models/huggingface/models--openai--whisper-small'
                    / 'snapshots/revision')
        snapshot.mkdir(parents=True)
        for name in ('config.json', 'preprocessor_config.json', 'model.safetensors'):
            (snapshot / name).write_text('ok', encoding='utf-8')
        self.values = {
            'PARENTAI_PUBLIC_ORIGIN': 'https://app.adym.ru',
            'PARENTAI_BIND': '127.0.0.1',
            'PARENTAI_GLOBAL_DAILY_BUDGET_RUBLES': '300',
            'PARENTAI_GLOBAL_MONTHLY_BUDGET_RUBLES': '3000',
            'PARENTAI_STT_ENGINE': 'local',
            'PARENTAI_STT_MODEL': 'openai/whisper-small',
            'PARENTAI_ENABLE_XTTS': '0',
            'YANDEX_API_KEY': 'secret',
            'YANDEX_FOLDER_ID': 'folder',
            'PLATEGA_MERCHANT_ID': '',
            'PLATEGA_SECRET': '',
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_ready_closed_beta_allows_deferred_payments(self):
        errors, warnings = validate(self.values, self.root, production=True, check_assets=False)
        self.assertEqual(errors, [])
        self.assertTrue(any('Platega' in item for item in warnings))

    def test_rejects_public_bind_missing_limits_and_partial_payment_credentials(self):
        values = {**self.values, 'PARENTAI_BIND': '0.0.0.0',
                  'PARENTAI_GLOBAL_DAILY_BUDGET_RUBLES': '0',
                  'PLATEGA_MERCHANT_ID': 'merchant'}
        errors, _ = validate(values, self.root, production=True, check_assets=False)
        self.assertTrue(any('локальным' in item for item in errors))
        self.assertTrue(any('дневной' in item for item in errors))
        self.assertTrue(any('задаются только вместе' in item for item in errors))

    def test_qwen_requires_its_isolated_runtime_and_local_model(self):
        values = {**self.values, 'PARENTAI_VOICE_PROVIDER': 'qwen'}
        errors, _ = validate(values, self.root, production=True, check_assets=False)
        self.assertTrue(any('Python-окружение Qwen' in item for item in errors))
        self.assertTrue(any('модель Qwen3-TTS' in item for item in errors))

    def test_env_reader_does_not_interpret_comments_or_quotes(self):
        path = self.root / 'parentai.env'
        path.write_text("# secret settings\nPARENTAI_BIND='127.0.0.1'\nEMPTY=\n", encoding='utf-8')
        self.assertEqual(read_env(path), {'PARENTAI_BIND': '127.0.0.1', 'EMPTY': ''})

    def test_proxy_service_and_documentation_use_one_private_port(self):
        service = (PROJECT_ROOT / 'deploy/adym.service').read_text(encoding='utf-8')
        caddy = (PROJECT_ROOT / 'deploy/Caddyfile.example').read_text(encoding='utf-8')
        documentation = (PROJECT_ROOT / 'docs/DEPLOYMENT.md').read_text(encoding='utf-8')
        for value in (service, caddy, documentation):
            self.assertIn('8768', value)
            self.assertNotIn('8767', value)
        self.assertIn('scripts/preflight.py --production', service)
        self.assertIn('127.0.0.1:8768', caddy)

    def test_daily_backup_units_are_installed_with_private_permissions(self):
        service = (PROJECT_ROOT / 'deploy/adym-backup.service').read_text(encoding='utf-8')
        timer = (PROJECT_ROOT / 'deploy/adym-backup.timer').read_text(encoding='utf-8')
        self.assertIn('scripts/backup.py', service)
        self.assertIn('UMask=0077', service)
        self.assertIn('Persistent=true', timer)

    def test_safe_database_export_has_a_timer(self):
        service = (PROJECT_ROOT / 'deploy/adym-db-export.service').read_text(encoding='utf-8')
        timer = (PROJECT_ROOT / 'deploy/adym-db-export.timer').read_text(encoding='utf-8')
        self.assertIn('scripts/export_admin_db.py', service)
        self.assertIn('OnUnitActiveSec=5min', timer)


if __name__ == '__main__':
    unittest.main()
