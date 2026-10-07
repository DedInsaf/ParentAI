import copy
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from avatar_model import validate_model, save_model, model_path, scanner_status
from runtime import Runtime


def model_document():
    return {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 144}],
            'bufferViews': [{'buffer': 0, 'byteLength': 144}],
            'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3'}],
            'nodes': [{'name': 'Neck', 'children': [1]}, {'name': 'Head'}, {'mesh': 0, 'skin': 0}],
            'skins': [{'joints': [0, 1]}], 'scenes': [{'nodes': [0, 2]}], 'scene': 0,
            'meshes': [{'extras': {'targetNames': ['jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight']},
                        'primitives': [{'attributes': {'POSITION': 0}, 'targets': [{'POSITION': 0}] * 3}]}]}


def glb(doc=None):
    doc = doc or model_document()
    encoded = json.dumps(doc).encode(); encoded += b' ' * (-len(encoded) % 4)
    binary = b'\0' * 144
    return struct.pack('<4sII', b'glTF', 2, 28 + len(encoded) + len(binary)) + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded + struct.pack('<II', len(binary), 0x004E4942) + binary


class ModelTests(unittest.TestCase):
    def test_generated_model_roundtrip_and_failed_replacement_preserves_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(directory)
            profile = save_model(runtime, glb())
            self.assertEqual(profile['version'], 6)
            self.assertEqual(model_path(runtime).read_bytes(), glb())
            self.assertEqual(Runtime(directory).avatar(), profile)
            with self.assertRaises(ValueError): save_model(runtime, b'invalid')
            self.assertEqual(runtime.avatar(), profile)
            self.assertEqual(model_path(runtime).read_bytes(), glb())
            new = save_model(runtime, glb())
            self.assertNotEqual(new['model'], profile['model'])
            self.assertEqual(len(list(Path(directory).glob('avatar-*.glb'))), 1)

    def test_external_resources_static_faces_cycles_and_large_geometry_rejected(self):
        mutations = [lambda d: d['buffers'][0].update(uri='http://127.0.0.1/private'),
                     lambda d: d.update(images=[{'uri': 'https://example.com/photo'}]),
                     lambda d: d['meshes'][0]['extras'].update(targetNames=['a', 'b', 'c']),
                     lambda d: d['nodes'][1].update(children=[0]),
                     lambda d: d['accessors'][0].update(count=600000),
                     lambda d: d['accessors'][0].update(byteOffset=145),
                     lambda d: d['nodes'][1].update(name='Static'),
                     lambda d: d.update(extensionsRequired=['KHR_draco_mesh_compression'])]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                doc = copy.deepcopy(model_document()); mutate(doc)
                with self.assertRaises(ValueError): validate_model(glb(doc))

    def test_scanner_requires_own_project_and_refuses_urls(self):
        for name in ['', 'demo', 'https://evil.example', '../data', 'a.avaturn.dev']:
            with patch.dict('os.environ', {'PARENTAI_AVATURN_SUBDOMAIN': name}): self.assertFalse(scanner_status()['enabled'])
        with patch.dict('os.environ', {'PARENTAI_AVATURN_SUBDOMAIN': 'parent-ai'}):
            self.assertEqual(scanner_status()['url'], 'https://parent-ai.avaturn.dev')

    def test_private_model_path_cannot_escape_profile_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(directory)
            (Path(directory) / 'avatar.json').write_text(json.dumps({'version': 6, 'model': '../secret.glb'}))
            with self.assertRaises(ValueError): model_path(runtime)
