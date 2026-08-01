import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { TopBar } from '../components/TopBar'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { JoinCodeField } from '../components/JoinCodeField'

/**
 * The other end of a phone call: somebody said `A5B4C7` and this is where it
 * goes.
 *
 * Deliberately outside the authenticated routes, like /join and /pair. The
 * person holding a code is the one person guaranteed not to have a link, and
 * quite possibly no account either — a sign-in wall here would defeat the only
 * thing the code is for. The rail links here for people who are signed in; the
 * path is short because it gets read aloud too ("kelabo dot example slash
 * enter").
 *
 * The field itself is a component because the guest landing page carries the
 * same one (spa/src/components/JoinCodeField.jsx).
 */
export default function EnterCode() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { identity } = useAuth()

  return (
    <>
      <TopBar minimal showSignIn={!identity} />
      <main className="page-narrow">
        <section className="card card-pad anim-in">
          <h1 className="page-title">Join with a code</h1>
          <p className="page-sub">
            Somebody in a kelabo can read you a six-character code. It works for two
            minutes.
          </p>

          <JoinCodeField
            initialCode={params.get('code') || ''}
            autoFocus
            typeAnywhere
            onResolved={r => navigate(`/join/${r.kelaboId}`)}
          >
            <div className="action-row action-row-start">
              <Button as={Link} variant="ghost" to={identity ? '/' : '/login'}>
                {identity ? 'Back home' : 'Sign in instead'}
              </Button>
            </div>
            {/* The only form-note with an icon in it, and `.icon` is
                display:block, which would drop the clock onto its own line —
                so the note itself carries the icon-with-text layout. */}
            <p className="form-note" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)' }}>
              <Icon name="clock" size={14} /> Expires in two minutes. Ask for another.
            </p>
          </JoinCodeField>
        </section>
      </main>
    </>
  )
}
