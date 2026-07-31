import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Switch } from './Switch'

/**
 * Popover menu attached to a trigger button.
 *
 * This existed twice as hand-written absolute positioning plus a bare
 * `useState` — once in the top bar and once in the kelabo room — and neither
 * copy closed on an outside click, closed on Escape, or restored focus. Both
 * call sites now share this one, so those behaviours only had to be written
 * once and stay in sync.
 *
 * `renderTrigger` receives the props the button must spread (click handler and
 * ARIA wiring); `children` is a function called with a controller:
 *
 *     { close, view, open, back }
 *
 * `view` is the sub-panel currently showing (`null` at the root), `open(name)`
 * drills into one and `back()` returns. A menu that only ever shows one list
 * can ignore all but `close` — see the account menu.
 */
export function Menu({ renderTrigger, children, ariaLabel, className = '', onOpenChange }) {
  // `children` is a render prop, and JSX will happily hand us an ARRAY instead
  // the moment a stray character lands beside the expression — which builds
  // clean, because `vite build` is the only JSX gate in this repo and stray text
  // is valid children. It then fails at render with "children is not a
  // function", pointing at this file rather than at the menu that is wrong.
  if (typeof children !== 'function') {
    throw new Error('Menu expects a single render function as its children')
  }
  const [open, setOpen] = useState(false)
  // Which sub-panel is showing. Reset whenever the menu closes: reopening
  // should land on the root, not wherever you happened to be last time.
  const [view, setView] = useState(null)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)
  const menuId = useId()

  // Reported so surrounding chrome can stay put while a menu is up — the
  // kelabo room hides its controls on idle, and hiding the thing a reader has
  // just opened is worse than any amount of chrome. Listeners may be counting
  // opens, so this has to be exactly one report per transition, including the
  // close implied by unmounting while open.
  const reportedRef = useRef(false)
  useEffect(() => {
    if (open === reportedRef.current) return
    reportedRef.current = open
    onOpenChange?.(open)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (reportedRef.current) onOpenChange?.(false)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const close = ({ restoreFocus = false } = {}) => {
    setOpen(false)
    setView(null)
    if (restoreFocus) triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open) return undefined
    // Pointer-down rather than click: a click that starts inside the menu and
    // ends outside it (a drag over a label) shouldn't dismiss.
    const onPointerDown = e => {
      if (!wrapRef.current?.contains(e.target)) close()
    }
    const onKey = e => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // Escape backs out one level at a time, the way it does in any nested
      // menu — closing the whole thing from a sub-panel loses the place you
      // were about to come back to.
      if (view) setView(null)
      else close({ restoreFocus: true })
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, view]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={'menu-wrap ' + className} ref={wrapRef}>
      {renderTrigger({
        ref: triggerRef,
        onClick: () => setOpen(o => !o),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
      })}
      {open && (
        <div className="menu" id={menuId} role="menu" aria-label={ariaLabel}>
          {children({ close, view, open: setView, back: () => setView(null) })}
        </div>
      )}
    </div>
  )
}

/**
 * A single row in a Menu: a command, or one option out of several.
 *
 * A plain button on `.menu-line`, NOT the shared `Button`. That is the whole
 * point of it: while menu rows were `.btn`, every page-level rule of the form
 * `.something .btn` reached into them and quietly resized them. Three were
 * doing it — the collapsed rail centred the account menu's rows and stripped
 * their padding, the Settings page's button metrics outranked the menu's, and
 * `.menu .btn` ran the other way and stretched the people picker's "Ring"
 * button across its footer. None of that can happen to a class only menu rows
 * use.
 */
export function MenuItem({ children, icon, className = '', ...rest }) {
  return (
    <button type="button" role="menuitem" className={'menu-line ' + className} {...rest}>
      {icon}
      {children}
    </button>
  )
}

/**
 * A setting that is on or off: icon, label, switch.
 *
 * The switch rather than a tick on the right, because the two say different
 * things. A tick means "this is the one you picked out of several"; a switch
 * means "this is a thing that is currently on, and you may turn it off". Our
 * menus had ticks doing both jobs, so a list of independent toggles looked
 * exactly like a list of mutually exclusive options.
 *
 * Toggling never closes the menu — these get set two or three at a time.
 */
export function MenuToggle({ icon, checked, onChange, disabled, title, children }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={!!checked}
      className="menu-line"
      disabled={disabled}
      title={title}
      onClick={() => onChange?.(!checked)}
    >
      {icon}
      <span className="menu-line-label">{children}</span>
      {/* The switch is decoration here: the row is the control, so the switch
          must not be separately focusable or separately clickable. */}
      <span className="menu-line-control">
        <Switch checked={checked} readOnly />
      </span>
    </button>
  )
}

/**
 * A setting with several possible values: icon, label, the current value, and a
 * chevron into the list of them.
 *
 * This is the row that replaced a `<select>` in a popover and an eight-item
 * language list at the root of a menu. Showing the current value on the row is
 * most of the point — the answer to "what language is this kelabo being
 * transcribed in?" should not require opening anything.
 */
export function MenuValue({ icon, value, onClick, disabled, title, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      className="menu-line"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon}
      <span className="menu-line-label">{children}</span>
      <span className="menu-line-value">{value}</span>
      <Icon name="chevron-right" size={15} className="menu-line-chevron" />
    </button>
  )
}

/**
 * The title bar of a panel of options.
 *
 * With `onBack` it is the header of something you drilled into, and the arrow
 * returns. Without it, it is the header of a menu that IS a picker — the camera
 * and layout menus hang off their own chevron on the bar, so there is nothing
 * behind them to go back to — and it renders as a plain title.
 *
 * One component for both so a list of options looks the same however you
 * reached it. They were a small-caps `.menu-head` in one place and a bordered
 * back row in the other, which made two identical pickers look unrelated.
 */
export function MenuHeader({ onBack, children }) {
  if (!onBack) {
    return (
      <div className="menu-line menu-back menu-back-static">
        <span className="menu-line-label">{children}</span>
      </div>
    )
  }
  return (
    <button type="button" className="menu-line menu-back" onClick={onBack}>
      <Icon name="arrow-left" size={16} />
      <span className="menu-line-label">{children}</span>
    </button>
  )
}
