import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../web/avatar.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('product is presented as Adym and explains the Tatar name', () => {
  assert.match(html, /<title>Адым · шаг к самостоятельной учёбе<\/title>/);
  assert.match(html, /Адым <small class="brand-meaning">· шаг<\/small>/);
  assert.match(html, /«АДЫМ» ПО-ТАТАРСКИ — «ШАГ»/);
  assert.match(html, /Шаг к самостоятельной учёбе/);
});

test('old public brand is absent from the current interface', () => {
  assert.doesNotMatch(html, /ParentAI|ИИ-Родитель/);
  assert.doesNotMatch(script, /ParentAI|ИИ-Родитель/);
});
