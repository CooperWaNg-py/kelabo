import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/ui/Icon'
import { Avatar } from '../components/ui/Avatar'
import { speakerClass } from '../components/SpeakerTag'

/**
 * One person in the room.
 *
 * The card is size-agnostic: `variant` only picks a CSS class, and grid / rail /
 * stage are the same element at different sizes. That is what lets a layout
 * switch animate (see `useFlip`) instead of unmounting the card and building a
 * different one somewhere else.
 *
 * The media box holds a camera when there is one and an avatar when there is
 * not, at any size, in any layout — nothing above this component knows which.
 */

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/[\s@._-]+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

const LEVEL_FLOOR_DB = -60
const SPEAK_ON = 0.14
const SPEAK_OFF = 0.07
const SPEAK_HANG_MS = 420

/**
 * Level drives a CSS custom property on the node directly rather than React
 * state. At 60fps with a tile per participant, re-rendering to move a ring is
 * the single most expensive thing the room could do; only the boolean
 * "is this person speaking" — which changes about once a sentence — is state.
 */
function useSpeaking(stream, nodeRef, muted) {
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    const node = nodeRef.current
    if (node) node.style.setProperty('--level', '0')
    if (!stream || !stream.getAudioTracks().length) {
      setSpeaking(false)
      return undefined
    }
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return undefined
    let ctx
    try {
      ctx = new AC()
    } catch {
      return undefined
    }

    // A context created before the page has had a user gesture starts
    // suspended, and a suspended analyser reads pure silence — so the meter sits
    // flat and nobody is ever "speaking", with no error anywhere to say why.
    // Chrome's gesture bookkeeping differs by platform, so this cannot be
    // assumed either way: resume now, and again on the first interaction if that
    // did not take.
    const resume = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}) }
    resume()
    const gestures = ['pointerdown', 'keydown', 'touchstart']
    for (const ev of gestures) window.addEventListener(ev, resume, { passive: true })

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.6
    ctx.createMediaStreamSource(stream).connect(analyser)

    const buf = new Float32Array(analyser.fftSize)
    let raf = 0
    let loudUntil = 0
    let on = false

    const tick = () => {
      analyser.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9)
      const level = Math.max(0, Math.min(1, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB))
      nodeRef.current?.style.setProperty('--level', String(level.toFixed(3)))

      // Hysteresis plus a hang time: a bare threshold makes the ring strobe on
      // every syllable gap, which reads as a connection problem rather than
      // speech.
      const now = performance.now()
      if (level > SPEAK_ON) loudUntil = now + SPEAK_HANG_MS
      const next = level > SPEAK_ON || (on && level > SPEAK_OFF) || now < loudUntil
      if (next !== on) {
        on = next
        setSpeaking(next)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      for (const ev of gestures) window.removeEventListener(ev, resume)
      ctx.close().catch(() => {})
    }
  }, [stream, nodeRef])

  useEffect(() => {
    if (muted) setSpeaking(false)
  }, [muted])

  return speaking && !muted
}

/**
 * Whether a video track is actually carrying pictures.
 *
 * A camera being switched off does not remove the track — the transports swap
 * it out of the sender they already negotiated, because renegotiating with
 * every peer on every toggle is far worse. What reaches this side is the RTP
 * flow stopping, which the browser *may* report as `mute` on the receiving
 * track.
 *
 * "May" is the whole problem. Through an SFU that event is not dependable: the
 * relay holds the subscription open and simply forwards nothing, and the
 * receiver cannot tell that from a network that went quiet — so it kept the
 * last decoded frame on screen, and a camera switched off stayed a frozen
 * photograph of its owner for the rest of the kelabo. This is still read
 * because it is the fastest signal when it does fire, but `cameraOn` from the
 * roster is what actually settles it.
 */
function useVideoLive(track) {
  const [live, setLive] = useState(false)

  useEffect(() => {
    if (!track) {
      setLive(false)
      return undefined
    }
    const sync = () => setLive(!track.muted && track.readyState === 'live')
    sync()
    track.addEventListener('mute', sync)
    track.addEventListener('unmute', sync)
    track.addEventListener('ended', sync)
    return () => {
      track.removeEventListener('mute', sync)
      track.removeEventListener('unmute', sync)
      track.removeEventListener('ended', sync)
    }
  }, [track])

  return live
}

const STATUS_CHIP = {
  connecting: { label: 'connecting…', title: 'Negotiating the media connection.' },
  reconnecting: { label: 'reconnecting…', title: 'The media connection dropped and is being re-established.' },
  failed: {
    label: 'no audio',
    title: 'The media connection could not be established — usually a firewall blocking WebRTC. TURN relay should normally cover this.',
  },
}

export function ParticipantCard({
  id,
  // The person behind the tile, for the generated avatar. `id` is a slot in
  // this room ('self', a participant id); this is who they are, so their avatar
  // is the same everywhere in the app. Falls back to `id`.
  seedId,
  // Their chosen identicon re-roll, carried on the same payload as seedId.
  seedVariant,
  name,
  stream,
  // Where the picture comes from, when it is not the same stream as the audio.
  // A remote peer's camera and microphone arrive together; your own do not —
  // the mic is held for the whole kelabo and the camera comes and goes, so
  // they are two captures (see useCameraStream).
  videoStream,
  isSelf = false,
  muted = false,
  // What the owner says their camera is doing, from the roster. `null` means
  // nobody has said — an older peer, or a moment before their first report —
  // and the track is trusted on its own, exactly as before.
  cameraOn = null,
  status = 'live',
  note,
  variant = 'grid',
  onOpen,
  onSpeakingChange,
  // Favourite affordance (docs 18 §4): shown only for a same-org, non-guest,
  // non-self participant. `favourited` is the caller's current state; `onFavourite`
  // toggles it. Absent props hide the control entirely.
  canFavourite = false,
  favourited = false,
  onFavourite,
}) {
  const nodeRef = useRef(null)
  const videoRef = useRef(null)
  const speaking = useSpeaking(stream, nodeRef, muted)
  const media = videoStream ?? stream
  const videoTrack = media?.getVideoTracks?.()[0] ?? null
  // The owner's word wins. Only they know the difference between "switched off"
  // and "the last second of network was bad", and the tile has to fall back to
  // the avatar the moment they say so rather than hold a stale frame.
  const videoLive = useVideoLive(videoTrack) && cameraOn !== false

  useEffect(() => {
    const el = videoRef.current
    if (el && el.srcObject !== media) el.srcObject = media ?? null
  }, [media, videoTrack])

  useEffect(() => {
    onSpeakingChange?.(id, speaking)
  }, [id, speaking, onSpeakingChange])

  const chip = STATUS_CHIP[status]
  const label = name + (isSelf ? ' (you)' : '')

  return (
    <div
      ref={nodeRef}
      data-flip={id}
      className={
        'tile tile-person tile-' + variant +
        (speaking ? ' is-speaking' : '') +
        (isSelf ? ' tile-self' : '') +
        (videoLive ? ' has-video' : '')
      }
      role="button"
      tabIndex={0}
      aria-label={`${label} — open on the stage`}
      title={label}
      onClick={() => onOpen?.(id)}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onOpen?.(id)
      }}
    >
      <div className="tile-media">
        {/* The avatar stays mounted under the video rather than swapping with
            it: a camera toggling off should reveal the face behind it, not
            re-run a mount animation, and a video element that is torn down and
            rebuilt on every toggle flashes black on the way back. */}
        {/* Initials, because a tile has to be answerable at a glance and a
            pattern is not a name — a camera-off tile is often all you have to go
            on. The person's generated identicon fills the same circle behind
            them, washed out to stay a backdrop: it is what separates two people
            whose initials and colour happen to collide, and centred here it
            reads as one face rather than a badge stranded in a corner. */}
        <span className={'tile-avatar ' + speakerClass(name)}>
          <Avatar id={seedId || id} name={name} variant={seedVariant} title={name} />
          <span className="tile-avatar-initials">{initialsOf(name)}</span>
        </span>
        {videoTrack && (
          <video ref={videoRef} autoPlay playsInline muted={isSelf} />
        )}
        <span className="tile-ring" aria-hidden="true"></span>
      </div>

      <div className="tile-badges">
        {canFavourite && (
          <button
            className={'tile-badge tile-fav' + (favourited ? ' on' : '')}
            title={favourited ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
            aria-label={favourited ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
            aria-pressed={favourited}
            onClick={e => { e.stopPropagation(); onFavourite?.(id, !favourited) }}
          >
            <Icon name="star" size={13} />
          </button>
        )}
        {muted && (
          <span className="tile-badge tile-badge-muted" title="Microphone muted">
            <Icon name="mic-off" size={13} />
          </span>
        )}
        {note && (
          <span className="tile-badge" title="Your camera is on, but the call is not connected — nobody else is receiving it.">
            {note}
          </span>
        )}
        {chip && (
          <span className={'tile-badge' + (status === 'failed' ? ' tile-badge-bad' : '')} title={chip.title}>
            {chip.label}
          </span>
        )}
      </div>

      <div className="tile-name">
        <span className="tile-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span className="tile-name-text">{label}</span>
      </div>
    </div>
  )
}
