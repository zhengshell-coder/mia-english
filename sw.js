/* Mia 英语老师 — Service Worker: 缓存应用外壳,离线也能打开 */
const CACHE = 'mia-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // API 请求永远走网络
  if (e.request.method !== 'GET' || url.indexOf('generativelanguage.googleapis.com') >= 0) return;
  // 应用外壳: 先缓存,后台再更新 (stale-while-revalidate)
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request)
        .then(res => {
          if (res && res.ok && new URL(url).origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
