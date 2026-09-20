/* Service Worker de Vielsin (PWA).
 * Estrategia:
 *  - Interfaz estatica (HTML/CSS/JS/iconos): cache-first para carga instantanea.
 *  - Llamadas a /api/*: SIEMPRE a la red (network-only). Nunca datos medicos cacheados.
 */

const CACHE = 'vielsin-v17';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js?v=17',
  '/i18n.js?v=17',
  '/device-ai.js?v=17',
  '/vielsin-avatar.svg',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Solo gestionamos peticiones GET del mismo origen
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Las APIs SIEMPRE van a la red (nunca cache). El agente necesita datos frescos.
  if (url.pathname.startsWith('/api/')) {
    return; // deja pasar a la red normalmente
  }

  // Interfaz: cache-first con actualizacion en segundo plano.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
