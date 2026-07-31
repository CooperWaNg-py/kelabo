/* kelabo Service Worker — board notifications for unfocused tabs */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('message', e => {
  const data = e.data || {}
  if (data.type === 'notify') {
    e.waitUntil(
      self.registration.showNotification(data.title || 'kelabo', {
        body: data.body || '',
        tag: data.tag || 'kelabo-board',
      })
    )
  }
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const client = list[0]
      if (client) {
        client.postMessage({ type: 'focus-board' })
        return client.focus()
      }
      return self.clients.openWindow('/')
    })
  )
})
