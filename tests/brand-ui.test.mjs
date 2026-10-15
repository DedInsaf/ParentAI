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

test('a completed task closes the old hint dialogue', () => {
  assert.match(script, /if\(result\.finished\)\{dialogId=null;followupUntil=0;\}/);
  assert.match(script, /Задание завершено · можно переходить к следующему/);
});

test('public beta UI hides developer controls and exposes account rights', () => {
  assert.doesNotMatch(html, /Следующий сценарий|Посмотреть геометрию аватара/);
  assert.doesNotMatch(script, /Merchant ID|API-ключ Platega|адресу localhost/);
  assert.match(html, /id="deleteAccountBtn"/);
  assert.match(html, /id="deleteAccountDialog"/);
  assert.match(html, /adym\.ru\/privacy\.html/);
  assert.match(html, /adym\.ru\/support\.html/);
  assert.match(script, /authRequest\('delete'/);
});
