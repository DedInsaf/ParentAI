import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../web/avatar.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');

test('subscription details stay in a compact header dialog instead of the setup flow', () => {
  const setup = html.indexOf('<main id="setupPage"');
  const dialog = html.indexOf('<dialog id="billingDialog"');
  assert.ok(dialog > 0 && dialog < setup);
  assert.match(html, /id="billingBtn"[^>]+aria-controls="billingDialog"/);
  assert.doesNotMatch(html.slice(setup), /subscription-overview/);
  assert.match(script, /billingDialog'\)\.showModal\(\)/);
  assert.match(styles, /\.billing-trigger\{/);
  assert.match(styles, /\.billing-dialog\{/);
});

test('plans use parent-friendly sessions and include Plus and Ultra', () => {
  assert.doesNotMatch(html, /планов с подсказками/);
  assert.match(html, /5<\/strong> занятий в месяц/);
  assert.match(html, /Адым Плюс/);
  assert.match(html, /Адым Ультра/);
  assert.match(html, /Перерыв останавливает таймер занятия/);
  assert.match(script, /remaining\.sessions/);
  assert.match(script, /study-session/);
});
