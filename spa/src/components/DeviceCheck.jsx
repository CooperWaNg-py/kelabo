import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './ui/Icon'
import { Select } from './ui/Select'
import { joinPrefs, setJoinPref } from '../joinPrefs'

/**
 * The last thing before a kelabo: what your microphone and camera are about
 * to do, while you can still change it.
 *
 * Toggling here is not a preview of a decision — it IS the decision. Every
 * change is written to the shared join preferences the moment it is made, so
 * the room reads exactly what was on screen, and someone who never opens this
 * gets the same defaults from Settings. The alternative, "apply on join", loses
 * the choice for anyone who is pulled into the room by the host starting it,
 * which is most participants.
 *
 * It also does the one job a checkbox cannot: proves the hardware works. A mic
 * that is muted in the operating system, a camera claimed by another app, a
 * headset that vanished when Bluetooth dropped — all of these look completely
 * fine in a settings screen and are obvious the moment you see a level meter
 * that does not move.
 */

const LEVEL_FLOOR_DB = -60

// Purely a wedge-breaker, not a patience limit: requests are serialized so the
// person only ever sees one permission prompt, and a `getUserMedia` that never
// settles — a microphone claimed by another application, a machine with no
// audio backend at all — would otherwise block the camera behind it forever.
// Generous, because a prompt left open while somebody reads it is normal and
// must not be cut short.
const DEVICE_TIMEOUT_MS = 20000

async function capture(constraints) {
  let timedOut = false
  const stream = await Promise.race([
    navigator.mediaDevices.getUserMedia(constraints).then(s => {
      // Arrived after we gave up: release it rather than leaving a device open
      // that nothing is going to show.
      if (timedOut) { s.getTracks().forEach(t => t.stop()); return null }
      return s
    }),
    new Promise(resolve => setTimeout(() => { timedOut = true; resolve(null) }, DEVICE_TIMEOUT_MS)),
  ])
  if (!stream) throw new Error('device_timeout')
  return stream
}

/** Live input level from a stream, written to a node rather than to state. */
function useMeter(stream, barsRef) {
  useEffect(() => {
    const paint = level => {
      const node = barsRef.current
      if (node) node.style.setProperty('--level', String(level))
    }
    paint(0)
    if (!stream?.getAudioTracks().length) return undefined
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return undefined
    let ctx
    try {
      ctx = new AC()
    } catch {
      return undefined
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.6
    ctx.createMediaStreamSource(stream).connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    let raf = 0
    const tick = () => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9)
      paint(Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB)).toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      ctx.close().catch(() => {})
    }
  }, [stream, barsRef])
}

export function DeviceCheck({ disabled = false }) {
  const [prefs, setPrefs] = useState(joinPrefs)
  const [micStream, setMicStream] = useState(null)
  const [camStream, setCamStream] = useState(null)
  const [micError, setMicError] = useState(null)
  const [camError, setCamError] = useState(null)
  const [mics, setMics] = useState([])
  const [cams, setCams] = useState([])
  const videoRef = useRef(null)
  const barsRef = useRef(null)
  const micRef = useRef(null)
  const camRef = useRef(null)
  // Device requests are serialized. Asking for the microphone and the camera at
  // the same moment puts two permission prompts on screen at once — browsers
  // queue or reject the second, and the person sees a dialog about a device
  // they have not been told why we want yet. One at a time, microphone first,
  // because that is the one a kelabo cannot do without.
  const chainRef = useRef(Promise.resolve())
  const queue = useCallback(fn => {
    const next = chainRef.current.then(fn, fn)
    chainRef.current = next.catch(() => {})
    return next
  }, [])

  useMeter(micStream, barsRef)

  const update = useCallback((key, value) => {
    setJoinPref(key, value)
    setPrefs(joinPrefs())
  }, [])

  // Device labels are blank until permission has been granted once, so the list
  // is re-read after every successful capture rather than only up front.
  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setMics(all.filter(d => d.kind === 'audioinput'))
      setCams(all.filter(d => d.kind === 'videoinput'))
    } catch {}
  }, [])

  // The microphone is opened even when joining muted: "muted" is about what the
  // kelabo hears, not about whether you can check your own hardware first.
  useEffect(() => {
    if (disabled) return undefined
    let cancelled = false
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setMicError('insecure')
      return undefined
    }
    queue(async () => {
      if (cancelled) return
      try {
        const s = await capture({ audio: prefs.micDevice ? { deviceId: { ideal: prefs.micDevice } } : true })
        if (cancelled) { s.getTracks().forEach(t => t.stop()); return }
        micRef.current?.getTracks().forEach(t => t.stop())
        micRef.current = s
        setMicStream(s)
        setMicError(null)
        await refreshDevices()
      } catch (err) {
        // "Blocked" and "never answered" need different words: telling someone
        // their microphone is blocked when it is actually stuck sends them to
        // the wrong settings page.
        if (!cancelled) setMicError(err?.message === 'device_timeout' ? 'timeout' : 'denied')
      }
    })
    return () => { cancelled = true }
  }, [disabled, prefs.micDevice, refreshDevices, queue])

  useEffect(() => {
    if (disabled || !prefs.camera) {
      camRef.current?.getTracks().forEach(t => t.stop())
      camRef.current = null
      setCamStream(null)
      return undefined
    }
    let cancelled = false
    queue(async () => {
      if (cancelled || !navigator.mediaDevices?.getUserMedia) return
      try {
        const s = await capture({ video: prefs.camDevice ? { deviceId: { ideal: prefs.camDevice } } : true })
        if (cancelled) { s.getTracks().forEach(t => t.stop()); return }
        camRef.current?.getTracks().forEach(t => t.stop())
        camRef.current = s
        setCamStream(s)
        setCamError(null)
        await refreshDevices()
      } catch {
        if (cancelled) return
        setCamError('denied')
        // Nothing to join with, so do not let the room try again and fail.
        update('camera', false)
      }
    })
    return () => { cancelled = true }
  }, [disabled, prefs.camera, prefs.camDevice, refreshDevices, update, queue])

  // Both devices are released when this unmounts — the room re-acquires them,
  // and holding a camera open behind a page nobody is looking at is exactly the
  // thing that leaves the light on.
  useEffect(() => () => {
    micRef.current?.getTracks().forEach(t => t.stop())
    camRef.current?.getTracks().forEach(t => t.stop())
    micRef.current = null
    camRef.current = null
  }, [])

  useEffect(() => {
    const el = videoRef.current
    if (el && el.srcObject !== camStream) el.srcObject = camStream ?? null
  }, [camStream])

  if (disabled) return null

  return (
    <div className="devcheck">
      <div className="devcheck-preview">
        {camStream ? (
          <video ref={videoRef} autoPlay playsInline muted />
        ) : (
          <div className="devcheck-off">
            <Icon name="video-off" size={22} />
            <span>{camError ? 'Camera blocked' : 'Camera off'}</span>
          </div>
        )}
      </div>

      <div className="devcheck-rows">
        <div className="devcheck-row">
          <button
            type="button"
            className={'devcheck-toggle' + (prefs.muted ? ' is-off' : ' is-on')}
            aria-pressed={!prefs.muted}
            onClick={() => update('muted', !prefs.muted)}
            title={prefs.muted ? 'Join with your microphone muted' : 'Join with your microphone on'}
          >
            <Icon name={prefs.muted ? 'mic-off' : 'mic'} size={16} />
            {prefs.muted ? 'Muted' : 'Mic on'}
          </button>

          <span className="devcheck-meter" ref={barsRef} aria-hidden="true">
            <i></i><i></i><i></i><i></i><i></i>
          </span>

          <Select
            className="btn-sm devcheck-select"
            value={prefs.micDevice}
            onChange={v => update('micDevice', v)}
            ariaLabel="Microphone"
            options={[
              { value: '', label: 'Default microphone' },
              ...mics.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
            ]}
          />
        </div>

        <div className="devcheck-row">
          <button
            type="button"
            className={'devcheck-toggle' + (prefs.camera ? ' is-on' : '')}
            aria-pressed={prefs.camera}
            onClick={() => update('camera', !prefs.camera)}
            title={prefs.camera ? 'Join with your camera on' : 'Join with your camera off'}
          >
            <Icon name={prefs.camera ? 'video' : 'video-off'} size={16} />
            {prefs.camera ? 'Camera on' : 'Camera off'}
          </button>

          {/* Holds the column the microphone's meter occupies, so both rows'
              device pickers start at the same place. */}
          <span className="devcheck-gap" aria-hidden="true"></span>

          <Select
            className="btn-sm devcheck-select"
            value={prefs.camDevice}
            onChange={v => update('camDevice', v)}
            ariaLabel="Camera"
            disabled={!cams.length}
            options={[
              { value: '', label: 'Default camera' },
              ...cams.map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` })),
            ]}
          />
        </div>
      </div>

      {micError === 'denied' && (
        <p className="devcheck-note devcheck-bad">
          Microphone blocked — you can still join and watch, but nobody will hear you and nothing will be transcribed.
        </p>
      )}
      {micError === 'timeout' && (
        <p className="devcheck-note devcheck-bad">
          Could not open the microphone — another application may be holding it. You can still join and watch.
        </p>
      )}
      {micError === 'insecure' && (
        <p className="devcheck-note devcheck-bad">
          Microphone needs a secure page — open this over https or on localhost.
        </p>
      )}
      {!micError && (
        <p className="devcheck-note">Speak — the meter moves if we can hear you.</p>
      )}
    </div>
  )
}
