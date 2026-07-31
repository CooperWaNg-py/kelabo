import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './Icon'

/**
 * A form dropdown that opens OUR list, not the operating system's.
 *
 * A native `<select>` can be styled shut but never open: the option list is OS
 * chrome, so every dropdown in the app popped a system-grey panel that matched
 * nothing. Menus solved this same problem with `.menu` rows (see Menu.jsx);
 * this is the form-field flavour of the same answer — an `.input`-styled
 * trigger and a `.menu`-styled listbox, so a dropdown looks like the field it
 * is and opens into rows that look like every other popover in the app.
 *
 * Deliberately not a Menu: a Menu is commands, this is one value out of
 * several, and it carries the listbox ARIA (`role="option"`, `aria-selected`)
 * a screen reader expects from something that replaced a `<select>`.
 *
 *   <Select value={v} onChange={setV} options={[{ value, label }, …]} />
 *
 * `options` values are compared with `===` and handed back as given, so a
 * number stays a number — the `<select>` this replaces stringified everything
 * and every call site had to remember to convert back.
 */
export function Select({ value, onChange, options, id, ariaLabel, className = '', disabled }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  const triggerRef = useRef(null)
  const listRef = useRef(null)
  const listId = useId()

  const current = options.find(o => o.value === value)

  const close = ({ restoreFocus = false } = {}) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  // Same dismissal contract as Menu: pointer-down outside, Escape restores
  // focus to the trigger. Duplicated rather than shared because the two close
  // over different state; the contract is small enough that drift would be
  // visible immediately.
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = e => {
      if (!wrapRef.current?.contains(e.target)) close()
    }
    const onKey = e => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close({ restoreFocus: true })
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Opening lands focus on the row you already have, like a native select.
  useEffect(() => {
    if (!open) return
    const el =
      listRef.current?.querySelector('[aria-selected="true"]') ||
      listRef.current?.querySelector('[role="option"]')
    el?.focus()
  }, [open])

  const onListKey = e => {
    const opts = [...(listRef.current?.querySelectorAll('[role="option"]') || [])]
    const i = opts.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); (opts[i + 1] || opts[0])?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (opts[i - 1] || opts[opts.length - 1])?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); opts[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1]?.focus() }
    else if (e.key === 'Tab') close()
  }

  const pick = o => {
    onChange?.(o.value)
    close({ restoreFocus: true })
  }

  return (
    // The width class rides on the wrap as well as the trigger: the wrap is
    // what sits in the form row (and what the open list sizes against), so
    // `input-narrow` or a flexed picker class must constrain it, not just the
    // button inside it.
    <div className={'menu-wrap select-wrap ' + className} ref={wrapRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={'input select-trigger ' + className}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {/* The sizer stacks every label invisibly in the value's grid cell, so
            the closed box is as wide as its widest option — the native-select
            behaviour that lets the open list match the box exactly instead of
            choosing between outgrowing it and writing "years" as "y…". */}
        <span className="select-col">
          <span className="select-value">{current ? current.label : ''}</span>
          <span className="select-sizer" aria-hidden="true">
            {options.map((o, i) => (
              <span key={`${i}-${String(o.value)}`}>{o.label}</span>
            ))}
          </span>
        </span>
        <Icon name="chevron-down" size={15} className="select-chevron" />
      </button>
      {open && (
        <div
          className="menu select-menu"
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          ref={listRef}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <button
              key={`${i}-${String(o.value)}`}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className="menu-line"
              onClick={() => pick(o)}
            >
              <span className="menu-line-label">{o.label}</span>
              {o.value === value && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
