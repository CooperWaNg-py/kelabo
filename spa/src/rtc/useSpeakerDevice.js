import { useCallback, useEffect, useState } from 'react'
import { joinPrefs, setJoinPref } from '../joinPrefs'

/**
 * Which audio output the call plays through.
 *
 * Mic and camera have been selectable since the room existed; the speaker was
 * the one device the room silently decided for you — a laptop docked to a
 * conference speaker played the call through its own lid speakers and there
 * was nothing to click. `setSinkId` is the whole mechanism; this hook only
 * owns the device list and the remembered choice ('' = system default, a fact
 * about this machine, never synced — see joinPrefs.js).
 *
 * Safari has no `setSinkId` at all, so `supported: false` hides the control
 * rather than offering a picker that does nothing.
 */
export function useSpeakerDevice() {
  const supported =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
  const [deviceId, setDeviceIdState] = useState(() => joinPrefs().speakerDevice)
  const [devices, setDevices] = useState([])

  useEffect(() => {
    if (!supported || !navigator.mediaDevices?.enumerateDevices) return undefined
    let cancelled = false
    // Labels are only populated once *some* capture permission is granted; in
    // a kelabo the microphone prompt has already taken care of that, and the
    // devicechange listener re-reads when the browser learns names later or a
    // device is plugged in mid-call.
    const refresh = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        if (!cancelled) setDevices(all.filter(d => d.kind === 'audiooutput'))
      } catch {}
    }
    refresh()
    navigator.mediaDevices.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh)
    }
  }, [supported])

  const setDeviceId = useCallback(id => {
    setDeviceIdState(id || '')
    setJoinPref('speakerDevice', id || '')
  }, [])

  return { supported, deviceId, devices, setDeviceId }
}
