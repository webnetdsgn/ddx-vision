/* DDX Vision — сервис-воркер: приложение работает без интернета и сразу подхватывает новую версию */
const VER = 'ddx-vision-v4';
const FONTS = 'https://fonts.googleapis.com/css2?family=Onest:wght@400..700&family=Oswald:wght@500..700&display=swap';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

/* при установке берём файлы с сервера напрямую, мимо кэша браузера (иначе можно застрять на старой версии) */
const fresh = url => fetch(new Request(url, { cache: 'reload' })).then(r => { if (!r.ok) throw new Error(url); return r; });

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
  e.waitUntil(
    caches.open(VER)
      .then(c => Promise.all([Promise.all(SHELL.map(u => fresh(u).then(r => c.put(u, r)))), precacheFonts(c)]))
      .then(() => self.skipWaiting())
  );
});

/* новая версия: удаляем старый кэш, берём управление и перезагружаем открытые окна, чтобы сразу показать обновление */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => { const old = keys.filter(k => k !== VER); return Promise.all(old.map(k => caches.delete(k))).then(() => old.length); })
      .then(n => self.clients.claim().then(() => n))
      .then(n => {
        if (!n) return;
        return self.clients.matchAll({ type: 'window' }).then(list => list.forEach(c => { try { Promise.resolve(c.navigate(c.url)).catch(() => {}); } catch (err) {} }));
      })
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  /* страницы: сначала сеть с проверкой «не изменился ли файл», если нет интернета — из кэша */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req.url, { cache: 'no-cache', redirect: 'manual' })
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(VER).then(c => c.put('index.html', copy)); } return res; })
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  /* шрифты Google и свои файлы: из кэша, а в фоне обновляем */
  if (url.origin === location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req, { cache: 'no-cache' }).then(res => {
          if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(VER).then(c => c.put(req, copy)); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
