"""Download pinned public inference assets; no camera/audio is uploaded."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent / 'web' / 'vendor'
BASE = 'https://cdn.jsdelivr.net/npm/'
ASSETS = {
    'three.module.js': BASE+'three@0.160.0/build/three.module.js',
    'loaders/GLTFLoader.js': BASE+'three@0.160.0/examples/jsm/loaders/GLTFLoader.js',
    'utils/BufferGeometryUtils.js': BASE+'three@0.160.0/examples/jsm/utils/BufferGeometryUtils.js',
    'vision/vision_bundle.mjs': BASE+'@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    'vision/face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    'vision/selfie_multiclass.tflite': 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite',
    'matting/modnet.onnx': 'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx',
    'matting/MODNet-LICENSE': 'https://raw.githubusercontent.com/ZHKKKe/MODNet/28165a451e4610c9d77cfdf925a94610bb2810fb/LICENSE',
    'matting/ort.wasm.min.mjs': BASE+'onnxruntime-web@1.20.1/dist/ort.wasm.min.mjs',
    'matting/ort-wasm-simd-threaded.mjs': BASE+'onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.mjs',
    'matting/ort-wasm-simd-threaded.wasm': BASE+'onnxruntime-web@1.20.1/dist/ort-wasm-simd-threaded.wasm',
    'matting/ORT-LICENSE': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.20.1/LICENSE',
}
for name in ['vision_wasm_internal.js','vision_wasm_internal.wasm','vision_wasm_nosimd_internal.js','vision_wasm_nosimd_internal.wasm']:
    ASSETS['vision/wasm/'+name] = BASE+'@mediapipe/tasks-vision@0.10.14/wasm/'+name


def download(item):
    name, url = item
    path = ROOT/name
    if path.is_file() and path.stat().st_size:
        return
    path.parent.mkdir(parents=True,exist_ok=True)
    with urllib.request.urlopen(url, timeout=90) as response:
        data = response.read()
    tmp = path.with_suffix(path.suffix+'.tmp')
    tmp.write_bytes(data)
    tmp.replace(path)
    print(f'Загружен {name}: {len(data)} байт', flush=True)


def ensure_assets():
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(download, ASSETS.items()))

if __name__=='__main__': ensure_assets()
