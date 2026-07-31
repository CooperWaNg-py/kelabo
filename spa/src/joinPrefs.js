/**
 * How you join a kelabo: muted or not, camera on or not, and which devices.
 *
 * One module because three places need to agree on it — the device check on the
 * way in, the Settings page that holds the defaults, and the room that acts on
 * them — and because "which localStorage key was that again" is how the three
 * quietly drift apart.
 *
 * The split answers the obvious question about where this belongs. Whether you
 * *usually* join muted is a preference and lives in Settings, synced across
 * devices with everything else. Which microphone is plugged into this
 * particular machine is not a preference, it is a fact about the machine, so
 * device ids stay local and are never synced — a device id from someone's
 * laptop means nothing on their phone, and syncing it would silently select a
 * microphone that does not exist.
 */

import { pushSettings } from './settings'

const KEYS = {
  muted: 'kelabo-join-muted',
  camera: 'kelabo-join-camera',
  micDevice: 'kelabo-mic-device',
  camDevice: 'kelabo-camera-device',
  speakerDevice: 'kelabo-speaker-device',
}

/** Synced via settings.js; the device ids deliberately are not. */
export const SYNCED_JOIN_KEYS = [KEYS.muted, KEYS.camera]

export function joinPrefs() {
  return {
    // Joining unmuted is the default: a kelabo where nobody can hear the new
    // arrival, and the new arrival does not know why, is worse than one where
    // somebody has to mute.
    muted: localStorage.getItem(KEYS.muted) === '1',
    // The camera is opt-in, matching the room itself.
    camera: localStorage.getItem(KEYS.camera) === '1',
    micDevice: localStorage.getItem(KEYS.micDevice) || '',
    camDevice: localStorage.getItem(KEYS.camDevice) || '',
    // '' means the system default output. A device id, like the two above, is
    // a fact about this machine and is never synced.
    speakerDevice: localStorage.getItem(KEYS.speakerDevice) || '',
  }
}

export function setJoinPref(key, value) {
  const storageKey = KEYS[key]
  if (!storageKey) return
  if (typeof value === 'boolean') localStorage.setItem(storageKey, value ? '1' : '0')
  else if (value) localStorage.setItem(storageKey, String(value))
  else localStorage.removeItem(storageKey)
  // Changing it in the device check on the way into one kelabo also changes
  // the default for the next, on every device — which is what someone who has
  // just turned their camera off almost always means.
  if (SYNCED_JOIN_KEYS.includes(storageKey)) pushSettings()
}
