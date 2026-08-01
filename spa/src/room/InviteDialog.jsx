import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { config } from '../config'
import { Modal } from '../components/ui/Modal'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { useToast } from '../components/Toaster'

/**
 * "Get one more person in here." One button in the control bar, both ways in.
 *
 * The two invite paths answer the same question for the two situations you
 * are actually in mid-call: you can paste something to them (the full link),
 * or you cannot — they are on a phone, and a UUID is not a thing anyone can
 * say out loud and have arrive intact (the two-minute code). Two buttons
 * used to split that decision across the control bar and a menu; one button
 * and one dialog puts the choice where it is made, next to both copies.
 *
 * The code half keeps the properties the old join-code dialog earned the
 * hard way: nothing is minted until the dialog opens, the countdown is on
 * screen the whole time (a code that quietly expires mid-sentence reads
 * exactly like a mistyped code from the other end), and running out swaps
 * the code for a button rather than leaving a dead string looking valid.
 *
 * What the code's copy puts on the clipboard is deliberately not the code
 * alone — a code without somewhere to type it is useless — but the short
 * instruction `host/enter — code XXXXXX`: short enough to read down the
 * phone verbatim, complete enough to act on.
 */
export function InviteDialog({ kelaboId, open, onClose }) {
  const toast = useToast()
  const [code, setCode] = useState('')
  const [expiresAt, setExpiresAt] = useState(0)
  const [state, setState] = useState('minting') // minting | ready | expired | error
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // Guards the mint against a second run from React's development double-mount,
  // which would spend two of the room's hourly codes for one click.
  const wanted = useRef(false)

  const inviteUrl = `${config.portalUrl}/join/${kelaboId}`

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

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      toast('Invite link copied')
    } catch {
      toast('Could not copy — select the link and copy it by hand')
    }
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(`${portalHost()}/enter — code ${code}`)
      toast('Code and link copied')
    } catch {
      toast('Could not copy — read the code out instead')
    }
  }

  return (
    <Modal
      open={open}
      onDismiss={onClose}
      label="Invite someone"
      badge={<span className="modal-icon"><Icon name="send" /></span>}
      title="Invite someone"
      actions={<Button variant="ghost" onClick={onClose}>Done</Button>}
    >
      <div className="modal-body">
        <div className="invite-way">
          <p className="invite-way-label">Send them the link</p>
          <div className="invite-link-row">
            <code className="invite-link" title={inviteUrl}>{inviteUrl}</code>
            <Button variant="outline" size="sm" onClick={copyLink}>
              <Icon name="copy" size={14} /> Copy
            </Button>
          </div>
        </div>

        <div className="invite-way">
          <p className="invite-way-label">
            Or read it down a phone — they open <strong>{portalHost()}/enter</strong> and type this in
          </p>
          {state === 'error' ? (
            <Banner kind="danger">{error}</Banner>
          ) : (
            <>
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
              <div className="invite-code-actions">
                {state === 'ready' && (
                  <Button variant="outline" size="sm" onClick={copyCode}>
                    <Icon name="copy" size={14} /> Copy code + link
                  </Button>
                )}
                {(state === 'expired' || state === 'error') && (
                  <Button variant="outline" size="sm" onClick={mint}>New code</Button>
                )}
              </div>
            </>
          )}
        </div>
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
