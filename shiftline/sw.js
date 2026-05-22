// Shiftline Service Worker — v2 (Web Push enabled)

const CACHE = 'shiftline-v2';
const SHELL = ['/', '/shiftline-worker.html'];

// ── Install: cache the app shell ──────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first, fall back to cache ──────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Push: show notification when a push event arrives ─────────
// This fires even when the app is completely closed.
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch (_) {}

  const title   = data.title   || 'Shiftline';
  const body    = data.body    || data.summary || 'Your roster has been updated.';
  const weekStart = data.weekStart || '';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:              '/icons/icon-192.png',
      badge:             '/icons/icon-192.png',
      tag:               'shiftline-roster',
      requireInteraction: false,
      vibrate:           [200, 100, 200],
      data:              { weekStart, url: '/shiftline-worker.html' },
    })
  );
});

// ── Notification click: open or focus the app ─────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If app window already open, focus it
      for (const client of list) {
        if (client.url.includes('shiftline') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      const url = e.notification.data?.url || '/shiftline-worker.html';
      return clients.openWindow(url);
    })
  );
});
