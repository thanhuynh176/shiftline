/* ─────────────────────────────────────────────
   Shiftline Service Worker  v1.0
   Handles: install prompt eligibility, offline shell
───────────────────────────────────────────── */

const CACHE_NAME = 'shiftline-shell-v1';
const SHELL_URL  = '/shiftline-worker.html';

// ── Install: cache the app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.add(SHELL_URL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clear old caches, take control immediately ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API/Supabase, cache fallback for shell ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go network-first for Supabase and CDN calls
  const isExternal = url.origin !== self.location.origin;
  if (isExternal) return; // let browser handle CDN/API requests normally

  // For navigation requests (page load), try network then fall back to shell
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match(SHELL_URL))
    );
    return;
  }

  // For same-origin assets (icons, manifest): cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache valid responses
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
