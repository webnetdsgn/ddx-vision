/* DDX Vision — сервис-воркер: приложение работает без интернета */
const VER = 'ddx-vision-v3';
const FONTS = 'https://fonts.googleapis.com/css2?family=Unbounded:wght@400..800&family=Onest:wght@400..700&family=Caveat:wght@600..700&display=swap';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

/* шрифты кладём в кэш заранее, чтобы и они работали без интернета */
async function precacheFonts(cache) {
  try {
    const res = await fetch(FONTS);
    const css = await res.clone().text();
    await cache.put(FONTS, res);
    const urls = Array.from(new Set(css.match(/https:\/\/fonts\.gstatic\.com[^)'" ]+/g) || []));
    await Promise.all(urls.map(u => fetch(u).then(r => cache.put(u, r)).catch(() => {})));
  } catch (err) { /* без шрифтов тоже работаем */ }
}

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => Promise.all([c.addAll(SHELL), precacheFonts(c)])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VER).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* страницы: сначала сеть (свежая версия), если нет интернета — из кэша */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => { const copy = res.clone(); caches.open(VER).then(c => c.put('index.html', copy)); return res; })
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  /* шрифты Google и свои файлы: из кэша, а в фоне обновляем */
  if (url.origin === location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(VER).then(c => c.put(req, copy)); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
