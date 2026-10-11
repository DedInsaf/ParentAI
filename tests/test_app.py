import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from scipy.io import wavfile
from voice import prepare_reference
from runtime import Runtime, PHRASES


def wav(x, rate=48000):
    out = io.BytesIO()
    wavfile.write(out, rate, (x * 32767).astype(np.int16))
    return out.getvalue()


def speech():
    t = np.arange(48000 * 20) / 48000
    return .18 * np.sin(2*np.pi*180*t) * ((t % 2) > .5)


class AudioTests(unittest.TestCase):
    def test_valid_and_resampled(self):
        data, info = prepare_reference(wav(speech()))
        rate, audio = wavfile.read(io.BytesIO(data))
        self.assertEqual(rate, 24000)
        self.assertGreater(info['speech_seconds'], 10)
        self.assertLess(np.max(np.abs(audio.astype(float))), 32767)

    def test_reject_silence_noise_clipping_short_and_stereo(self):
        rng = np.random.default_rng(4)
        cases = [np.zeros(48000*20), rng.normal(0,.03,48000*20),
                 np.tile([1.,-1.],48000*10), speech()[:48000], np.zeros((48000*20,2))]
        for x in cases:
            with self.subTest(shape=x.shape), self.assertRaises(ValueError):
                prepare_reference(wav(x))

    def test_invalid_bytes(self):
        with self.assertRaises(ValueError): prepare_reference(b'invalid')


class RuntimeTests(unittest.TestCase):
    def frontal_profile(self):
        import base64
        photo='data:image/jpeg;base64,'+base64.b64encode(b'\xff\xd8\xfffixture').decode()
        points=[{'x':.5,'y':.3,'z':0} for _ in range(478)]
        points[10]['y']=.2;points[152]['y']=.46;points[234]['x']=.4;points[454]['x']=.6
        anchors={
            'crown':{'x':.5,'y':.10},'templeLeft':{'x':.38,'y':.25},'templeRight':{'x':.62,'y':.25},
            'earLeft':{'x':.38,'y':.32},'earRight':{'x':.62,'y':.32},
            'neckLeft':{'x':.43,'y':.51},'neckRight':{'x':.57,'y':.51},
            'shoulderLeft':{'x':.23,'y':.56},'shoulderRight':{'x':.77,'y':.56},
            'chestLeft':{'x':.22,'y':.80},'chestRight':{'x':.78,'y':.80},
        }
        return {'version':5,'views':[{'landmarks':points,'photo':photo,'yaw':0,'role':'front'}],
                'portrait':{'landmarks':points,'photo':photo,'yaw':0,'role':'portrait'},'anchors':anchors}

    def test_frontal_portrait_roundtrip_with_real_outline(self):
        value=self.frontal_profile();self.r.avatar(value)
        self.assertEqual(self.r.avatar(),value)
        restored=Runtime(self.temp.name);self.addCleanup(restored.close)
        self.assertEqual(restored.avatar(),value)
        value['anchors']['neckLeft']['x']=.41;self.r.avatar(value)
        self.assertEqual(self.r.avatar()['anchors']['neckLeft']['x'],.41)

    def test_invalid_portrait_does_not_replace_saved_profile(self):
        import copy
        valid=self.frontal_profile();self.r.avatar(valid)
        for mutate in [lambda v:v.pop('anchors'),
                       lambda v:v['anchors']['neckLeft'].update(x=.58),
                       lambda v:v['anchors']['crown'].update(y=.3),
                       lambda v:v['anchors']['shoulderLeft'].update(x=float('nan')),
                       lambda v:v['portrait'].update(role='side'),
                       lambda v:v['views'][0].update(yaw=.3)]:
            broken=copy.deepcopy(valid);mutate(broken)
            with self.assertRaises(ValueError):self.r.avatar(broken)
            self.assertEqual(self.r.avatar(),valid)

    def test_portrait_is_preserved_and_required_for_body_profile(self):
        import base64
        photo='data:image/jpeg;base64,'+base64.b64encode(b'\xff\xd8\xfffixture').decode()
        points=[{'x':.5,'y':.5,'z':0} for _ in range(478)]
        views=[{'landmarks':points,'photo':photo,'yaw':yaw,'role':role} for yaw,role in [(0,'front'),(.3,'side'),(-.3,'side')]]
        portrait={'landmarks':points,'photo':photo,'yaw':0,'role':'portrait'}
        value={'version':4,'views':views,'portrait':portrait}
        self.r.avatar(value);self.assertEqual(self.r.avatar(),value)
        with self.assertRaises(ValueError):self.r.avatar({'version':4,'views':views})
        portrait['role']='side'
        with self.assertRaises(ValueError):self.r.avatar(value)

    def test_front_role_is_preserved_and_ambiguous_roles_rejected(self):
        import base64
        points=[{'x':.5,'y':.5,'z':0} for _ in range(478)]
        photo='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode()
        views=[{'landmarks':points,'photo':photo,'yaw':yaw,'role':role} for yaw,role in [(0,'front'),(.3,'side'),(-.3,'side')]]
        self.r.avatar({'version':3,'views':views})
        self.assertEqual(self.r.avatar()['version'],3)
        self.assertEqual(self.r.avatar()['views'][0]['role'],'front')
        views[1]['role']='front'
        with self.assertRaises(ValueError): self.r.avatar({'version':3,'views':views})

    def test_local_six_view_avatar_roundtrip_and_order(self):
        import base64
        photo='data:image/jpeg;base64,'+base64.b64encode(b'\xff\xd8\xfffixture').decode()
        points=[{'x':.5,'y':.4,'z':0} for _ in range(478)]
        poses=[('front',0),('left',.16),('right',-.16),('left_outer',.30),('right_outer',-.30),('portrait',0)]
        anchors=self.frontal_profile()['anchors']
        value={'version':7,'views':[{'role':role,'yaw':yaw,'landmarks':points,'photo':photo} for role,yaw in poses],'anchors':anchors}
        self.r.avatar(value)
        saved=self.r.avatar()
        self.assertEqual(saved['version'],7)
        self.assertEqual(saved['engine'],'mediapipe-local')
        self.assertEqual(saved['anchors'],anchors)
        self.assertEqual([view['role'] for view in saved['views']],[role for role,_ in poses])
        broken={**value,'views':list(reversed(value['views']))}
        with self.assertRaises(ValueError): self.r.avatar(broken)
        wrong=__import__('copy').deepcopy(value);wrong['views'][1]['yaw']=-.16
        with self.assertRaises(ValueError): self.r.avatar(wrong)
        self.assertEqual(self.r.avatar(),saved)

    def test_local_avatar_preserves_compact_portrait_analysis(self):
        import base64
        value=self.frontal_profile();points=value['views'][0]['landmarks'];photo=value['views'][0]['photo']
        poses=[('front',0),('left',.16),('right',-.16),('left_outer',.30),('right_outer',-.30),('portrait',0)]
        raw=bytes([0,1,3,4,2,1]);alpha=bytes([0,32,128,192,254,255])
        profile={'version':7,'views':[{'role':role,'yaw':yaw,'landmarks':points,'photo':photo} for role,yaw in poses],
                 'anchors':value['anchors'],'portraitAnalysis':{
                     'segmentation':{'width':3,'height':2,'data':base64.b64encode(raw).decode()},
                     'matte':{'width':2,'height':3,'alpha':base64.b64encode(alpha).decode()}}}
        self.r.avatar(profile)
        self.assertEqual(self.r.avatar()['portraitAnalysis'],profile['portraitAnalysis'])
        broken=__import__('copy').deepcopy(profile);broken['portraitAnalysis']['matte']['alpha']=base64.b64encode(alpha[:-1]).decode()
        with self.assertRaises(ValueError):self.r.avatar(broken)
        self.assertEqual(self.r.avatar()['portraitAnalysis'],profile['portraitAnalysis'])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.r = Runtime(self.temp.name)
        self.addCleanup(self.r.close)

    def test_invalid_reference_does_not_replace_existing(self):
        self.r.xtts_enabled = True
        self.r.reference(wav(speech()))
        path = Path(self.temp.name)/'reference.wav'
        original = path.read_bytes()
        with self.assertRaises(ValueError): self.r.reference(wav(np.zeros(48000*20)))
        self.assertEqual(path.read_bytes(), original)

    def test_reject_record_during_synthesis(self):
        self.r.set(voice='generating')
        with self.assertRaises(ValueError): self.r.reference(wav(speech()))

    def test_bank_is_atomic(self):
        self.r.xtts_enabled = True
        self.r.reference_mode = 'clone'
        def synth(bank):
            for i in range(len(PHRASES)):
                (bank / f'phrase-{i}.wav').write_bytes(wav(speech()[:48000]))
        with patch.object(self.r, '_synthesize', side_effect=synth): self.r._generate()
        saved = (Path(self.temp.name)/'manifest.json').read_bytes()
        self.assertEqual(len(self.r.manifest), len(PHRASES))
        with patch.object(self.r, '_synthesize', side_effect=RuntimeError('test failure')):
            self.r._generate()
        self.assertEqual((Path(self.temp.name)/'manifest.json').read_bytes(), saved)
        self.assertEqual(len(Runtime(self.temp.name).manifest), len(PHRASES))
        self.assertEqual(self.r.snapshot()['voice'], 'error')

    def test_start_does_not_spawn_model(self):
        with patch.object(self.r, 'start_assets'), patch('runtime.subprocess.Popen') as process:
            self.r.start()
            process.assert_not_called()
        self.assertNotIn('llm', self.r.snapshot())

    def test_direct_voice_roundtrip_without_model(self):
        self.r.reference(wav(speech()[:48000*8]), mode='direct')
        with patch.object(self.r, '_synthesize') as synth:
            self.r.generate()
            self.r.worker.join(timeout=5)
            synth.assert_not_called()
        self.assertEqual(self.r.snapshot()['voice'], 'ready')
        restored = Runtime(self.temp.name)
        self.assertTrue(restored.snapshot()['reference'])
        self.assertEqual(restored.reference_mode, 'direct')
        self.assertEqual(restored.manifest, self.r.manifest)
        published = self.r.safe_audio(self.r.manifest[0]['file'])
        self.assertEqual(published.read_bytes(), (self.r.data/'reference.wav').read_bytes())

    def test_xtts_clone_is_disabled_without_explicit_noncommercial_opt_in(self):
        self.assertFalse(self.r.snapshot()['xtts_enabled'])
        with self.assertRaisesRegex(ValueError, 'лицензия'):
            self.r.reference(wav(speech()), mode='clone')

    def test_cancellation_does_not_publish_bank(self):
        self.r.cancel.set()
        self.r.reference(wav(speech()[:48000*8]), mode='direct')
        self.r._generate()
        self.assertFalse((self.r.data/'manifest.json').exists())
        self.assertEqual(self.r.manifest, [])

    def test_cancellation_terminates_worker(self):
        import subprocess, sys
        popen = subprocess.Popen
        processes = []
        def spawn(*args, **kwargs):
            process = popen([sys.executable, '-c', 'import time; time.sleep(30)'], **kwargs)
            processes.append(process)
            return process
        self.r.xtts_enabled = True
        self.r.reference(wav(speech()))
        with patch('runtime.subprocess.Popen', side_effect=spawn):
            self.r.generate()
            import time
            deadline = time.monotonic() + 5
            while not processes and time.monotonic() < deadline: time.sleep(.01)
            self.r.cancel_generation()
            self.r.worker.join(timeout=5)
        self.assertTrue(processes)
        self.assertIsNotNone(processes[0].poll())
        self.assertFalse(self.r.worker.is_alive())
        self.assertEqual(self.r.snapshot()['voice'], 'recorded')

    def test_avatar_validation_and_restore(self):
        import base64
        value = {'landmarks': [{'x':.5,'y':.5,'z':0} for _ in range(468)],
                 'photo': 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\n').decode()}
        self.r.avatar(value)
        self.assertEqual(Runtime(self.temp.name).avatar(), value)
        value['landmarks'][0]['x'] = float('nan')
        with self.assertRaises(ValueError): self.r.avatar(value)
        with self.assertRaises(ValueError): self.r.avatar([])

    def test_three_view_avatar_roundtrip(self):
        import base64
        photo = 'data:image/jpeg;base64,' + base64.b64encode(b'\xff\xd8\xfftest').decode()
        points = [{'x':.5,'y':.5,'z':0} for _ in range(468)]
        value = {'version':2,'views':[
            {'landmarks':points,'photo':photo,'yaw':0},
            {'landmarks':points,'photo':photo,'yaw':.3},
            {'landmarks':points,'photo':photo,'yaw':-.3},
        ]}
        self.r.avatar(value)
        self.assertEqual(Runtime(self.temp.name).avatar(), value)
        broken = {'version':2,'views':value['views'][:2]}
        with self.assertRaises(ValueError): self.r.avatar(broken)

if __name__ == '__main__': unittest.main()
