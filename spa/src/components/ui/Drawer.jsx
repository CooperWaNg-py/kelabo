import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'

/**
 * Slide-over panel. Optionally expandable to cover the whole viewport, and
 * optionally resizable by dragging its leading edge.
 *
 * Fullscreen is implemented by widening the drawer itself rather than by
 * rendering a fixed-position overlay inside it: `.drawer` carries a
 * `transform` for the slide animation, which makes it a containing block, so a
 * `position: fixed` child would be clamped to the drawer instead of the
 * viewport. Growing the element sidesteps that entirely and keeps the existing
 * head/body scroll layout.
 */

const DEFAULT_WIDTH = 440
// Narrower than this and the debug panel's two-column readouts start wrapping
// into an unreadable ladder, which is worse than not being able to shrink it.
const MIN_WIDTH = 320
const maxWidth = () => Math.round(window.innerWidth * 0.96)
const clampWidth = w => Math.max(MIN_WIDTH, Math.min(w, maxWidth()))

export function Drawer({
  open,
  onClose,
  title,
  titleChip,
  children,
  footer,
  fullscreen,
  onToggleFullscreen,
  resizable = false,
  // Where the chosen width is remembered. Device-local on purpose: a width
  // that suits a 32" monitor is most of the screen on a laptop, so this is one
  // of the settings that deliberately does not sync.
  widthKey,
}) {
  const canFullscreen = typeof onToggleFullscreen === 'function'
  const asideRef = useRef(null)

  const [width, setWidth] = useState(() => {
    if (!resizable) return null
    const saved = Number(widthKey ? localStorage.getItem(widthKey) : 0)
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : DEFAULT_WIDTH
  })

  const commit = useCallback(
    next => {
      const w = clampWidth(next)
      setWidth(w)
      if (widthKey) {
        try { localStorage.setItem(widthKey, String(w)) } catch {}
      }
      return w
    },
    [widthKey],
  )

  // A window that shrank below the remembered width would leave the drawer
  // hanging off the side with no way back — the grip goes with it.
  useEffect(() => {
    if (!resizable) return undefined
    const onResize = () => setWidth(w => (w == null ? w : clampWidth(w)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [resizable])

  // Esc exits fullscreen first, so it never yanks the panel shut from under
  // someone who only meant to shrink it back.
  useEffect(() => {
    if (!open || !fullscreen || !canFullscreen) return
    const onKey = e => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onToggleFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, fullscreen, canFullscreen, onToggleFullscreen])

  // --- dragging -------------------------------------------------------------
  // The width is written straight onto the node while the pointer moves and
  // only committed to React state on release. Re-rendering on every pointermove
  // means re-rendering everything the drawer contains — for the debug panel
  // that is a message ledger with a row per utterance — and the drag goes to
  // treacle exactly as somebody drags it wider to see more.
  const dragRef = useRef(null)

  const onGripDown = e => {
    if (fullscreen) return
    e.preventDefault()
    const node = asideRef.current
    if (!node) return
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: node.offsetWidth }
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    node.classList.add('is-resizing')
  }

  const onGripMove = e => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const node = asideRef.current
    if (!node) return
    // The drawer is anchored to the right, so dragging LEFT makes it wider.
    node.style.width = `${clampWidth(drag.startWidth + (drag.startX - e.clientX))}px`
  }

  const endDrag = e => {
    const drag = dragRef.current
    if (!drag || (e && drag.pointerId !== e.pointerId)) return
    dragRef.current = null
    const node = asideRef.current
    if (e) {
      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    }
    if (node) {
      node.classList.remove('is-resizing')
      commit(node.offsetWidth)
    }
  }

  // Arrow keys, because a drag handle that only answers to a mouse is a control
  // half the people who need the panel widest cannot use.
  const onGripKey = e => {
    if (fullscreen) return
    const step = e.shiftKey ? 64 : 24
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      commit((width ?? DEFAULT_WIDTH) + step)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      commit((width ?? DEFAULT_WIDTH) - step)
    } else if (e.key === 'Home') {
      e.preventDefault()
      commit(maxWidth())
    } else if (e.key === 'End') {
      e.preventDefault()
      commit(DEFAULT_WIDTH)
    }
  }

  // Fullscreen sets `left: 0; width: auto` in CSS, which an inline width would
  // beat — so while fullscreen the element carries no inline width at all.
  const style = resizable && !fullscreen && width ? { width: `${width}px` } : undefined

  return (
    <>
      <div className={'drawer-veil' + (open ? ' open' : '')} onClick={onClose}></div>
      <aside
        ref={asideRef}
        className={'drawer' + (open ? ' open' : '') + (fullscreen ? ' fullscreen' : '')}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {resizable && !fullscreen && (
          <div
            className="drawer-grip"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel"
            aria-valuenow={width ?? DEFAULT_WIDTH}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={typeof window === 'undefined' ? MIN_WIDTH : maxWidth()}
            tabIndex={0}
            title="Drag to resize · double-click to reset · arrow keys to nudge"
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={onGripKey}
            onDoubleClick={() => commit(DEFAULT_WIDTH)}
          />
        )}
        <div className="drawer-head">
          {title} {titleChip} <span className="spacer"></span>
          {canFullscreen && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => onToggleFullscreen(!fullscreen)}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              aria-pressed={fullscreen}
              title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            >
              <Icon name={fullscreen ? 'minimize' : 'maximize'} />
            </Button>
          )}
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </Button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  )
}
