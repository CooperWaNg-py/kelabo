import { useEffect } from 'react'

/**
 * ONE dialog, as a component and not just a convention. Confirm, prompt,
 * incoming ring, starting-soon and kelabo-ended all render through here, so
 * the veil, the Escape/backdrop dismissal, the title row and the action row
 * cannot drift apart per caller the way five hand-written copies did.
 *
 * `badge` is the ready-made node for the title's icon slot (a `.modal-icon`
 * span, or the caller's Avatar in the ring dialog). `children` is the body —
 * usually a `.modal-body` paragraph, plus an input for prompts. `actions`
 * lands in the shared right-aligned `.modal-actions` row.
 *
 * The veil stays mounted while closed (class toggles `open`) so its fade
 * transition runs. Omit `onDismiss` for dialogs that must be answered.
 * Pass `as="form"` and `onSubmit` when Enter should submit.
 */
export function Modal({ open, onDismiss, label, badge, title, actions, as: Component = 'div', onSubmit, className = '', children }) {
  useEffect(() => {
    if (!open || !onDismiss) return undefined
    const onKey = e => { if (e.key === 'Escape') onDismiss() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onDismiss])

  return (
    <div
      className={'modal-veil' + (open ? ' open' : '')}
      onClick={e => { if (e.target === e.currentTarget) onDismiss?.() }}
    >
      {open && (
        <Component className={className ? 'modal ' + className : 'modal'} role="dialog" aria-modal="true" aria-label={label} onSubmit={onSubmit}>
          <p className="modal-title">
            {badge}
            {title}
          </p>
          {children}
          <div className="modal-actions">{actions}</div>
        </Component>
      )}
    </div>
  )
}
