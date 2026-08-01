import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { useTypeAnywhere } from '../useTypeAnywhere'

/**
 * "Somebody read me a code." One field, one submit, one set of words for every
 * way it can go wrong.
 *
 * It exists as a component rather than as part of the page because there is
 * more than one door: the /enter page, and — in deployments that offer guest
 * kelabos — the guest landing page, where "join the one I was told about"
 * belongs beside "make a new one". Two copies of this would be two copies of
 * the error copy below, and those drift.
 *
 * Redeeming resolves a kelaboId and hands over to `onResolved`, which is always
 * a navigation to /join/:id. It deliberately does not join: the name prompt and
 * every other join-time rule live there, in one place.
 */

// Six characters, letter-digit three times — restated rather than imported from
// contracts, which the SPA does not depend on and which would pull zod into the
// bundle for one number. The server owns the real rule (rest-api/joinCode.js).
const LENGTH = 6

/**
 * Strip what could not be part of a code, so a pasted "code: A5B4C7" or a
 * dictated "a5-b4-c7" both just work.
 *
 * Deliberately NOT narrowed to the exact alphabet: a code never contains I, L,
 * O, 0 or 1, but swallowing those keystrokes leaves someone typing a character
 * and watching nothing appear, with no idea why. They go in, the server refuses
 * them, and `explain` names them.
 */
export function normalizeJoinCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LENGTH)
}

export function JoinCodeField({
  initialCode = '',
  onResolved,
  label = 'Code',
  submitLabel = 'Join',
  autoFocus = false,
  typeAnywhere = false,
  children,
}) {
  const [code, setCode] = useState(() => normalizeJoinCode(initialCode))
  const [state, setState] = useState('idle') // idle | checking | error
  const [error, setError] = useState('')
  const ref = useRef(null)
  // One attempt per value: without this the auto-submit below re-fires on every
  // render while the request is still in flight.
  const tried = useRef('')

  useTypeAnywhere(ref, typeAnywhere && state !== 'checking')

  const complete = code.length === LENGTH

  const submit = async value => {
    if (value.length !== LENGTH) return
    setState('checking')
    setError('')
    try {
      const r = await api.redeemJoinCode(value)
      onResolved(r)
    } catch (e) {
      setState('error')
      setError(explain(e))
    }
  }

  // Six characters is short enough that a button afterwards is ceremony — the
  // code is either right or it is not, and someone reading it back off a phone
  // call wants to know now.
  useEffect(() => {
    if (!complete || state === 'checking' || tried.current === code) return
    tried.current = code
    submit(code)
  }, [code, complete]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <label className="field">
        <span className="label">{label}</span>
        <input
          className="input input-code"
          ref={ref}
          value={code}
          onChange={e => setCode(normalizeJoinCode(e.target.value))}
          placeholder="A5B4C7"
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          // A phone keyboard offering autocorrect here will "fix" a code into a
          // word, which is unrecoverable for the person typing it.
          autoCorrect="off"
        />
      </label>

      {state === 'error' && (
        <div className="pair-error"><Banner kind="danger">{error}</Banner></div>
      )}

      <Button variant="primary" block onClick={() => submit(code)} disabled={!complete || state === 'checking'}>
        {state === 'checking' ? 'Checking…' : submitLabel}
      </Button>

      {children}
    </>
  )
}

function explain(e) {
  switch (e?.code || e?.error) {
    case 'join_code_invalid':
      return 'That code is not recognised. Check each character — codes never contain I, L, O, zero or one.'
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
