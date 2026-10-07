# Сторонние компоненты

Three.js 0.160.0: [исходники и MIT](https://github.com/mrdoob/three.js/tree/r160).
MediaPipe Tasks Vision 0.10.14: [исходники и Apache-2.0](https://github.com/google-ai-edge/mediapipe). Условия моделей Face Landmarker и SelfieMulticlass проверяются отдельно у поставщика. SelfieMulticlass 256×256, float32, версия 1 используется локально только для одного снимка; [описание категорий и моделей](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter).
Coqui TTS: [исходники и MPL-2.0](https://github.com/idiap/coqui-ai-TTS).
XTTS v2: [карточка модели и Coqui Public Model License](https://huggingface.co/coqui/XTTS-v2). Условия весов отличаются от лицензии кода; коммерческое использование требует отдельной проверки допустимости.

Библиотеки браузера и веса не публикуются в репозитории. Адреса и версии фиксируются в `download_assets.py`. Облачные API Yandex используются по условиям аккаунта Yandex Cloud.

Avaturn SDK 1.1.0: MIT, пакет [@avaturn/sdk](https://www.npmjs.com/package/@avaturn/sdk). Облачное создание и использование аватаров регулируется условиями Avaturn; бесплатное встраивание описано в [официальной документации](https://docs.avaturn.me/docs/integration/web/html/). SDK загружается с закреплённой версии. Перед запуском сканера родитель явно разрешает обработку фотографий внешним сервисом. Встроенный SDK обёрнут проверкой origin и источника сообщений iframe.
