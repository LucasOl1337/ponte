'use strict';
// Ponte is a live remote: without the PC on the tailnet the app does nothing, so
// caching its code only risked serving a stale build (a phone left installed kept
// showing an old UI). This service worker now does the opposite of caching — it
// removes every previous cache, unregisters itself, and reloads open pages so the
// next load comes straight from the PC. It intercepts no requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key.startsWith('ponte-static-')).map(key => caches.delete(key)));
    } catch {}
    try { await self.registration.unregister(); } catch {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) { try { client.navigate(client.url); } catch {} }
    } catch {}
  })());
});
