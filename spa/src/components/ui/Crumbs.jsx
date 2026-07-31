import { Link } from 'react-router-dom'
import { Icon } from './Icon'

/**
 * "← Back / Current page" header trail. Was hand-written three times with a
 * literal "←" character and a bespoke margin; the arrow is now a real icon and
 * the spacing comes from the stylesheet.
 *
 * `backLabel` collapses to just the arrow on narrow screens (`.crumb-back-label`).
 */
export function Crumbs({ to, backLabel, here, className = '' }) {
  return (
    <nav className={'crumbs ' + className} aria-label="Breadcrumb">
      <Link to={to}>
        <Icon name="arrow-left" size={14} />
        <span className="crumb-back-label">{backLabel}</span>
      </Link>
      <span className="crumb-sep">/</span>
      <span className="crumb-here">{here}</span>
    </nav>
  )
}
