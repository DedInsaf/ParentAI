import io
import base64
import json
from pathlib import Path
import tempfile
import time
import unittest
import urllib.error
import wave
import numpy as np
from scipy.io import wavfile
from dialogue import DEFAULT_REPLY_VOICE,Dialogues,_answers_match
from runtime import Runtime
from speech import LocalSpeechRecognizer, SpeechRecognizer, SpeechSynthesizer, stt_pcm
from lipsync import timeline, viseme


def recording(seconds=1, rate=48000, silent=False):
    samples = np.zeros(int(seconds*rate)) if silent else .15*np.sin(np.arange(int(seconds*rate))*2*np.pi*220/rate)
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes((samples*32767).astype('<i2').tobytes())
    return output.getvalue()


class SpeechTests(unittest.TestCase):
    def test_local_whisper_is_private_default_and_recognizes_russian(self):
        seen = {}
        def transcribe(audio, generate_kwargs):
            seen['audio'] = audio
            seen['options'] = generate_kwargs
            return {'text': '  Помоги решить задачу  '}
        recognizer = LocalSpeechRecognizer(pipeline_factory=lambda: transcribe)
        self.assertEqual(recognizer.recognize(recording()), 'Помоги решить задачу')
        self.assertTrue(recognizer.public_status()['local'])
        self.assertEqual(recognizer.public_status()['external_cost'], 0)
        self.assertEqual(seen['audio']['sampling_rate'], 16000)
        self.assertEqual(seen['options'], {'language': 'ru', 'task': 'transcribe'})

    def test_local_whisper_resolves_installed_snapshot_without_model_id_lookup(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot = Path(temp) / 'models--openai--whisper-small' / 'snapshots' / 'revision'
            snapshot.mkdir(parents=True)
            for name in ('config.json', 'preprocessor_config.json', 'model.safetensors'):
                (snapshot / name).write_bytes(b'installed')
            recognizer = LocalSpeechRecognizer(cache_dir=temp)
            self.assertEqual(recognizer._local_model_path(), snapshot)

    def test_local_whisper_can_warm_before_the_first_question(self):
        calls = []
        recognizer = LocalSpeechRecognizer(pipeline_factory=lambda: calls.append('loaded') or (lambda *_a, **_k: {}))
        recognizer.warm()
        self.assertEqual(calls, ['loaded'])
        self.assertFalse(recognizer.loading)
        self.assertEqual(recognizer.public_status()['message'], 'готов')

    def test_pcm_resampling_and_rejections(self):
        pcm = stt_pcm(recording())
        self.assertEqual(len(pcm), 32000)
        self.assertNotEqual(pcm[:4], b'RIFF')
        for payload in (b'bad', recording(silent=True), recording(seconds=30)):
            with self.assertRaises(ValueError): stt_pcm(payload)

    def test_speechkit_auth_and_result(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, limit): return json.dumps({'result': 'Помоги с уравнением'}).encode()
        def open_request(request, timeout):
            self.assertIn('sampleRateHertz=16000', request.full_url)
            self.assertNotIn('folderId', request.full_url)
            self.assertEqual(request.headers['Authorization'], 'Api-Key test-key')
            self.assertEqual(timeout, 40)
            return Response()
        self.assertEqual(SpeechRecognizer('test-key', open_request).recognize(recording()), 'Помоги с уравнением')

    def test_speechkit_errors_identify_key_quota_and_provider(self):
        cases = {
            401: 'недействителен',
            403: 'не имеет доступа',
            400: 'формат записи',
            429: 'квота',
            503: 'временно недоступен',
        }
        for code, message in cases.items():
            with self.subTest(code=code):
                def fail(request, timeout, code=code):
                    raise urllib.error.HTTPError(request.full_url, code, 'failed', {}, io.BytesIO())
                with self.assertRaisesRegex(ValueError, message):
                    SpeechRecognizer('test-key', fail, sleeper=lambda _: None).recognize(recording())

    def test_speechkit_retries_transient_500_and_recovers(self):
        calls, delays = [], []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, limit): return json.dumps({'result': 'Слышу вопрос'}).encode()
        def flaky(request, timeout):
            calls.append(request)
            if len(calls) < 3:
                raise urllib.error.HTTPError(request.full_url, 500, 'failed', {}, io.BytesIO())
            return Response()
        recognizer = SpeechRecognizer('test-key', flaky, sleeper=delays.append)
        self.assertEqual(recognizer.recognize(recording()), 'Слышу вопрос')
        self.assertEqual(len(calls), 3)
        self.assertEqual(delays, [.4, 1.0])

    def test_speechkit_retries_network_and_bad_gateway_failures(self):
        calls, delays = [], []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, limit): return json.dumps({'result': 'Резерв работает'}).encode()
        def flaky(request, timeout):
            calls.append(request)
            if len(calls) == 1:
                raise urllib.error.URLError('temporary route failure')
            if len(calls) == 2:
                raise urllib.error.HTTPError(request.full_url, 502, 'bad gateway', {}, io.BytesIO())
            return Response()
        recognizer = SpeechRecognizer('test-key', flaky, sleeper=delays.append)
        self.assertEqual(recognizer.recognize(recording()), 'Резерв работает')
        self.assertEqual(len(calls), 3)
        self.assertEqual(delays, [.4, 1.0])

    def test_speechkit_tts_retries_transient_failure(self):
        calls, delays = [], []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, limit):
                audio = recording(rate=16000)
                return json.dumps({'result': {'audioChunk': {
                    'data': base64.b64encode(audio).decode()}}}).encode()
        def flaky(request, timeout):
            calls.append(request)
            if len(calls) < 3:
                raise urllib.error.HTTPError(request.full_url, 503, 'unavailable', {}, io.BytesIO())
            return Response()
        with tempfile.TemporaryDirectory() as temp:
            result = SpeechSynthesizer('test-key', flaky, delays.append).synthesize(
                'Попробуй ещё раз.', Path(temp) / 'answer.wav')
        self.assertGreater(result['duration_ms'], 0)
        self.assertEqual(len(calls), 3)
        self.assertEqual(delays, [.4, 1.0])

    def test_lipsync_pauses_and_russian_shapes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'answer.wav'
            audio = np.concatenate([np.zeros(1600), np.sin(np.arange(6400)*.1)*.2, np.zeros(1600)]).astype(np.float32)
            wavfile.write(path,16000,audio)
            cues=timeline(path,'Мама, папа, ура!')
            self.assertEqual(cues[0]['shape'],'silence')
            self.assertEqual(cues[-1]['open'],0)
            self.assertAlmostEqual(cues[-1]['time'],.6)
            self.assertIn('closed',{item['shape'] for item in cues})
            self.assertEqual(viseme('у'),'round')


class DialogueTests(unittest.TestCase):
    def test_erasure_waits_for_a_worker_that_has_not_stopped(self):
        import threading
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as temp:
            manager = Dialogues(Runtime(temp), None)
            worker = Mock()
            worker.is_alive.return_value = True
            job = {'id':'busy-job', 'user_id':1, 'thread':worker,
                   'request_id':'busy-request', 'cancel':threading.Event()}
            manager.jobs[job['id']] = job
            try:
                with self.assertRaisesRegex(ValueError, 'Повторите удаление'):
                    manager.cancel_user(1)
                self.assertTrue(job['cancel'].is_set())
                self.assertIn('busy-job', manager.jobs)
                worker.is_alive.return_value = False
                manager.cancel_user(1)
                self.assertFalse(manager.jobs)
            finally:
                manager.close()

    def test_expired_temporary_data_is_cleaned_without_a_new_question(self):
        import threading
        with tempfile.TemporaryDirectory() as temp:
            manager = Dialogues(Runtime(temp), None)
            try:
                bank = Path(manager.storage.name) / 'old-job'
                bank.mkdir()
                (bank / 'reference.wav').write_bytes(b'private')
                manager.jobs['old-job'] = {'id':'old-job', 'created':time.monotonic()-1900,
                    'state':'done', 'thread':threading.Thread(), 'user_id':1,
                    'request_id':'old-request', 'session':'old-session', 'cancel':threading.Event()}
                manager.requests[(1, 'old-request')] = 'old-job'
                manager.sessions['old-session'] = {'updated':time.monotonic()-1900, 'user_id':1}
                manager.cleanup_expired()
                self.assertFalse(bank.exists())
                self.assertFalse(manager.jobs)
                self.assertFalse(manager.requests)
                self.assertFalse(manager.sessions)
            finally:
                manager.close()

    def test_parent_voice_is_the_product_default(self):
        self.assertEqual(DEFAULT_REPLY_VOICE,'parent')
        self.assertEqual(Dialogues.start.__defaults__[1],'parent')

    def test_structured_plan_is_called_once_and_answer_checked_locally(self):
        class PlanTutor:
            calls=0
            model='test-model'
            def public_status(self):return {'enabled':True}
            def create_plan(self,question,level):
                self.calls+=1
                return {'plan':{'solution':'x=4','hints':['Вычти 3.','Раздели на 2.','Проверь.'],
                    'control_questions':['Что получится?','Какое число?','Сходится?'],
                    'common_errors':[],'answer_criterion':'x=4','acceptable_answers':['4','x=4'],
                    'final_explanation':'Сначала вычитаем 3, затем делим на 2.'},
                    'usage':{'input_tokens':100,'output_tokens':100,'actual':True}}
        with tempfile.TemporaryDirectory() as temp:
            tutor=PlanTutor();manager=Dialogues(Runtime(temp),tutor)
            try:
                first=manager.start('2x+3=11','средняя школа');manager.jobs[first['id']]['thread'].join(1)
                self.assertIn('Вычти 3',manager.snapshot(first['id'])['answer'])
                second=manager.start('У меня получилось: икс равен четырем','средняя школа',first['session']);manager.jobs[second['id']]['thread'].join(1)
                self.assertIn('Верно',manager.snapshot(second['id'])['answer'])
                self.assertTrue(manager.snapshot(second['id'])['finished'])
                self.assertEqual(tutor.calls,1)
                self.assertNotIn('x=4',manager.snapshot(first['id'])['answer'])
            finally:manager.close()

    def test_answer_criterion_finishes_task_and_stale_session_starts_a_new_one(self):
        class PlanTutor:
            calls=0
            model='test-model'
            def public_status(self):return {'enabled':True}
            def create_plan(self,question,level):
                self.calls+=1
                answer='4' if self.calls==1 else '7'
                return {'plan':{'solution':answer,'hints':['Подумай.']*3,
                    'control_questions':['Какой ответ?']*3,'common_errors':[],
                    'answer_criterion':f'Ответ равен {answer}','acceptable_answers':[],
                    'final_explanation':f'Ответ {answer}.'},'usage':{}}
        with tempfile.TemporaryDirectory() as temp:
            tutor=PlanTutor();manager=Dialogues(Runtime(temp),tutor)
            try:
                first=manager.start('2 + 2','начальная школа');manager.jobs[first['id']]['thread'].join(1)
                solved=manager.start('У меня получилось четыре','начальная школа',first['session'])
                manager.jobs[solved['id']]['thread'].join(1)
                self.assertTrue(manager.snapshot(solved['id'])['finished'])
                self.assertIn('новому заданию',manager.snapshot(solved['id'])['answer'])
                next_task=manager.start('3 + 4','начальная школа',first['session'])
                manager.jobs[next_task['id']]['thread'].join(1)
                self.assertNotEqual(next_task['session'],first['session'])
                self.assertIn('Подумай',manager.snapshot(next_task['id'])['answer'])
                self.assertEqual(tutor.calls,2)
            finally:manager.close()

    def test_a_different_task_requires_choice_and_starts_a_fresh_plan(self):
        class PlanTutor:
            calls=0
            model='test-model'
            def public_status(self):return {'enabled':True}
            def create_plan(self,question,level):
                self.calls+=1
                return {'plan':{'solution':'4','hints':['Подумай.']*3,
                    'control_questions':['Какой ответ?']*3,'common_errors':[],
                    'answer_criterion':'Ответ 4','acceptable_answers':['4'],
                    'final_explanation':'Ответ 4.'},'usage':{}}
        with tempfile.TemporaryDirectory() as temp:
            tutor=PlanTutor();manager=Dialogues(Runtime(temp),tutor)
            try:
                first=manager.start('Сколько будет 2 + 2?','начальная школа')
                manager.jobs[first['id']]['thread'].join(1)
                choice=manager.start('Реши пример 7 + 5','начальная школа',first['session'])
                self.assertTrue(choice['switch_required'])
                self.assertEqual(tutor.calls,1)
                new=manager.start('Реши пример 7 + 5','начальная школа',first['session'],
                                  switch_action='new')
                manager.jobs[new['id']]['thread'].join(1)
                self.assertNotEqual(new['session'],first['session'])
                self.assertEqual(tutor.calls,2)
            finally:manager.close()

    def test_child_can_confirm_that_a_suspected_task_is_a_continuation(self):
        class PlanTutor:
            calls=0
            model='test-model'
            def public_status(self):return {'enabled':True}
            def create_plan(self,question,level):
                self.calls+=1
                return {'plan':{'solution':'12','hints':['Подумай.']*3,
                    'control_questions':['Какой ответ?']*3,'common_errors':[],
                    'answer_criterion':'Ответ 12','acceptable_answers':['12'],
                    'final_explanation':'Ответ 12.'},'usage':{}}
        with tempfile.TemporaryDirectory() as temp:
            tutor=PlanTutor();manager=Dialogues(Runtime(temp),tutor)
            try:
                first=manager.start('Реши пример 7 + 5','начальная школа')
                manager.jobs[first['id']]['thread'].join(1)
                choice=manager.start('Вычисли 7 + 5 другим способом','начальная школа',first['session'])
                self.assertTrue(choice['switch_required'])
                continued=manager.start('Вычисли 7 + 5 другим способом','начальная школа',first['session'],
                                        switch_action='continue')
                manager.jobs[continued['id']]['thread'].join(1)
                self.assertEqual(continued['session'],first['session'])
                self.assertEqual(tutor.calls,1)
            finally:manager.close()

    def test_spoken_answer_variants_are_safe_and_equivalent(self):
        self.assertTrue(_answers_match('Ответ будет четыре', ['4']))
        self.assertTrue(_answers_match('У меня вышло 4 сантиметра', ['4 см']))
        self.assertTrue(_answers_match('Ответ одна вторая', ['1/2', '0,5']))
        self.assertFalse(_answers_match('Ответ не 4', ['4']))
        self.assertFalse(_answers_match('Не 4, а 5', ['4']))
        self.assertFalse(_answers_match('Ответ 4 килограмма', ['4 см']))

    def test_server_controls_attempts_and_keeps_text_without_clone(self):
        class FakeTutor:
            attempts=[]
            def public_status(self): return {'enabled':True}
            def answer(self, question, history, level, attempt):
                self.attempts.append(attempt)
                return {'answer':'Попробуй следующий шаг.'}
        with tempfile.TemporaryDirectory() as temp:
            tutor=FakeTutor(); manager=Dialogues(Runtime(temp),tutor)
            try:
                session=None
                for _ in range(4):
                    job=manager.start('Не понимаю','средняя школа',session)
                    session=job['session']
                    manager.jobs[job['id']]['thread'].join(timeout=2)
                    result=manager.snapshot(job['id'])
                    self.assertEqual(result['state'],'done')
                    self.assertTrue(result['answer'])
                    with self.assertRaises(ValueError): manager.audio(job['id'])
                self.assertEqual(tutor.attempts,[0,1,2,3])
                with self.assertRaises(ValueError): manager.start('Вопрос','средняя школа','fake')
            finally: manager.close()

    def test_cancel_during_generation_does_not_advance_dialogue(self):
        import threading
        began, release = threading.Event(), threading.Event()
        class SlowTutor:
            def public_status(self): return {'enabled':True}
            def answer(self,*args,**kwargs):
                began.set(); release.wait(2); return {'answer':'Подсказка'}
        with tempfile.TemporaryDirectory() as temp:
            manager=Dialogues(Runtime(temp),SlowTutor())
            try:
                job=manager.start('Вопрос','средняя школа'); began.wait(1)
                manager.cancel(job['id']); release.set()
                manager.jobs[job['id']]['thread'].join(2)
                self.assertEqual(manager.snapshot(job['id'])['state'],'cancelled')
                self.assertEqual(manager.sessions[job['session']]['attempt'],0)
                self.assertEqual(manager.sessions[job['session']]['history'],[])
            finally: manager.close()

class StreamedVoiceTests(unittest.TestCase):
    def test_chunks_are_available_before_complete_and_worker_is_reused(self):
        import threading
        class Tutor:
            def public_status(self):return {'enabled':True}
            def answer(self,*args,**kwargs):return {'answer':'Подумай, какое правило подходит?'}
        class Engine:
            calls=0
            styles=[]
            def synthesize(self,ref,output,text,cancel,update,style='neutral'):
                self.calls+=1
                self.styles.append(style)
                wavfile.write(output/'chunk-0.wav',16000,np.ones(1600,dtype=np.float32)*.1)
                update({'chunks':[{'file':'chunk-0.wav','cues':timeline(output/'chunk-0.wav',text)}]})
                available.set();finish.wait(2)
                if cancel.is_set():raise InterruptedError()
                wavfile.write(output/'phrase-0.wav',16000,np.ones(1600,dtype=np.float32)*.1)
        available,finish=threading.Event(),threading.Event()
        with tempfile.TemporaryDirectory() as temp:
            runtime=Runtime(temp);runtime.reference_mode='clone';runtime.status['reference']=True
            (Path(temp)/'reference.wav').write_bytes(recording())
            runtime.voice_engine.close();runtime.voice_engine=Engine()
            manager=Dialogues(runtime,Tutor())
            try:
                first=manager.start('Помоги','средняя школа');self.assertTrue(available.wait(1))
                self.assertEqual(manager.snapshot(first['id'])['state'],'speaking')
                self.assertTrue(manager.audio(first['id'],0).is_file())
                with self.assertRaises(ValueError):manager.audio(first['id'])
                with self.assertRaises(ValueError):manager.audio(first['id'],-1)
                finish.set();manager.jobs[first['id']]['thread'].join(2)
                self.assertTrue(manager.audio(first['id']).is_file())
                second=manager.start('Ещё подсказку','средняя школа',first['session'])
                manager.jobs[second['id']]['thread'].join(2)
                self.assertEqual(runtime.voice_engine.calls,2)
                self.assertEqual(runtime.voice_engine.styles,['supportive','supportive'])
            finally:finish.set();manager.close()

    def test_failed_first_question_can_be_retried_without_expired_session(self):
        class Tutor:
            calls=0
            def public_status(self):return {'enabled':True}
            def answer(self,*args,**kwargs):
                self.calls+=1
                if self.calls==1:raise ValueError('Сеть недоступна')
                self.assert_attempt=kwargs['attempt'];return {'answer':'Подсказка'}
        with tempfile.TemporaryDirectory() as temp:
            runtime=Runtime(temp);tutor=Tutor();manager=Dialogues(runtime,tutor)
            try:
                first=manager.start('Помоги','средняя школа');manager.jobs[first['id']]['thread'].join(1)
                self.assertEqual(manager.snapshot(first['id'])['state'],'error')
                retry=manager.start('Помоги','средняя школа',first['session']);manager.jobs[retry['id']]['thread'].join(1)
                self.assertEqual(manager.snapshot(retry['id'])['state'],'done');self.assertEqual(tutor.assert_attempt,0)
            finally:manager.close();runtime.close()

    def test_standard_yandex_voice_does_not_require_or_transmit_parent_reference(self):
        seen={}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,limit):
                audio=recording(rate=16000);middle=len(audio)//2
                return ('\n'.join(json.dumps({'result':{'audioChunk':{'data':base64.b64encode(part).decode()}}})
                                  for part in (audio[:middle],audio[middle:]))).encode()
        def opener(request,timeout):
            seen.update(json.loads(request.data));self.assertEqual(timeout,25)
            self.assertEqual(request.headers['Authorization'],'Api-Key test-key')
            self.assertIn('/tts/v3/utteranceSynthesis',request.full_url)
            return Response()
        class Tutor:
            def public_status(self):return {'enabled':True}
            def answer(self,*args,**kwargs):return {'answer':'Подсказка'}
        with tempfile.TemporaryDirectory() as temp:
            runtime=Runtime(temp);manager=Dialogues(runtime,Tutor(),SpeechSynthesizer('test-key',opener))
            try:
                job=manager.start('Помоги','средняя школа',voice='yandex');manager.jobs[job['id']]['thread'].join(2)
                self.assertTrue(manager.audio(job['id']).is_file())
                self.assertEqual(seen['text'],'Подсказка')
                self.assertEqual(seen['outputAudioSpec']['containerAudio']['containerAudioType'],'WAV')
                self.assertNotIn('folderId',seen);self.assertNotIn('reference',seen)
            finally:manager.close();runtime.close()
