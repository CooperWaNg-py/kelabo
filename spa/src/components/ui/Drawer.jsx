import { useEffect } from 'react'
import { Button } from './Button'
import { Icon } from './Icon'

/**
 * Slide-over panel. Optionally expandable to cover the whole viewport.
 *
 * Fullscreen is implemented by widening the drawer itself rather than by
 * rendering a fixed-position overlay inside it: `.drawer` carries a
 * `transform` for the slide animation, which makes it a containing block, so a
 * `position: fixed` child would be clamped to the drawer instead of the
 * viewport. Growing the element sidesteps that entirely and keeps the existing
 * head/body scroll layout.
 */
export function Drawer({ open, onClose, title, titleChip, children, footer, fullscreen, onToggleFullscreen }) {
  const canFullscreen = typeof onToggleFullscreen === 'function'

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

  return (
    <>
      <div className={'drawer-veil' + (open ? ' open' : '')} onClick={onClose}></div>
      <aside
        className={'drawer' + (open ? ' open' : '') + (fullscreen ? ' fullscreen' : '')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
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
