import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { TopBar } from '../components/TopBar'
import { Button } from '../components/ui/Button'
import { Banner } from '../components/ui/Banner'
import { Icon } from '../components/ui/Icon'
import { Skeleton } from '../components/ui/Skeleton'
import { useTypeAnywhere } from '../useTypeAnywhere'

/**
 * "Is this you?" — approving a coding agent on your own machine (docs 16 §6).
 *
 * The developer runs `kelabo login`, their terminal prints a short code, and
 * they type it here while signed in. That is the whole ceremony, and the shape
 * matters: the token is never displayed, never lands in shell history, and the
 * approval is an authenticated action taken by the person whose identity is
 * being delegated.
 *
 * What is being granted is worth stating plainly on the page rather than in a
 * doc nobody reads. An agent bridge can read the transcript of kelabos you are
 * in and post to their boards as you. It cannot read your files, your email, or
 * anything else in Kelabo.
 */

function normalize(raw) {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

export default function PairAgent() {
  const [params] = useSearchParams()
  const { identity, loading: authLoading } = useAuth()

  // A code can arrive in the URL when the bridge opened the browser itself.
  const [code, setCode] = useState(normalize(params.get('code') || ''))
  const [pending, setPending] = useState(null)
  const [state, setState] = useState('idle') // idle | checking | found | approving | done | error
  const [error, setError] = useState('')
  const codeRef = useRef(null)

  // Typing or pasting the code anywhere on the page fills the code box.
  useTypeAnywhere(codeRef, !!identity && state !== 'done')

  const complete = code.replace('-', '').length === 8

  // Look the code up as soon as it is complete, so the page can say what is
  // being authorized before anything is granted.
  useEffect(() => {
    if (!complete || !identity || state === 'done') return
    let cancelled = false
    setState('checking')
    setError('')
    api.getPendingAgent(code)
      .then(data => {
        if (cancelled) return
        setPending(data)
        setState('found')
      })
      .catch(err => {
        if (cancelled) return
        setPending(null)
        setState('error')
        setError(explain(err))
      })
    return () => { cancelled = true }
  }, [code, complete, identity]) // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    setState('approving')
    setError('')
    try {
      await api.approveAgent(code)
      setState('done')
    } catch (err) {
      setState('error')
      setError(explain(err))
    }
  }

  if (authLoading) {
    return (
      <>
        <TopBar minimal showSignIn />
        <main className="page-narrow">
          <section className="card card-pad">
            <Skeleton className="skel-title" />
            <Skeleton className="skel-text" />
          </section>
        </main>
      </>
    )
  }

  if (!identity) {
    return (
      <>
        <TopBar minimal showSignIn />
        <main className="page-narrow">
          <section className="card card-pad anim-in">
            <h1 className="page-title">Connect a coding agent</h1>
            <p className="page-sub">
              Sign in first. Approving an agent delegates your Kelabo identity to it, so it has to be you.
            </p>
            <Button as={Link} to={`/login?next=${encodeURIComponent(`/pair${code ? `?code=${code}` : ''}`)}`}>
              Sign in
            </Button>
          </section>
        </main>
      </>
    )
  }

  return (
    <>
      <TopBar minimal />
      <main className="page-narrow">
        <section className="card card-pad anim-in">
          <h1 className="page-title">Connect a coding agent</h1>
          <p className="page-sub">
            Your terminal printed a code when you ran <code>kelabo login</code>. Type it here.
          </p>

          {state === 'done' ? (
            <>
              <Banner kind="success">
                <Icon name="check" size={15} /> Connected. Your agent can join kelabos now — go back to your
                terminal.
              </Banner>
              <p className="page-sub page-sub-tight">
                You can revoke it any time in <Link to="/settings">Settings → Agents</Link>.
              </p>
            </>
          ) : (
            <>
              {/* `.label`, the class the rest of the app uses. This was
                  `field-label`, which has no rule anywhere — so "Code" was an
                  unstyled inline span with no gap under it and the heading sat
                  flush against the box. */}
              <label className="field">
                <span className="label">Code</span>
                <input
                  className="input input-code"
                  ref={codeRef}
                  value={code}
                  onChange={e => setCode(normalize(e.target.value))}
                  placeholder="XXXX-XXXX"
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>

              {/* Errors here are about the field directly above, so they get
                  the same separation from it as any other block — not the zero
                  the bare Banner inherited. */}
              {state === 'error' && (
                <div className="pair-error"><Banner kind="danger">{error}</Banner></div>
              )}

              {state === 'found' && pending && (
                <div className="pair-summary">
                  <p className="pair-lead">
                    Connect <strong>{pending.label || pending.runtime}</strong>
                    {pending.label ? ` (${pending.runtime})` : ''} to your account?
                  </p>
                  {/* Short enough not to wrap in a 440px column. The previous
                      wording ran to "…kelabos you join with / it", stranding one
                      word on its own line (notes #10). */}
                  <ul className="pair-grants">
                    <li>Read transcripts of kelabos it joins</li>
                    <li>Post to those boards as you</li>
                  </ul>
                  <p className="page-sub page-sub-tight">
                    It runs on your own machine. Kelabo never sees your code, your model or your API keys.
                  </p>
                </div>
              )}

              {/* `primary` and `ghost`, the same pair every other confirm-or-back
                  screen in the app uses. This was an unstyled default button
                  beside a hand-written `btn btn-ghost` link, with no gap between
                  them, which is why the page's buttons looked like nothing else
                  in the system. */}
              <div className="action-row action-row-start">
                <Button variant="primary" onClick={approve} disabled={state !== 'found'}>
                  {state === 'checking' ? 'Checking…' : state === 'approving' ? 'Connecting…' : 'Connect'}
                </Button>
                <Button as={Link} variant="ghost" to="/settings">Cancel</Button>
              </div>
            </>
          )}
        </section>
      </main>
    </>
  )
}

function explain(err) {
  switch (err?.code || err?.error) {
    case 'device_code_invalid':
      return 'That code is not recognised. Check it, or run `kelabo login` again for a fresh one.'
    case 'device_code_expired':
      return 'That code has expired. Run `kelabo login` again for a fresh one.'
    default:
      return err?.message || 'Could not connect the agent. Try again.'
  }
}
