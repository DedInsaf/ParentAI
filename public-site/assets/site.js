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

document.querySelector('#year').textContent = String(new Date().getFullYear());
