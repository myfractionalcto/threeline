/**
 * Shell-caching service worker — network-first strategy.
 *
 * Purpose: keep the PWA launchable when the laptop is offline / the
 * installed URL is stale, so `app.js` can run and show the Reconnect UI.
 *
 * Strategy: always try the network first. If it succeeds, use the fresh
 * response AND update the cache. If it fails, fall back to whatever is
 * cached. This way edits on the laptop show up immediately on reload —
 * no more stuck-on-old-code problems.
 *
 * Bump the cache name (v1 → v2 → …) whenever the shell assets change in
 * a way that would be incompatible with an old cached copy. The activate
 * handler drops any cache whose name doesn't match.
 */

const CACHE = 'threelane-mobile-v1';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
  '/vendor/jsqr.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.all(SHELL.map((url) => c.add(url).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * Network-first handler used for every GET the app makes.
 * - successful network response: serve + update cache.
 * - failed network response (offline / server down): fall back to cached.
 * - navigation fallback: serve cached `/index.html` so the shell still boots.
 */
function networkFirst(req) {
  return fetch(req)
    .then((response) => {
      if (response && response.ok && req.method === 'GET') {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return response;
    })
    .catch(() =>
      caches.match(req).then((cached) => {
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return caches.match('/index.html').then((r) => r || Response.error());
        }
        return Response.error();
      }),
    );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Never intercept WebSocket upgrades — if we do, the browser's WebSocket
  // client sees a plain HTTP response and closes. Some browsers surface WS
  // requests to fetch handlers, some don't; belt + braces.
  if (req.mode === 'websocket') return;
  // Skip cross-origin requests — POST /upload etc. need direct network access.
  try {
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname === '/ws') return;
    if (url.pathname.startsWith('/upload/')) return;
    // CA download routes must hit the network directly. iOS's .mobileconfig
    // install flow won't trigger from a SW-served response, and on any
    // network blip the navigate-fallback below would otherwise return the
    // cached home screen instead of the cert.
    if (
      url.pathname === '/ca.pem' ||
      url.pathname === '/ca.crt' ||
      url.pathname === '/ca.mobileconfig'
    )
      return;
  } catch {
    return;
  }
  event.respondWith(networkFirst(req));
});
