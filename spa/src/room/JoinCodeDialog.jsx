import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { config } from '../config'
import { Modal } from '../components/ui/Modal'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { useToast } from '../components/Toaster'

/**
 * "Read this to them." A two-minute code standing in for the kelabo URL.
 *
 * Copy invite link solves the case where you can paste something to the person.
 * This solves the one where you cannot — they are on a phone, and a UUID is not
 * a thing anyone can say out loud and have arrive intact.
 *
 * The countdown is not decoration. A code that has quietly expired mid-sentence
 * is indistinguishable, from the other end of the call, from a code the other
 * person typed wrong — so the seconds are on screen the whole time, and running
 * out swaps the code for a button rather than leaving a dead string sitting
 * there looking valid.
 */
export function JoinCodeDialog({ kelaboId, open, onClose }) {
  const toast = useToast()
  const [code, setCode] = useState('')
  const [expiresAt, setExpiresAt] = useState(0)
  const [state, setState] = useState('minting') // minting | ready | expired | error
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // Guards the mint against a second run from React's development double-mount,
  // which would spend two of the room's hourly codes for one click.
  const wanted = useRef(false)

  const mint = async () => {
    setState('minting')
    setError('')
    try {
      const r = await api.mintJoinCode(kelaboId)
      setCode(r.code)
      setExpiresAt(r.expiresAt)
      setNow(Date.now())
      setState('ready')
    } catch (e) {
      setState('error')
      setError(explain(e))
    }
  }

  useEffect(() => {
    if (!open) { wanted.current = false; return }
    if (wanted.current) return
    wanted.current = true
    mint()
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // One ticker, only while a code is actually live.
  useEffect(() => {
    if (state !== 'ready') return undefined
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [state])

  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  useEffect(() => {
    if (state === 'ready' && left === 0) setState('expired')
  }, [state, left])

  const copy = async () => {
    // The code alone is useless without somewhere to type it, so what lands on
    // the clipboard is both — for the case where they can read a message after
    // all, and you would otherwise have to type the URL out yourself.
    try {
      await navigator.clipboard.writeText(`${config.portalUrl}/enter — code ${code}`)
      toast('Code and link copied')
    } catch {
      toast('Could not copy — read the code out instead')
    }
  }

  return (
    <Modal
      open={open}
      onDismiss={onClose}
      label="Join code"
      badge={<span className="modal-icon"><Icon name="phone" /></span>}
      title="Join code"
      actions={
        <>
          {state === 'ready' && (
            <Button variant="primary" onClick={copy}>
              <Icon name="copy" size={15} /> Copy
            </Button>
          )}
          {(state === 'expired' || state === 'error') && (
            <Button variant="primary" onClick={mint}>New code</Button>
          )}
          <Button variant="ghost" onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="modal-body">
        {state === 'error' ? (
          <Banner kind="danger">{error}</Banner>
        ) : (
          <>
            <p>
              Tell someone this code. They open <strong>{portalHost()}/enter</strong> and
              type it in.
            </p>
            <div className="joincode" aria-live="polite">
              {state === 'minting' && <span className="joincode-value joincode-waiting">······</span>}
              {state === 'ready' && <span className="joincode-value">{code}</span>}
              {state === 'expired' && <span className="joincode-value joincode-dead">{code}</span>}
            </div>
            {state === 'ready' && (
              <p className="joincode-left">
                Expires in {left}s{left <= 20 ? ' — say it now' : ''}
              </p>
            )}
            {state === 'expired' && (
              <p className="joincode-left joincode-left-dead">
                Expired. Get a new one — the old one no longer works.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/** Just the host, so the instruction reads like something you can say aloud. */
function portalHost() {
  try { return new URL(config.portalUrl).host } catch { return config.portalUrl }
}

function explain(e) {
  switch (e?.code || e?.error) {
    case 'rate_limited':
      return 'Too many codes for this kelabo in the last hour. Share the invite link instead.'
    case 'kelabo_ended':
      return 'This kelabo has ended, so there is nothing to let anyone into.'
    case 'unauthenticated':
      return 'Your place in this kelabo could not be confirmed. Reload the page and try again.'
    default:
      return 'Could not get a code right now. Try again, or share the invite link.'
  }
}
