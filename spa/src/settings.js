import { api } from './api'
import { setScheme, setTheme } from './theme'

// Settings synced to the backend (per user, last-write-wins by updatedAt).
// Anything not listed here stays device-local (debug, join mode, …).
const KEY_MAP = {
  'kelabo-name': 'name',
  'kelabo-theme': 'theme',
  'kelabo-scheme': 'scheme',
  'kelabo-notif': 'notif',
  'kelabo-final-only': 'finalOnly',
  'kelabo-stt-lang': 'sttLang',
  'kelabo-vad': 'vad',
  'kelabo-mute-hidden': 'muteHidden',
  // How you join. Device ids are deliberately absent — a device id from a
  // laptop means nothing on a phone, and syncing one would select a microphone
  // that does not exist there.
  'kelabo-join-muted': 'joinMuted',
  'kelabo-join-camera': 'joinCamera',
  // Identicon re-roll salt — synced so every device (and, via the server,
  // every colleague) draws the avatar the user actually kept.
  'kelabo-avatar': 'avatar',
}
const BOOL_KEYS = new Set(['notif', 'finalOnly', 'vad', 'muteHidden', 'joinMuted', 'joinCamera'])
const TS_KEY = 'kelabo-settings-ts'
export const SETTINGS_SYNCED_EVENT = 'kelabo-settings-synced'

let pushTimer = null

const localUpdatedAt = () => Number(localStorage.getItem(TS_KEY) || 0)

// Fetch the backend settings; when they are newer than the local snapshot,
// apply them to localStorage (and the live theme) and notify open pages.
export async function pullSettings() {
  let data
  try {
    data = await api.getSettings()
  } catch {
    return null
  }
  const remote = data?.settings
  const remoteTs = Number(data?.updatedAt || 0)
  if (!remote || typeof remote !== 'object' || !remoteTs || remoteTs <= localUpdatedAt()) return null
  for (const [storageKey, remoteKey] of Object.entries(KEY_MAP)) {
    const v = remote[remoteKey]
    if (v === undefined) continue
    localStorage.setItem(storageKey, BOOL_KEYS.has(remoteKey) ? (v ? '1' : '0') : String(v))
  }
  localStorage.setItem(TS_KEY, String(remoteTs))
  if (remote.theme) setTheme(remote.theme)
  if (remote.scheme) setScheme(remote.scheme)
  window.dispatchEvent(new Event(SETTINGS_SYNCED_EVENT))
  return remote
}

// Push the local snapshot to the backend (debounced; last-write-wins server-side).
export function pushSettings() {
  const ts = Date.now()
  localStorage.setItem(TS_KEY, String(ts))
  // The same event the pull path fires, with the same meaning: "settings
  // changed — re-read localStorage". Local edits need it too: the rail shows
  // the display name and avatar, and without a signal it keeps rendering the
  // values it read at mount, so a rename in Settings only appeared after a
  // navigation happened to re-render the shell.
  window.dispatchEvent(new Event(SETTINGS_SYNCED_EVENT))
  clearTimeout(pushTimer)
  pushTimer = setTimeout(async () => {
    const settings = {}
    for (const [storageKey, remoteKey] of Object.entries(KEY_MAP)) {
      const raw = localStorage.getItem(storageKey)
      if (raw == null) continue
      settings[remoteKey] = BOOL_KEYS.has(remoteKey) ? raw === '1' : raw
    }
    try {
      await api.putSettings({ settings, updatedAt: ts })
    } catch {}
  }, 800)
}
