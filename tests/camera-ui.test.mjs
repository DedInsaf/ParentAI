import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../web/avatar.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('camera opt-in opens an immediate local preview on every plan', () => {
  assert.match(html, /id="readyCamera"/);
  assert.match(html, /id="readyCameraPreview"[^>]+hidden/);
  assert.match(html, /Камера доступна на любом тарифе/);
  assert.match(script, /readyCamera'\)\.addEventListener\('change'/);
  assert.match(script, /showReadyCameraPreview\(\)/);
  assert.match(script, /Promise\.all\(\[enableCamera\(\),dependencies\(\)\]\)/);
});
