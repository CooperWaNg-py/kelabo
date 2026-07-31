import { useEffect, useRef } from 'react'

/**
 * Ask before the browser's own Back takes someone out of a live kelabo.
 *
 * The in-app exits are easy — a button calls a handler that shows a dialog. The
 * browser's Back is not: it is a navigation the app never sees coming, and by
 * the time anything can react the page is already leaving. The trick is to make
 * Back land somewhere harmless first. On the way in we push a duplicate history
 * entry for the *same* URL; Back consumes that instead of leaving, `popstate`
 * fires while the page is still mounted, and only then is there something to ask
 * about. Answer "stay" and the entry goes straight back; answer "leave" and
 * `onLeave` decides where you actually end up.
 *
 * `onLeave` rather than `history.go(-2)`, which is what this did first and what
 * does not survive contact with the kelabo flow: the entry behind the room is
 * the LOBBY, and the lobby redirects straight back into the room the moment it
 * sees the kelabo has started. Backing out landed you exactly where you began,
 * every time. Where "out" is belongs to the caller, not to the depth of the
 * history stack.
 *
 * Deliberately not React Router's blocker: that needs a data router and this app
 * is on `BrowserRouter` — swapping it would touch every route to fix one arrow.
 *
 * Two details that are not optional:
 *
 *   • The pushed state SPREADS the existing one. React Router keeps `{usr, key,
 *     idx}` in `history.state` and reads `idx` back on every pop; replacing it
 *     wholesale leaves the router unable to tell which way the stack moved.
 *   • The effect runs ONCE. Everything it reads goes through a ref, because a
 *     re-run pushes a second guard entry — and then Back has to be pressed once
 *     per re-render before anything happens, which looks exactly like the guard
 *     not working at all.
 */
/**
 * `unloadEnabled` relaxes the reload/close prompt independently of the Back
 * guard: a room whose call is in `error` has nothing a reload would lose that
 * a reload would not also fix, and taxing the one action the user is about to
 * take with a browser dialog only teaches them to click through it. Defaults
 * to `enabled`.
 */
export function useLeaveGuard({ enabled, unloadEnabled = enabled, confirm, onLeave }) {
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const unloadEnabledRef = useRef(unloadEnabled)
  unloadEnabledRef.current = unloadEnabled
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm
  const onLeaveRef = useRef(onLeave)
  onLeaveRef.current = onLeave

  useEffect(() => {
    // Keeps React Router's bookkeeping intact — see above.
    const pushGuard = () =>
      window.history.pushState({ ...(window.history.state || {}), kelaboLeaveGuard: true }, '')

    let leaving = false
    pushGuard()

    const onPop = async () => {
      if (leaving) return
      // Nothing left to leave: let Back be Back.
      if (!enabledRef.current) {
        leaving = true
        window.history.back()
        return
      }
      pushGuard()
      if (!(await confirmRef.current())) return
      leaving = true
      onLeaveRef.current?.()
    }

    // Reload and tab-close are the one exit no dialog of ours can precede — the
    // browser owns that prompt, and only offers it if the page says it is busy.
    const onUnload = e => {
      if (!enabledRef.current || !unloadEnabledRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }

    window.addEventListener('popstate', onPop)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
