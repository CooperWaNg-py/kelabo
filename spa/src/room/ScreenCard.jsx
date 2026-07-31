import { useEffect, useRef } from 'react'
import { Icon } from '../components/ui/Icon'

/**
 * A shared screen — its own card, not a second picture of the person sharing.
 *
 * Two differences from a person's card carry all the meaning. The video is
 * `contain`, never `cover`: a face may be cropped to fill a tile, a slide with
 * a number on the edge may not. And it is not mirrored, for the same reason —
 * text.
 *
 * It also gets no level meter and no speaking ring. The screen is not talking;
 * its owner is, on their own card.
 */
export function ScreenCard({ id, name, stream, isSelf, variant = 'grid', onOpen }) {
  const videoRef = useRef(null)

  useEffect(() => {
    const el = videoRef.current
    if (el && el.srcObject !== stream) el.srcObject = stream ?? null
  }, [stream])

  const label = isSelf ? 'Your screen' : `${name} — screen`

  return (
    <div
      data-flip={id}
      className={'tile tile-screen tile-' + variant}
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
        <video ref={videoRef} autoPlay playsInline muted />
      </div>

      <div className="tile-name">
        <span className="tile-share-mark" aria-hidden="true"><Icon name="screen-share" size={12} /></span>
        <span className="tile-name-text">{label}</span>
      </div>
    </div>
  )
}
