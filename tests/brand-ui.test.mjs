import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../web/avatar.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('product is presented as Adym and explains the Tatar name', () => {
  assert.match(html, /<title>Адым · Шаг к самостоятельной учёбе<\/title>/);
  assert.match(html, /src="\/adym-logo\.png"/);
  assert.doesNotMatch(html, /<svg viewBox="0 0 44 44"|brand-meaning|brand-tagline/);
  assert.match(html, /«АДЫМ» ПО-ТАТАРСКИ — «ШАГ»/);
  assert.match(html, /Шаг к самостоятельной учёбе/);
});

test('application header hides the successful connection state', () => {
  assert.doesNotMatch(html, /Шаг за шагом к самостоятельности/);
  assert.doesNotMatch(script, /'Подключено'|Шаг за шагом к самостоятельности|Сделаем следующий шаг вместе/);
  assert.match(script, /\$\('connection'\)\.hidden = true/);
  assert.match(script, /Нет связи · переподключаемся/);
});

test('old public brand is absent from the current interface', () => {
  assert.doesNotMatch(html, /ParentAI|ИИ-Родитель/);
  assert.doesNotMatch(script, /ParentAI|ИИ-Родитель/);
});

test('a completed task closes the old hint dialogue', () => {
  assert.match(script, /if\(result\.finished\)\{dialogId=null;taskFinished=true;followupUntil=0;/);
  assert.match(script, /Правильно! Введи или скажи новое задание/);
  assert.match(script, /Введи условие нового задания/);
  assert.match(script, /if\(taskFinished\)\{\$\('tutorMessages'\)\.replaceChildren\(\)/);
});

test('public beta UI hides developer controls and exposes account rights', () => {
  assert.doesNotMatch(html, /Следующий сценарий|Посмотреть геометрию аватара/);
  assert.doesNotMatch(script, /Merchant ID|API-ключ Platega|адресу localhost/);
  assert.match(html, /id="deleteAccountBtn"/);
  assert.match(html, /id="deleteAccountDialog"/);
  assert.match(html, /adym\.ru\/privacy\.html/);
  assert.match(html, /adym\.ru\/support\.html/);
  assert.match(script, /authRequest\('delete'/);
  assert.doesNotMatch(html, /Расход сервиса|summaryToday|summaryCost|internalCost/);
});

test('administrator has a dedicated protected account management dialog', () => {
  assert.match(html, /id="adminPanelBtn"[^>]+hidden/);
  assert.match(html, /id="adminDialog"/);
  assert.match(html, /id="adminUsers"/);
  assert.match(html, /Журнал действий администратора/);
  assert.match(script, /api\(`admin\/users/);
  assert.match(script, /action:\s*'set_plan'|runAdminAction\(account,'set_plan'/);
  assert.match(script, /runAdminAction\(account,'ban'/);
  assert.match(script, /runAdminAction\(account,'unban'/);
  assert.match(script, /runAdminAction\(account,'revoke_sessions'/);
  assert.match(script, /adminPanelBtn'\)\.hidden = !user\.is_admin/);
});

test('avatar dependency errors distinguish local WebAssembly from internet failures', () => {
  assert.match(script, /WebAssembly\|wasm\|Content Security\|CompileError/);
  assert.doesNotMatch(script, /подготовить создание аватара\. Проверьте интернет/);
});

test('a cloned parent voice is the lesson default and combines three expressive samples', () => {
  assert.match(html, /<option value="parent" selected>Голос родителя/);
  assert.doesNotMatch(html, /<option value="yandex" selected>/);
  assert.match(script, /direct' \? 8 : 18/);
  assert.equal((html.match(/data-voice-take=/g) || []).length, 3);
  assert.match(script, /recordedTakes\.length === 3/);
  assert.match(script, /references|take=\$\{take\}/);
  assert.match(html, /id="nextVoiceTakeBtn"[^>]*hidden/);
  assert.match(script, /Дальше: второй образец — поддерживаю/);
  assert.match(script, /voiceProfileReady/);
});
