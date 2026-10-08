# Сторонние компоненты

Three.js 0.160.0: [исходники и MIT](https://github.com/mrdoob/three.js/tree/r160).
MediaPipe Tasks Vision 0.10.14: [исходники и Apache-2.0](https://github.com/google-ai-edge/mediapipe). Условия моделей Face Landmarker и SelfieMulticlass проверяются отдельно у поставщика. SelfieMulticlass 256×256, float32, версия 1 используется локально только для одного снимка; [описание категорий и моделей](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter).
Coqui TTS: [исходники и MPL-2.0](https://github.com/idiap/coqui-ai-TTS).
MODNet: [исходники, веса и Apache-2.0](https://github.com/ZHKKKe/MODNet). Используется полная float32 ONNX-модель из [конвертации Xenova](https://huggingface.co/Xenova/modnet/tree/fa2fa546052fba4c08921230a26cc69a333fca12), около 26 МБ. Обрабатывается только локальный портрет. Копия авторской лицензии загружается в `web/vendor/matting/MODNet-LICENSE`.
ONNX Runtime Web 1.20.1: [исходники и MIT](https://github.com/microsoft/onnxruntime/tree/v1.20.1). Browser WASM runtime, одно вычислительное ядро; копия лицензии в `web/vendor/matting/ORT-LICENSE`.
XTTS v2: [карточка модели и Coqui Public Model License](https://huggingface.co/coqui/XTTS-v2). Условия весов отличаются от лицензии кода; коммерческое использование требует отдельной проверки допустимости.

Библиотеки браузера и веса не публикуются в репозитории. Адреса и версии фиксируются в `download_assets.py`. Облачные API Yandex используются по условиям аккаунта Yandex Cloud.
