import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public-site');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('public landing uses the Адым brand and explains its meaning', () => {
  const html = read('index.html');
  assert.match(html, /Адым — шаг к самостоятельной учёбе/);
  assert.match(html, /с татарского — «шаг»/);
  assert.match(html, /Готовим открытое тестирование/);
});

test('public landing shows exact monthly plan limits', () => {
  const html = read('index.html');
  assert.match(html, /5 занятий[\s\S]*20 минут/);
  assert.match(html, /20 занятий[\s\S]*30 минут/);
  assert.match(html, /45 занятий[\s\S]*45 минут/);
  assert.match(html, /490 ₽/);
  assert.match(html, /990 ₽/);
  assert.match(html, /30 календарных дней/);
  assert.match(html, /без автоматического продления/i);
});

test('purchase path is clickable but cannot charge before backend launch', () => {
  const html = read('index.html');
  const checkout = read('checkout.html');
  assert.match(html, /href="\/checkout\.html\?plan=plus"/);
  assert.match(html, /href="\/checkout\.html\?plan=ultra"/);
  assert.match(checkout, /data-payment-placeholder/);
  assert.match(checkout, /Оплата временно недоступна/);
  assert.match(checkout, /деньги не списывались/i);
  assert.doesNotMatch(html, /PLATEGA_|merchant|secret/i);
  assert.doesNotMatch(checkout, /PLATEGA_|merchant|secret/i);
});

test('public site includes privacy, terms and deployment essentials', () => {
  for (const name of ['privacy.html', 'terms.html', 'support.html', 'checkout.html', '404.html', 'robots.txt', 'sitemap.xml', '.htaccess']) {
    assert.ok(fs.existsSync(path.join(root, name)), `${name} is missing`);
  }
  assert.match(read('privacy.html'), /support@adym\.ru/i);
  assert.match(read('privacy.html'), /Platega/i);
  assert.match(read('terms.html'), /Пользовательское соглашение/i);
  assert.match(read('terms.html'), /490 ₽ за 30 календарных дней/i);
  assert.match(read('terms.html'), /990 ₽ за 30 календарных дней/i);
  assert.match(read('support.html'), /support@adym\.ru/i);
  assert.match(read('support.html'), /OPLAT/);
  assert.match(read('.htaccess'), /RewriteCond %\{HTTPS\} !=on/);
  assert.match(read('.htaccess'), /X-Forwarded-Proto.*!https/);
});
