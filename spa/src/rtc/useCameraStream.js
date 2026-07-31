import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The camera, owned separately from the microphone.
 *
 * Not folded into `useMicStream` on purpose. The two devices have opposite
 * lifecycles: the mic is acquired once and held for the whole kelabo because
 * the transcript depends on it, while the camera is toggled repeatedly and must
 * genuinely release the hardware when off — a camera light that stays on after
 * you turned the camera off is the kind of thing people stop trusting an app
 * over. Sharing one getUserMedia call would mean either never releasing the
 * camera or dropping the mic every time someone toggles video.
 *
 * Turning the camera off stops the track rather than disabling it. A disabled
 * track keeps the device open and sends black frames; a stopped one turns the
 * light off, and the transport signals "no video" to peers by having nothing to
 * send (see `setLocalTrack` in the transports).
 */

const STORE_KEY = 'kelabo-camera-device'

export function useCameraStream({ enabled, initialOn = false }) {
  // Whether the camera starts on is decided before the kelabo (the device
  // check on the way in, or the saved default), never here.
  const [on, setOn] = useState(initialOn)
  const [stream, setStream] = useState(null)
  // off | requesting | live | denied | unavailable | insecure
  const [state, setState] = useState('off')
  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceIdState] = useState(() => localStorage.getItem(STORE_KEY) || '')
  const streamRef = useRef(null)

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  // The camera cannot outlive the kelabo, and "enabled" going false is the
  // only signal that it has ended.
  useEffect(() => {
    if (enabled) return
    setOn(false)
  }, [enabled])

  useEffect(() => {
    if (!on || !enabled) {
      release()
      setState('off')
      return undefined
    }
    // Kept apart from `unavailable`: "no camera on this device" and "this page
    // is not on https so the browser will not even offer the camera" need
    // completely different things from the person reading the message.
    if (!window.isSecureContext) {
      setState('insecure')
      setOn(false)
      return undefined
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unavailable')
      setOn(false)
      return undefined
    }

    let cancelled = false
    setState('requesting')
    navigator.mediaDevices
      .getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : null),
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      })
      .then(s => {
        if (cancelled) {
          s.getTracks().forEach(t => t.stop())
          return
        }
        // Switching camera: stop the old capture before publishing the new one,
        // or the previous device stays lit.
        streamRef.current?.getTracks().forEach(t => t.stop())
        streamRef.current = s
        setStream(s)
        setState('live')
        // The label of a device is only readable once permission has been
        // granted, so the list is worth refreshing exactly here.
        navigator.mediaDevices.enumerateDevices?.()
          .then(all => {
            if (!cancelled) setDevices(all.filter(d => d.kind === 'videoinput'))
          })
          .catch(() => {})
      })
      .catch(err => {
        if (cancelled) return
        // An exact deviceId that no longer exists (unplugged webcam) fails with
        // OverconstrainedError. Forget it and let the next attempt use the
        // default rather than leaving the user unable to turn video on at all.
        if (err?.name === 'OverconstrainedError' && deviceId) {
          localStorage.removeItem(STORE_KEY)
          setDeviceIdState('')
          return
        }
        setState(err?.name === 'NotFoundError' ? 'unavailable' : 'denied')
        setOn(false)
      })

    return () => { cancelled = true }
  }, [on, enabled, deviceId, release])

  useEffect(() => () => release(), [release])

  const setDeviceId = useCallback(id => {
    setDeviceIdState(id)
    if (id) localStorage.setItem(STORE_KEY, id)
    else localStorage.removeItem(STORE_KEY)
  }, [])

  const toggle = useCallback(() => setOn(v => !v), [])

  return {
    on,
    stream,
    state,
    devices,
    deviceId,
    setDeviceId,
    toggle,
    setOn,
    error: state === 'denied' || state === 'unavailable' || state === 'insecure' ? state : null,
  }
}
