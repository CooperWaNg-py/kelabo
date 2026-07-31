/**
 * The app's on/off control.
 *
 * `readOnly` renders the same switch with no `<input>` behind it, for the one
 * place the switch is not itself the control: a menu row where the whole row is
 * the button. An input nested inside a button is invalid HTML and — worse than
 * invalid — stays in the tab order, so keyboard users met a focus stop that did
 * nothing. The row owns the interaction; this just draws the state.
 */
export function Switch({ checked, onChange, disabled, ariaLabel, readOnly = false }) {
  if (readOnly) {
    return (
      <span className={'switch' + (checked ? ' is-on' : '')} aria-hidden="true">
        <span className="track"></span>
      </span>
    )
  }
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={!!checked}
        disabled={!!disabled}
        aria-label={ariaLabel}
        onChange={e => onChange?.(e.target.checked)}
      />
      <span className="track"></span>
    </label>
  )
}
