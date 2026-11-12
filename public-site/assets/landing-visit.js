window.addEventListener('load', () => {
  fetch('/api/landing-visit', {
    method: 'POST',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    keepalive: true,
  }).catch(() => {});
}, {once: true});
