import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { config } from '../config'
import { useAuth, displayName } from '../auth'
import { TopBar } from '../components/TopBar'
import { DeviceCheck } from '../components/DeviceCheck'
import { SkeletonRows } from '../components/ui/Skeleton'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Avatar, myAvatarVariant } from '../components/ui/Avatar'
import { useToast } from '../components/Toaster'
import { useConfirm } from '../components/ConfirmDialog'
import { useLeaveGuard } from '../useLeaveGuard'

export default function Lobby() {
  const { id } = useParams()
  const toast = useToast()
  const navigate = useNavigate()
  const { identity } = useAuth()
  const confirm = useConfirm()
  const [kelabo, setKelabo] = useState(null)
  const [error, setError] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const seenRef = useRef(new Set())
  const firstLoadRef = useRef(true)

  const joinUrl = `${config.portalUrl}/join/${id}`
  const me = displayName(identity)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      api.getKelabo(id)
        .then(m => {
          if (cancelled) return
          setKelabo(m)
          setError(false)
          const participants = m.participants || []
          for (const p of participants) {
            const key = p.identity || p.displayName
            if (!seenRef.current.has(key)) {
              seenRef.current.add(key)
              if (!firstLoadRef.current) toast(`${p.displayName || 'Someone'} joined the lobby`)
            }
          }
          firstLoadRef.current = false
        })
        .catch(() => { if (!cancelled) setError(true) })
    }
    load()
    const t = setInterval(load, 3000)
    return () => { cancelled = true; clearInterval(t) }
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => {
    try { await navigator.clipboard.writeText(joinUrl) } catch {}
    toast('Invite link copied')
  }

  const cancelKelabo = async () => {
    if (cancelling) return
    setCancelling(true)
    try {
      await api.endKelabo(id)
      toast('Kelabo cancelled')
      navigate('/')
    } catch {
      setCancelling(false)
      toast('Could not cancel the kelabo')
    }
  }

  // The lobby is inside the kelabo too — a host waiting here has people
  // waiting on them, and backing out of it silently is the same surprise as
  // backing out of the room (notes #2).
  useLeaveGuard({
    enabled: !!kelabo && kelabo.status !== 'ended',
    confirm: () =>
      confirm({
        title: 'Leave the lobby?',
        body: 'You will not be taken into the kelabo when it starts. The invite link still works.',
        confirmLabel: 'Leave',
        cancelLabel: 'Stay',
        icon: 'logout',
        danger: false,
      }),
    onLeave: () => navigate(identity ? '/' : '/login', { replace: true }),
  })

  const participants = kelabo?.participants || []
  const hostIdentity = kelabo?.hostIdentity
  const isHost = !!(identity && hostIdentity && identity.email === hostIdentity)
  // Same source the room reads, so the lobby cannot promise a microphone the
  // room will not open.
  const boardOnly = (localStorage.getItem('kelabo-mode') || 'audio-board') === 'board-only'
  const started = !!kelabo?.hostJoinedAt

  useEffect(() => {
    if (started) navigate(`/m/${id}`, { replace: true })
  }, [started, id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <TopBar minimal />
      <main className="page">
        <section className="card card-pad anim-in">
          {kelabo === null && !error && <SkeletonRows n={2} />}
          {error && kelabo === null && (
            <Banner kind="danger">This kelabo link is invalid or the kelabo has ended.</Banner>
          )}
          {kelabo && (
            <>
              <div className="title-row">
                <h1 className="page-title">{kelabo.title}</h1>
                <span className="chip chip-accent">waiting<span className="waiting-dots"><i></i><i></i><i></i></span></span>
              </div>
              <p className="page-sub">Share the invite link — participants can join anytime.</p>

              <div className="field">
                <span className="label">Invite link</span>
                <div className="linkbox">
                  <span className="link-url">{joinUrl}</span>
                  <Button size="sm" onClick={copy}>
                    <Icon name="copy" size={14} />Copy
                  </Button>
                </div>
              </div>

              {/* The host never passes through the Join page, so this is their
                  only chance to look at their own camera before everyone else
                  is looking at it. Participants get it here too — the room can
                  pull them in the moment the host starts, so a check that only
                  existed on the way in would be skipped for most of them. */}
              <div className="field">
                <span className="label">Camera and microphone</span>
                <DeviceCheck disabled={boardOnly} />
                {boardOnly && (
                  <p className="form-note">You joined to watch the board only — no microphone or camera.</p>
                )}
              </div>

              <div className="section-title">
                Participants ({participants.length || 1})
              </div>
              <div>
                {participants.length === 0 && (
                  <div className="row">
                    <Avatar id={identity?.email} name={me} variant={myAvatarVariant()} />
                    <div className="row-main">
                      <div className="row-title">{me || 'You'} <span className="lp-you">(you)</span></div>
                      <div className="row-sub">host · mic ready</div>
                    </div>
                    <span className="chip chip-live">in lobby</span>
                  </div>
                )}
                {participants.map((p, i) => {
                  const pname = p.displayName || p.identity || 'Guest'
                  const isYou = me && (p.identity === identity?.email || pname === me)
                  return (
                    <div className={'row' + (i > 0 ? ' anim-in' : '')} key={p.identity || pname}>
                      <Avatar id={p.identity} name={pname} variant={p.avatarVariant} />
                      <div className="row-main">
                        <div className="row-title">
                          {pname} {isYou && <span className="lp-you">(you)</span>}
                        </div>
                        <div className="row-sub">
                          {(p.identity === hostIdentity || p.isHost) ? 'host' : (p.isGuest ? 'guest' : 'member')}
                          {p.mode ? ` · ${p.mode === 'board-only' ? 'watch board only' : 'share mic + board'}` : ''}
                        </div>
                      </div>
                      <span className="chip chip-live">in lobby</span>
                    </div>
                  )
                })}
              </div>

              {participants.length <= 1 && (
                <div className="empty lobby-wait">
                  Waiting for participants to join<span className="waiting-dots"><i></i><i></i><i></i></span>
                </div>
              )}

              {isHost && (
                <div className="action-row lobby-actions">
                  <Button variant="ghost" onClick={cancelKelabo} disabled={cancelling}>
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </Button>
                  <Button as={Link} variant="primary" to={`/m/${id}`}>
                    Start<Icon name="arrow-right" />
                  </Button>
                </div>
              )}
              <p className="form-note">
                {isHost
                  ? 'You enter first — participants waiting in the lobby are admitted when you start.'
                  : 'Waiting for the host to start the kelabo — you’ll be taken in automatically.'}
              </p>
            </>
          )}
        </section>
      </main>
    </>
  )
}
