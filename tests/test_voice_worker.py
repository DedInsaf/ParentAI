"""Exercise the worker protocol without loading any model or downloading weights."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
from runtime import atomic_json  # Import SciPy dependencies before mocking torch.
from lipsync import timeline
from voice_worker import serve


class Tensor:
    def to(self,device):return self
    def detach(self):return self
    def cpu(self):return self
    def numpy(self):return np.ones(2400,dtype=np.float32)*.1


class Model:
    def __init__(self,fail_mps=False):self.device='cpu';self.conditioned=0;self.fail_mps=fail_mps;self.devices=[]
    def to(self,device):self.device=device;return self
    def get_conditioning_latents(self,audio_path):
        self.conditioned+=1;return Tensor(),Tensor()
    def inference_stream(self,*args,**kwargs):
        self.devices.append(self.device)
        if self.fail_mps and self.device=='mps':raise RuntimeError('Unsupported Metal operation')
        yield Tensor()


class VoiceWorkerTests(unittest.TestCase):
    def run_worker(self,model,count):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);ref=root/'reference.wav';ref.write_bytes(b'test speaker identity')
            for i in range(count):
                out=root/str(i);out.mkdir()
                (root/f'{i}.request.json').write_text(json.dumps({'reference':str(ref),'output':str(out),'text':'Подсказка.'}))
            torch=SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda:True)))
            tts=SimpleNamespace(synthesizer=SimpleNamespace(tts_model=model))
            # init, request start/end for each reply, then idle exit.
            with patch.dict('sys.modules',{'torch':torch}),patch('voice_worker.load_model',return_value=tts),patch('voice_worker.time.monotonic',side_effect=[0]*(1+count*2)+[400]),patch.dict('os.environ',{'PARENTAI_VOICE_DEVICE':'auto'}):
                serve(root)
            values=[json.loads((root/str(i)/'stream.json').read_text()) for i in range(count)]
            for i,value in enumerate(values):
                self.assertEqual(value['state'],'done');self.assertEqual(len(value['chunks']),1)
                self.assertTrue((root/str(i)/'phrase-0.wav').is_file())
            return json.loads((root/'ready.json').read_text())

    def test_speaker_conditioning_is_cached_across_replies(self):
        model=Model();status=self.run_worker(model,2)
        self.assertEqual(model.conditioned,1);self.assertEqual(status['device'],'mps')

    def test_unsupported_gpu_operation_falls_back_before_publishing_audio(self):
        model=Model(fail_mps=True);status=self.run_worker(model,1)
        self.assertEqual(model.devices,['mps','cpu']);self.assertEqual(status['device'],'cpu')
