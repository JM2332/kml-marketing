// Forces the page shell (index.html) to always be re-fetched from the network,
// bypassing GitHub Pages' Cache-Control: max-age=600 on the HTML document.
// app.js/style.css are already cache-busted via ?v= query strings in index.html,
// so this only needs to handle navigation/HTML requests.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const isHtml = e.request.mode === 'navigate' ||
    (e.request.method === 'GET' && (e.request.headers.get('accept') || '').includes('text/html'));
  if (!isHtml) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request))
  );
});
