export const MAX_BYTES = 64 * 1024 * 1024;

export function exportUrl(result, projectUrl) {
  if (!result || result.avatarSupportsFaceAnimations !== true) throw new Error('Выберите анимируемый аватар T2 в сканере: он умеет говорить и моргать.');
  if (typeof result.url !== 'string') throw new Error('Сканер не вернул аватар.');
  if (result.urlType === 'dataURL') {
    if (!/^data:(?:model\/gltf-binary|application\/octet-stream|application\/gltf-buffer);base64,[a-zA-Z0-9+/=]+$/.test(result.url) || result.url.length > MAX_BYTES * 4 / 3 + 128) throw new Error('Некорректные данные аватара.');
    return result.url;
  }
  const url = new URL(result.url);
  if (result.urlType !== 'httpURL' || url.protocol !== 'https:' || url.username || url.password || url.port || ![new URL(projectUrl).hostname, 'assets.avaturn.me'].includes(url.hostname)) throw new Error('Сканер вернул неподдерживаемый адрес модели.');
  return url.href;
}

export async function readExport(result, projectUrl, signal) {
  const url = exportUrl(result, projectUrl);
  const response = await fetch(url, {signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error'});
  if (!response.ok) throw new Error('Не удалось получить созданный аватар. Повторите завершение сканирования.');
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new Error('Слишком большая модель для телефона.');
  const reader = response.body.getReader(), chunks = []; let count = 0;
  try {
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      count += value.byteLength;
      if (count > MAX_BYTES) throw new Error('Слишком большая модель для телефона.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const buffer = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return buffer.buffer;
}

export async function scannerSDK(container, url, onExport) {
  const {AvaturnSDK} = await import('./vendor/avaturn-sdk.mjs');
  // SDK 1.1.0 does not verify MessageEvent origin/source itself.
  class ScopedSDK extends AvaturnSDK {
    messageHandler(event) {
      const frame = container.querySelector('iframe');
      if (!frame || event.source !== frame.contentWindow || event.origin !== new URL(url).origin || !event.data || typeof event.data !== 'object') return;
      super.messageHandler(event);
    }
  }
  const sdk = new ScopedSDK();
  sdk.on('export', onExport);
  const ready = sdk.init(container, {url, iframeClassName: 'avatar-scanner-frame'});
  const iframe = container.querySelector('iframe');
  if (iframe) { iframe.title = 'Создание вашего 3D-аватара в Avaturn'; iframe.setAttribute('allow', 'camera'); iframe.referrerPolicy = 'no-referrer'; }
  return {sdk, ready};
}
