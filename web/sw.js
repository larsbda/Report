// Service worker: app shell and report data are network-first, with the cache as offline fallback.
const CACHE = 'morning-__BUILD__';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // weather, images: straight to network

  if (url.pathname.endsWith('/data.enc.json')) {
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put('data.enc.json', copy));
      return res;
    }).catch(() => caches.match('data.enc.json')));
    return;
  }

  // App code: network first so updates show up on the next open; the cached copy is used offline
  // or when the network takes more than 4 seconds.
  e.respondWith((async () => {
    const net = fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    });
    const slow = new Promise(r => setTimeout(r, 4000));
    try {
      const res = await Promise.race([net, slow.then(() => null)]);
      if (res) return res;
    } catch { /* offline */ }
    return (await caches.match(e.request, { ignoreSearch: true })) || net;
  })());
});
