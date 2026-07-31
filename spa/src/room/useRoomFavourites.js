import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

/**
 * The caller's favourites, for the kelabo room's per-tile star (docs 18 §4).
 *
 * Fetched once when the room mounts. `canFavourite(id)` is true only for a
 * same-org, authenticated, non-self participant — a guest has no stable identity
 * to pin (their id is `guest:<uuid>`), and you cannot favourite yourself or
 * someone at another domain. Toggling is optimistic and silent, exactly like the
 * Contacts screen; the other person is never told.
 *
 * `me` is the caller's own participant identity (an email for a signed-in user,
 * `guest:<uuid>` for a guest — in which case there are no favourites at all).
 */
export function useRoomFavourites(me) {
  const [favs, setFavs] = useState(() => new Set())
  const meIsGuest = !me || me.startsWith('guest:') || !me.includes('@')
  const myDomain = meIsGuest ? '' : me.split('@')[1].toLowerCase()
  const busy = useRef(new Set())

  useEffect(() => {
    if (meIsGuest) return undefined
    let cancelled = false
    api.listContacts()
      .then(d => { if (!cancelled) setFavs(new Set((d.favourites || []).map(f => f.email))) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [me, meIsGuest])

  const canFavourite = useCallback((id) => {
    if (meIsGuest || !id || id === me) return false
    if (id.startsWith('guest:') || !id.includes('@')) return false
    return id.split('@')[1].toLowerCase() === myDomain
  }, [me, meIsGuest, myDomain])

  const has = useCallback((id) => favs.has(id), [favs])

  const toggle = useCallback(async (id, next) => {
    if (busy.current.has(id)) return
    busy.current.add(id)
    setFavs(prev => {
      const s = new Set(prev)
      if (next) s.add(id); else s.delete(id)
      return s
    })
    try {
      if (next) await api.favouriteContact(id)
      else await api.unfavouriteContact(id)
    } catch {
      // Roll back on failure.
      setFavs(prev => {
        const s = new Set(prev)
        if (next) s.delete(id); else s.add(id)
        return s
      })
    } finally {
      busy.current.delete(id)
    }
  }, [])

  return { canFavourite, has, toggle }
}
