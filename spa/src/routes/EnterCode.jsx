import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { TopBar } from '../components/TopBar'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { useTypeAnywhere } from '../useTypeAnywhere'

/**
 * The other end of a phone call: somebody said `A5B4C7` and this is where it
 * goes.
 *
 * Deliberately outside the authenticated routes, like /join and /pair. The
 * person holding a code is the one person guaranteed not to have a link, and
 * quite possibly not an account either — putting a sign-in wall in front of the
 * code would defeat the only thing it is for. The rail links here for people
 * who are signed in; the URL is short because it gets read aloud too.
 *
 * Redeeming resolves the code and then hands over to /join/:id. It does not
 * join. Everything that guards a join — the display-name prompt, the kelabo's
 * status, the participant cookie — stays in exactly one place.
 */

// Six characters, letter-digit three times — restated here rather than imported
// from contracts, which the SPA does not depend on and which would drag zod into
// the bundle for three constants. Same trade PairAgent.jsx makes for the device
// code. The server owns the real rule (rest-api/src/joinCode.js).
const LENGTH = 6

/**
 * Strip everything that could not be part of a code so a pasted "code: A5B4C7"
 * or a dictated "a5-b4-c7" both just work.
 *
 * Deliberately NOT filtered down to the exact alphabet: a code never contains
 * I, L, O, 0 or 1, but silently swallowing those keystrokes leaves someone
 * typing a character and watching nothing appear, with no idea why. They go in,
 * the server refuses them, and the error names them.
 */
function normalize(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LENGTH)
}

export default function EnterCode() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { identity } = useAuth()

  const [code, setCode] = useState(() => normalize(params.get('code') || ''))
  const [state, setState] = useState('idle') // idle | checking | error
  const [error, setError] = useState('')
  const codeRef = useRef(null)
  // A code is only ever tried once per value: without this the auto-submit
  // below re-fires on every render while the request is in flight.
  const tried = useRef('')

  useTypeAnywhere(codeRef, state !== 'checking')

  const complete = code.length === LENGTH

  const submit = async value => {
    setState('checking')
    setError('')
    try {
      const r = await api.redeemJoinCode(value)
      // Straight on to the ordinary join page, which asks their name and does
      // every other thing joining has always done.
      navigate(`/join/${r.kelaboId}`)
    } catch (e) {
      setState('error')
      setError(explain(e))
    }
  }

  // Six characters is short enough that pressing a button afterwards is pure
  // ceremony — the code is either right or it is not, and finding out instantly
  // is what someone reading it back off a phone call wants.
  useEffect(() => {
    if (!complete || state === 'checking' || tried.current === code) return
    tried.current = code
    submit(code)
  }, [code, complete]) // eslint-disable-line react-hooks/exhaustive-deps

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

          <label className="field">
            <span className="label">Code</span>
            <input
              className="input input-code"
              ref={codeRef}
              value={code}
              onChange={e => setCode(normalize(e.target.value))}
              placeholder="A5B4C7"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="characters"
              // A phone keyboard that offers autocorrect on this field will
              // "fix" a code into a word.
              autoCorrect="off"
            />
          </label>

          {state === 'error' && (
            <div className="pair-error"><Banner kind="danger">{error}</Banner></div>
          )}

          <div className="action-row action-row-start">
            <Button variant="primary" onClick={() => submit(code)} disabled={!complete || state === 'checking'}>
              {state === 'checking' ? 'Checking…' : 'Join'}
            </Button>
            <Button as={Link} variant="ghost" to={identity ? '/' : '/login'}>
              {identity ? 'Back home' : 'Sign in instead'}
            </Button>
          </div>

          <p className="form-note">
            <Icon name="clock" size={14} /> Codes expire two minutes after they are
            made. If yours has, ask for another.
          </p>
        </section>
      </main>
    </>
  )
}

function explain(e) {
  switch (e?.code || e?.error) {
    case 'join_code_invalid':
      return 'That code is not recognised. Check each character and try again — codes never contain I, L, O, zero or one.'
    case 'join_code_expired':
      return 'That code has expired. Ask whoever gave it to you for a fresh one.'
    case 'kelabo_ended':
      return 'That kelabo has ended.'
    case 'kelabo_not_found':
      return 'That kelabo no longer exists.'
    case 'rate_limited':
      return 'Too many tries from here. Wait a while, or ask for the invite link instead.'
    default:
      return e?.message || 'Could not check that code. Try again.'
  }
}
