"""One bounded XTTS worker shared by lesson replies; no model in HTTP threads."""
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
            env={**os.environ,'MPLCONFIGDIR':str(cache/'matplotlib'),'XDG_CACHE_HOME':str(cache),'PYTORCH_ENABLE_MPS_FALLBACK':'1'}
            self.process=subprocess.Popen([sys.executable,str(ROOT/'voice_worker.py'),'--serve',str(directory)],
                                          cwd=ROOT,stdout=self.log,stderr=self.log,env=env)

    def warm(self,reference):
        with self.lock:
            if self.warming or self.closed:return
            self.warming=True
            self.warm_cancel=threading.Event();cancel=self.warm_cancel
        def prepare():
            directory=None
            try:
                directory=self.directory()/('warm-'+uuid.uuid4().hex)
                directory.mkdir();shutil.copyfile(reference,directory/'reference.wav')
                self.synthesize(directory/'reference.wav',directory,'',cancel)
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
                return {'state':'error','message':'XTTS недоступен. Проверьте установленную модель голоса.'}
            if not self.process or self.process.poll() is not None:
                return {'state':'idle','message':'Модель голоса не загружена'}
            ready=(root/'ready.json').is_file() and not self.warming
            try:device=json.loads((root/'ready.json').read_text()).get('device','cpu')
            except (OSError,ValueError):device='cpu'
            return {'state':'ready' if ready else 'loading','device':device,'message':('Голос готов · Apple GPU' if device=='mps' else 'Голос готов · CPU') if ready else 'Подготавливаю голос к занятию…'}

    def synthesize(self,reference,output,text,cancel,on_update=lambda _:None):
        with self.request_lock:
            if cancel.is_set(): raise InterruptedError()
            self.start()
            owned_process=self.process
            key=uuid.uuid4().hex
            root=Path(self.storage.name)
            request=root/(key+'.request.json')
            temporary=request.with_suffix('.tmp')
            temporary.write_text(json.dumps({'reference':str(reference),'output':str(output),'text':text}),encoding='utf-8')
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
                            raise ValueError('Модель XTTS не запустилась. Проверьте установку голоса.')
            except BaseException:
                self.release(owned_process)
                raise
            finally:
                request.unlink(missing_ok=True)

    def release(self,expected=None):
        with self.lock:
            if expected is not None and self.process is not expected: return
            self.warm_cancel.set()
            process=self.process
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill();process.wait(timeout=3)
            self.process=None
            if self.log: self.log.close();self.log=None

    def close(self):
        self.closed=True
        self.release()
        if self.storage:self.storage.cleanup()
