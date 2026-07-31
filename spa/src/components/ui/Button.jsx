import { forwardRef } from 'react'

// Every visual "kind" of button in the app, mapped to the CSS classes already
// defined in styles/kelabo.css. Adding a new look means adding one line here
// (and the matching class in the stylesheet) instead of hand-typing class
// strings at every call site.
const VARIANT_CLASS = {
  primary: 'btn-primary',
  outline: 'btn-outline',
  'outline-danger': 'btn-outline-danger',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  'danger-ghost': 'btn-danger-ghost',
  social: 'btn-social',
}

const SIZE_CLASS = { md: '', sm: 'btn-sm' }

// `iconOnly` squares the button off. Without it a lone 16px glyph inherits the
// horizontal text padding and renders as a wide, off-centre pill.

/**
 * Shared button. Renders a native `<button>` by default; pass `as={Link}`
 * (react-router) with a `to`, or `as="a"` with an `href`, to get the same
 * look on a link. `variant` controls color/emphasis, `size` controls the
 * height/padding scale — see kelabo.css for the underlying `.btn-*` classes.
 */
export const Button = forwardRef(function Button(
  { as: Component = 'button', variant = 'outline', size = 'md', block = false, iconOnly = false, className = '', type, ...rest },
  ref
) {
  const cls = [
    'btn',
    VARIANT_CLASS[variant] || '',
    SIZE_CLASS[size] || '',
    block ? 'btn-block' : '',
    iconOnly ? 'btn-icon' : '',
    className,
  ].filter(Boolean).join(' ')
  // Native buttons default to type="submit" inside a <form>, which is rarely
  // what a "Cancel"/"Edit"/etc. button wants — opt in explicitly instead.
  const typeProp = Component === 'button' ? { type: type || 'button' } : {}
  return <Component ref={ref} className={cls} {...typeProp} {...rest} />
})
