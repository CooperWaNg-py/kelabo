// Imports inside spa/src/presence/ carry the .js extension (like the transcript
// modules) because this reducer is also loaded by plain node in
// spa/test/presence.mjs, and node ESM requires it.

// The presence reducer (docs 18 §5): the stream's events -> a snapshot of who is
// online. Pure — no React, no fetch, no clock. The Gateway sends four event
// kinds and this folds them into one Map; the hook renders whatever it holds.
//
// `snapshot` is the recovery mechanism: it REPLACES the whole set, so a
// reconnect re-syncs with no server-side replay. `online`/`busy` upsert one
// person; `offline` removes them.

/** @typedef {{ online: boolean, inKelabo: boolean }} PresenceEntry */

/** A fresh, empty presence map. */
export function emptyPresence() {
  return new Map();
}

/**
 * Apply one presence event, returning a NEW Map (so React sees a changed
 * reference). Unknown kinds pass through unchanged.
 *
 * @param {Map<string, PresenceEntry>} state
 * @param {{kind:string, identity?:string, inKelabo?:boolean, online?:Array}} evt
 */
export function apply(state, evt) {
  if (!evt || typeof evt.kind !== 'string') return state
  switch (evt.kind) {
    case 'snapshot': {
      const next = new Map()
      for (const p of evt.online || []) {
        if (!p || !p.identity) continue
        next.set(p.identity, { online: true, inKelabo: !!p.inKelabo })
      }
      return next
    }
    case 'online':
    case 'busy': {
      if (!evt.identity) return state
      const next = new Map(state)
      next.set(evt.identity, { online: true, inKelabo: !!evt.inKelabo })
      return next
    }
    case 'offline': {
      if (!evt.identity || !state.has(evt.identity)) return state
      const next = new Map(state)
      next.delete(evt.identity)
      return next
    }
    default:
      return state
  }
}

/** Is this identity online right now? */
export function isOnline(state, identity) {
  return !!state.get(identity)?.online
}

/** Is this identity online AND currently in a kelabo? */
export function isInKelabo(state, identity) {
  const e = state.get(identity)
  return !!(e && e.online && e.inKelabo)
}
