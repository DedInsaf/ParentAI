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
