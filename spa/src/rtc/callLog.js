/**
 * The call debug log — one append-only, timestamped text stream for every
 * connection/media event the conference stack produces: join, ICE gathering
 * and candidates, connection-state transitions, SFU session/publish/pull
 * round trips, renegotiations, recoveries and rebuilds.
 *
 * The failure this exists for never reproduces on demand: two people in a
 * kelabo, audio flowing one way or not at all, and by the time anyone looks
 * the tab has been reloaded and the evidence is gone. So while the debug flag
 * is on (`kelabo-debug` in localStorage — the same flag that opens the debug
 * drawer), every event worth knowing about is appended here AND mirrored back
 * into localStorage, capped, so the reload that is everyone's first recovery
 * attempt does not erase the record of what made it necessary. The drawer's
 * Call log card views, copies and downloads it on demand.
 *
 * Pure, in the style of reconcile.js and recovery.js: storage, the clock and
 * the flag are injected, so test/callLog.mjs drives it under plain node. The
 * transports import the browser singleton at the bottom; nothing here touches
 * React. (Imports carry `.js` for the same reason as the other pure modules.)
 *
 * What is logged is metadata, never media and never secrets: ICE server
 * counts and TURN URLs are fine, TURN credentials and raw SDP are not —
 * call sites log the SDP's byte length, not the SDP.
 */

const KEY = 'kelabo-call-log'

// localStorage is the persistence of last resort and is shared with
// everything else the app stores. 200k chars is many hours of call events and
// stays far clear of the 5MB quota even with a busy session alongside.
const MAX_CHARS = 200_000

// Writes are debounced: an ICE gather emits a candidate per line and a busy
// renegotiation can produce dozens of events a second, none of which deserves
// its own synchronous localStorage write. flush() covers the page dying
// before the timer fires.
const PERSIST_DEBOUNCE_MS = 1000

/** Serialize the optional data tail. Errors serialize as {} without help. */
function safeData(data) {
  if (data == null) return ''
  try {
    const seen = new Set()
    return ' ' + JSON.stringify(data, (k, v) => {
      if (v instanceof Error) return { message: v.message, code: v.code, status: v.status }
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]'
        seen.add(v)
      }
      return v
    })
  } catch {
    return ' [unserializable]'
  }
}

/**
 * @param {{ enabled: () => boolean, storage: Pick<Storage,'getItem'|'setItem'|'removeItem'>|null,
 *           now?: () => Date, maxChars?: number, key?: string,
 *           persistDebounceMs?: number }} deps
 */
export function createCallLog({ enabled, storage, now = () => new Date(), maxChars = MAX_CHARS, key = KEY, persistDebounceMs = PERSIST_DEBOUNCE_MS }) {
  /** @type {string[]} */
  let lines = []
  let chars = 0
  let timer = null

  const trim = () => {
    // Keep at least one line even if it alone exceeds the budget: an empty
    // log that claims to have events is worse than an oversized one.
    while (chars > maxChars && lines.length > 1) chars -= lines.shift().length + 1
  }

  // A reload is the most common reaction to a broken call, and the whole
  // point of the log is surviving it: pick up whatever the previous page
  // left behind.
  try {
    const prior = storage?.getItem(key)
    if (prior) {
      lines = prior.split('\n').filter(Boolean)
      chars = lines.reduce((a, l) => a + l.length + 1, 0)
      trim()
    }
  } catch {}

  const persist = () => {
    timer = null
    if (!storage) return
    try { storage.setItem(key, lines.join('\n')) } catch {}
  }
  const schedulePersist = () => {
    if (!storage || timer) return
    timer = setTimeout(persist, persistDebounceMs)
  }

  const push = (level, scope, msg, data) => {
    // Read lazily, on every event, so flipping the flag mid-call takes effect
    // without a reload — mid-call is exactly when it gets flipped.
    if (!enabled()) return
    const line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${safeData(data)}`
    lines.push(line)
    chars += line.length + 1
    trim()
    schedulePersist()
  }

  return {
    debug: (scope, msg, data) => push('debug', scope, msg, data),
    info: (scope, msg, data) => push('info', scope, msg, data),
    warn: (scope, msg, data) => push('warn', scope, msg, data),
    error: (scope, msg, data) => push('error', scope, msg, data),
    /** The whole log as one copy-pasteable text block. */
    text: () => lines.join('\n'),
    count: () => lines.length,
    clear: () => {
      lines = []
      chars = 0
      if (timer) { clearTimeout(timer); timer = null }
      try { storage?.removeItem(key) } catch {}
    },
    /** Write through now — on pagehide the debounce timer will never fire. */
    flush: () => {
      if (!timer) return
      clearTimeout(timer)
      persist()
    },
  }
}

/** The browser instance the transports and useRtc log to. */
export const callLog = createCallLog({
  enabled: () => {
    try { return localStorage.getItem('kelabo-debug') === '1' } catch { return false }
  },
  storage: typeof localStorage === 'undefined' ? null : localStorage,
})

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => callLog.flush())
}
