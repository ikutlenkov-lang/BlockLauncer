self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || 'У тебя новое сообщение' }; }
  const title = data.title || 'BLOCK';
  const options = {
    body: data.body || 'У тебя новое сообщение',
    tag: data.tag || 'block-new-message',
    renotify: true,
    data: { url: data.url || self.registration.scope }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || self.registration.scope;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
