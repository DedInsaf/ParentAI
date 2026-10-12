const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('#site-nav');

toggle?.addEventListener('click', () => {
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!expanded));
  nav?.classList.toggle('open', !expanded);
});

nav?.addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    toggle?.setAttribute('aria-expanded', 'false');
    nav.classList.remove('open');
  }
});

const year = document.querySelector('#year');
if (year) year.textContent = String(new Date().getFullYear());

const checkoutPlans = {
  plus: {
    name: 'Адым Плюс',
    price: '490 ₽',
    description: 'Для занятий несколько раз в неделю.',
    features: [
      '20 занятий по 30 минут',
      'До 3 заданий за занятие',
      'До 10 голосовых ответов за занятие',
      'До 60 новых заданий за период',
    ],
  },
  ultra: {
    name: 'Адым Ультра',
    price: '990 ₽',
    description: 'Больше времени и голосовых подсказок.',
    features: [
      '45 занятий по 45 минут',
      'До 4 заданий за занятие',
      'До 20 голосовых ответов за занятие',
      'До 180 новых заданий за период',
    ],
  },
};

const checkoutName = document.querySelector('[data-checkout-name]');
if (checkoutName) {
  const requestedPlan = new URLSearchParams(window.location.search).get('plan');
  const plan = checkoutPlans[requestedPlan] ?? checkoutPlans.plus;
  checkoutName.textContent = plan.name;
  document.querySelector('[data-checkout-price]').textContent = plan.price;
  document.querySelector('[data-checkout-total]').textContent = plan.price;
  document.querySelector('[data-checkout-description]').textContent = plan.description;
  document.querySelector('[data-checkout-features]').innerHTML = plan.features.map((feature) => `<li>${feature}</li>`).join('');
  document.title = `${plan.name} — оформление доступа`;
}

const paymentDialog = document.querySelector('.payment-dialog');
document.querySelector('[data-payment-placeholder]')?.addEventListener('click', () => {
  paymentDialog?.showModal();
});

document.querySelectorAll('[data-dialog-close]').forEach((button) => {
  button.addEventListener('click', () => paymentDialog?.close());
});

paymentDialog?.addEventListener('click', (event) => {
  if (event.target === paymentDialog) paymentDialog.close();
});
