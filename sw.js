// Service worker: shows "Alex played you back!" notifications and opens the
// game when one is tapped. Nothing is cached; the game always loads fresh.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* plain text push */ }
  event.waitUntil((async () => {
    // The server already skips players whose app is open; this catches the
    // rest. If the game is on screen it just refreshes instead of notifying.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = windows.find((w) => w.visibilityState === 'visible');
    if (visible) {
      visible.postMessage({ type: 'sync' });
      return;
    }
    await self.registration.showNotification(data.title || 'Mini Golf', {
      body: data.body || "It's your turn!",
      tag: data.tag || 'minigolf',
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: data.url || self.registration.scope },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '.', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) {
        await w.focus();
        w.postMessage({ type: 'open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
