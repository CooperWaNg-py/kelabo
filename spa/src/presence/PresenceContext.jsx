import { createContext, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { api } from '../api'
import { usePresence } from './usePresence.js'
import { useRing } from './useRing.js'
import { RingModal } from './RingModal'

/**
 * App-wide contact presence + ring (docs 18 §5, §6), provided ABOVE the router so
 * both the signed-in shell (Contacts, the rail) and the kelabo room — which
 * lives outside the shell — read from the same single stream. One EventSource
 * per tab, no matter how many views consume it. Ring events ride that same
 * stream and surface as a modal here, on any page.
 *
 * A guest (no identity) gets an inert value: every lookup is false, no stream.
 */
const PresenceContext = createContext({
  presence: new Map(),
  isOnline: () => false,
  inKelabo: () => false,
})

export function PresenceProvider({ children }) {
  const { identity } = useAuth()
  const navigate = useNavigate()
  const ring = useRing()
  const value = usePresence(identity, ring.handleRingEvent)

  const accept = async () => {
    const r = ring.incoming
    ring.clearRing()
    if (!r) return
    try { await api.answerRing(r.kelaboId, 'accepted') } catch {}
    // Join gets the participant cookie every in-room call needs, then straight
    // into the room — a huddle skips the lobby by design.
    const name = localStorage.getItem('kelabo-name') || (identity ? identity.split('@')[0] : 'Guest')
    try {
      await api.joinKelabo(r.kelaboId, name, 'audio-board')
      localStorage.setItem('kelabo-mode', 'audio-board')
    } catch {}
    navigate(`/m/${r.kelaboId}`)
  }

  const decline = async () => {
    const r = ring.incoming
    ring.clearRing()
    if (!r) return
    try { await api.answerRing(r.kelaboId, 'declined') } catch {}
  }

  return (
    <PresenceContext.Provider value={value}>
      {children}
      {ring.incoming && <RingModal ring={ring.incoming} onAccept={accept} onDecline={decline} />}
    </PresenceContext.Provider>
  )
}

export function usePresenceContext() {
  return useContext(PresenceContext)
}
