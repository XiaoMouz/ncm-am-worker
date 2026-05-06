// Service Worker for NCM→AM push notifications

self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || '',
    icon: data.icon || '🎵',
    badge: '🎵',
    tag: data.tag || 'ncm-am-sync',
    data: data.url || '/',
    actions: [],
  };

  // Add action buttons based on type
  if (data.type === 'success') {
    options.actions = [{ action: 'open', title: '查看歌单' }];
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'NCM→AM 同步', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data || '/')
  );
});
