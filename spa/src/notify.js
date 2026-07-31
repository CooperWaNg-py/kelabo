export function notifyBoard(title, body, tag) {
  if (localStorage.getItem('kelabo-notif') !== '1') return
  if (!document.hidden) return
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const text = body || ''
  const controller = navigator.serviceWorker?.controller
  if (controller) {
    controller.postMessage({ type: 'notify', title, body: text, ...(tag ? { tag } : {}) })
  } else {
    try { new Notification(title, { body: text, ...(tag ? { tag } : {}) }) } catch {}
  }
}
