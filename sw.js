/**
 * sw.js — service worker: precache the app shell, runtime-cache everything
 * else same-origin, and keep the app 100% functional offline.
 *
 * Strategies:
 *   - Navigation requests: serve cached ./index.html immediately
 *     (offline-first), refresh the cache in the background.
 *   - Same-origin GET assets: stale-while-revalidate.
 *   - Everything else (POST, cross-origin): pass through to the network.
 *
 * All precache URLs are RELATIVE so the worker works both at a domain root
 * and under a GitHub Pages sub-path (username.github.io/repo/).
 *
 * To ship an update: change VERSION, deploy. Old caches are purged on
 * activate and the new worker takes over via the SKIP_WAITING message.
 */

const VERSION = 'flow-v1.1.1';
const SHELL_CACHE = VERSION + '-shell';
const RUNTIME_CACHE = VERSION + '-runtime';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/components.css',
  './css/views.css',
  './js/main.js',
  './js/db.js',
  './js/store.js',
  './js/parser.js',
  './js/parser.test.js',
  './js/parser.test.html',
  './js/sync.js',
  './js/ui.js',
  './js/utils.js',
  './js/ics.js',
  './js/views/list.js',
  './js/views/today.js',
  './js/views/upcoming.js',
  './js/views/browse.js',
  './js/views/detail.js',
  './js/views/matrix.js',
  './js/views/habits.js',
  './js/views/focus.js',
  './js/views/settings.js',
  './js/views/palette.js',
  './icons/icon.svg',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()) // take over immediately on updates
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // mutations (none today) go to network

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: passthrough

  // App navigation → cached shell first, refresh in background. Real
  // sub-pages (e.g. /js/parser.test.html) are NOT the SPA shell, so only
  // root navigations get the index.html fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const pathname = url.pathname.replace(/\/index\.html$/, '/');
      const isRoot = pathname === '/' || pathname === self.registration.scope.replace(/\/index\.html$/, '/');
      if (!isRoot) {
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch { /* fall through to shell below */ }
      }
      const cached = await cache.match('./index.html') || await cache.match('./');
      const network = fetch(req)
        .then((res) => { if (res && res.ok) cache.put('./index.html', res.clone()); return res; })
        .catch(() => null);
      return cached || (await network) || offlineFallback();
    })());
    return;
  }

  // Same-origin assets → stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await caches.match(req);
    const fresh = fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      fresh.catch(() => {}); // refresh in the background; ignore errors
      return cached;
    }
    const res = await fresh;
    if (res) return res;
    // Maybe it's a shell file that belongs to precache but was evicted.
    const shell = await caches.open(SHELL_CACHE).then((c) => c.match(req));
    return shell || offlineFallback();
  })());
});

function offlineFallback() {
  return new Response(
    '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:system-ui;padding:3rem;text-align:center;color:#555">' +
    '<h1>Offline</h1><p>This page was never cached. Reopen Flow once you are back online.</p></body>',
    { status: 200, headers: { 'Content-Type': 'text/html' } }
  );
}

/* Allow the page to trigger an immediate takeover after an update. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/* Notification click → focus (or open) the app, optionally opening a task. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      await client.focus();
      if (taskId) client.postMessage({ action: 'open-task', taskId });
      return;
    }
    await self.clients.openWindow('./');
  })());
});
