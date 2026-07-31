import { Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useAuth } from '../auth'
import { themeIcon, toggleTheme } from '../theme'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'

// The slim bar above unauthenticated routes (join, invitation, pairing,
// login, lobby). Signed-in pages live inside AppShell's rail instead — the
// old full nav/account variant of this bar is gone with them.
export function TopBar({ showSignIn = false }) {
  const { identity } = useAuth()
  const [icon, setIcon] = useState(themeIcon())
  const navigate = useNavigate()

  const onToggleTheme = () => {
    toggleTheme()
    setIcon(themeIcon())
  }

  return (
    <div className="topbar">
      <Link className="brand" to="/"><span className="logo" aria-hidden="true"></span>kelabo</Link>
      <div className="spacer"></div>
      {showSignIn && !identity && (
        <Button variant="ghost" size="sm" onClick={() => navigate('/login')}>Sign in</Button>
      )}
      <Button variant="ghost" size="sm" iconOnly onClick={onToggleTheme} title="Toggle theme" aria-label="Toggle theme">
        <Icon name={icon} />
      </Button>
    </div>
  )
}
