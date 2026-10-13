import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../web/avatar.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('camera is enabled by default with an immediate local preview on every plan', () => {
  assert.match(html, /id="readyCamera"[^>]+checked/);
  assert.match(html, /id="readyCameraPreview"[^>]+hidden/);
  assert.match(html, /Включена по умолчанию на любом тарифе/);
  assert.match(script, /readyCamera'\)\.addEventListener\('change'/);
  assert.match(script, /showReadyCameraPreview\(\)/);
  assert.match(script, /await enableCamera\(\)/);
  assert.match(script, /Камера пока не подключилась/);
  assert.doesNotMatch(script, /catch\(error\) \{\s*closeReadyCameraPreview\(true\)/);
});

test('resume reconnects camera before restarting the metered lesson clock', () => {
  const resume = script.slice(script.indexOf('async function pause()'), script.indexOf('function stop('));
  assert.ok(resume.indexOf('await enableCamera()') < resume.indexOf("action:'resume'"));
  assert.match(resume, /lessonElapsed=Number\(session\.elapsed_seconds\|\|0\)\*1000/);
});

test('lesson can reconnect camera and does not require a face before opening', () => {
  assert.match(html, /id="retryCameraBtn"/);
  assert.match(script, /action\('retryCameraBtn', reconnectLessonCamera\)/);
  assert.match(script, /cameraLive\(\)/);
  assert.doesNotMatch(script, /Перед началом в кадре должен быть один ребёнок/);
});

test('face detection failure does not switch off a working lesson camera', () => {
  assert.match(script, /function startLessonPresence\(\)/);
  assert.match(script, /Камера включена · проверка лица временно недоступна/);
  assert.match(script, /if\(lessonPresenceEnabled\)\{/);
});
