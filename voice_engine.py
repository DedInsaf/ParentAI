"""One bounded voice-cloning worker shared by lesson replies; no model in HTTP threads."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import shutil
from pathlib import Path


class VoiceEngine:
    def __init__(self):
        configured=os.getenv('PARENTAI_VOICE_PROVIDER','').strip().lower()
        legacy=os.getenv('PARENTAI_ENABLE_XTTS','1').strip().lower() not in ('0','false','no')
        self.provider=configured or ('xtts' if legacy else 'none')
        self.lock=threading.RLock()
        self.request_lock=threading.Lock()
        self.storage=None
        self.process=None
        self.log=None
        self.closed=False
        self.warming=False
        self.warm_cancel=threading.Event()

    def directory(self):
        with self.lock:
            if self.closed:raise ValueError('Приложение закрывается.')
            if self.storage is None:self.storage=tempfile.TemporaryDirectory(prefix='parentai-voice-')
            return Path(self.storage.name)

    def start(self):
        from runtime import ROOT
        with self.lock:
            if self.closed: raise ValueError('Приложение закрывается.')
            if self.process and self.process.poll() is None: return
            if self.log: self.log.close()
            directory=self.directory()
            for name in ('ready.json','fatal.json'):
                (directory/name).unlink(missing_ok=True)
            self.log=(directory/'worker.log').open('wb')
            cache=ROOT/'data'/'.cache';cache.mkdir(parents=True,exist_ok=True)
            env={**os.environ,'MPLCONFIGDIR':str(cache/'matplotlib'),'XDG_CACHE_HOME':str(cache),
                 'HF_HOME':str(cache/'huggingface'),'TOKENIZERS_PARALLELISM':'false',
                 'OMP_NUM_THREADS':'2','MKL_NUM_THREADS':'2','PYTORCH_ENABLE_MPS_FALLBACK':'1'}
            worker=ROOT/('qwen_voice_worker.py' if self.provider=='qwen' else 'voice_worker.py')
            executable=(Path(os.getenv('PARENTAI_QWEN_PYTHON','')) if self.provider=='qwen' else Path(sys.executable))
            if self.provider=='qwen' and (not str(executable) or not executable.is_file()):
                executable=ROOT/'.venv-qwen/bin/python'
            self.process=subprocess.Popen([str(executable),str(worker),'--serve',str(directory)],
                                          cwd=ROOT,stdout=self.log,stderr=self.log,env=env)

    def warm(self,reference):
        # Loading Qwen speculatively costs about 3.5 GB and gives a small CPU
        # server no useful headroom. Load it only when a real reply is ready.
        if self.provider == 'qwen':
            return
        with self.lock:
            if self.warming or self.closed:return
            self.warming=True
            self.warm_cancel=threading.Event();cancel=self.warm_cancel
        def prepare():
            directory=None
            try:
                directory=self.directory()/('warm-'+uuid.uuid4().hex)
                directory.mkdir()
                references = list(reference) if isinstance(reference, (list, tuple)) else [reference]
                copies=[]
                for index, source in enumerate(references, 1):
                    target=directory/('reference.wav' if index==1 else f'reference-{index}.wav')
                    shutil.copyfile(source,target);copies.append(target)
                self.synthesize(copies,directory,'',cancel)
            except Exception:
                pass  # Public status reports model load failures; no noisy thread traceback.
            finally:
                if directory:shutil.rmtree(directory,ignore_errors=True)
                with self.lock:self.warming=False
        threading.Thread(target=prepare,daemon=True).start()

    def status(self):
        with self.lock:
            if self.storage is None:return {'state':'idle','message':'Модель голоса не загружена'}
            root=Path(self.storage.name)
            if (root/'fatal.json').is_file():
                name='Qwen' if self.provider=='qwen' else 'XTTS'
                return {'state':'error','provider':self.provider,'message':f'{name} недоступен. Проверьте модель голоса.'}
            if not self.process or self.process.poll() is not None:
                return {'state':'idle','message':'Модель голоса не загружена'}
            ready=(root/'ready.json').is_file() and not self.warming
            try:device=json.loads((root/'ready.json').read_text()).get('device','cpu')
            except (OSError,ValueError):device='cpu'
            if ready and self.provider=='qwen': message='Qwen готов · экспериментальный CPU-режим'
            elif ready: message='Голос готов · Apple GPU' if device=='mps' else 'Голос готов · CPU'
            else: message='Подготавливаю голос к занятию… это может занять несколько минут'
            return {'state':'ready' if ready else 'loading','device':device,'provider':self.provider,'message':message}

    def synthesize(self,reference,output,text,cancel,on_update=lambda _:None,style='neutral'):
        with self.request_lock:
            if cancel.is_set(): raise InterruptedError()
            self.start()
            owned_process=self.process
            key=uuid.uuid4().hex
            root=Path(self.storage.name)
            request=root/(key+'.request.json')
            temporary=request.with_suffix('.tmp')
            references = list(reference) if isinstance(reference, (list, tuple)) else [reference]
            temporary.write_text(json.dumps({'references':[str(path) for path in references],
                                             'output':str(output),'text':text,
                                             'style':style}),encoding='utf-8')
            temporary.replace(request)
            result=Path(output)/'stream.json'
            deadline=time.monotonic()+600
            count=-1
            try:
                while True:
                    if cancel.wait(.08): raise InterruptedError()
                    if time.monotonic()>deadline: raise ValueError('Озвучивание заняло больше 10 минут.')
                    if result.exists():
                        value=json.loads(result.read_text())
                        if len(value.get('chunks',[]))!=count:
                            count=len(value.get('chunks',[]));on_update(value)
                        if value.get('state')=='done': return value
                        if value.get('state')=='error': raise ValueError(value.get('error','Ошибка XTTS.'))
                    with self.lock:
                        if not self.process or self.process.poll() is not None:
                            raise ValueError('Модель голоса не запустилась. Проверьте установку Qwen/XTTS.')
            except BaseException:
                self.release(owned_process)
                raise
            finally:
                request.unlink(missing_ok=True)

    def busy(self):
        return self.request_lock.locked()

    def release(self,expected=None,idle_only=False):
        if idle_only and self.request_lock.locked():
            return False
        with self.lock:
            if expected is not None and self.process is not expected: return False
            self.warm_cancel.set()
            process=self.process
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill();process.wait(timeout=3)
            self.process=None
            if self.log: self.log.close();self.log=None
            return True

    def close(self):
        self.closed=True
        self.release()
        if self.storage:self.storage.cleanup()
