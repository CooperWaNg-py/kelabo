import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Auto-hiding room chrome.
 *
 * The room is a full-viewport surface, so every pixel of permanent chrome is a
 * pixel not showing the kelabo. Controls fade out after a moment of stillness
 * and come back on the first sign of the pointer or keyboard.
 *
 * `hold` exists because "no mouse movement" is a bad proxy for "not being used":
 * reading an open menu, or hovering the control bar itself, must not make the
 * thing under the cursor disappear. Anything that would be rude to hide takes a
 * hold while it is up and releases it after.
 */

const EVENTS = ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart']

export function useIdleChrome({ delay = 2800, enabled = true } = {}) {
  const [idle, setIdle] = useState(false)
  const holdsRef = useRef(0)
  const timerRef = useRef(0)

  const arm = useCallback(() => {
    clearTimeout(timerRef.current)
    if (!enabled || holdsRef.current > 0) return
    timerRef.current = setTimeout(() => setIdle(true), delay)
  }, [delay, enabled])

  const wake = useCallback(() => {
    setIdle(false)
    arm()
  }, [arm])

  useEffect(() => {
    if (!enabled) {
      setIdle(false)
      clearTimeout(timerRef.current)
      return undefined
    }
    const onActivity = () => wake()
    for (const ev of EVENTS) window.addEventListener(ev, onActivity, { passive: true })
    arm()
    return () => {
      for (const ev of EVENTS) window.removeEventListener(ev, onActivity)
      clearTimeout(timerRef.current)
    }
  }, [enabled, wake, arm])

  /** Counted, not boolean: two overlapping holders must not cancel each other. */
  const hold = useCallback(on => {
    holdsRef.current = Math.max(0, holdsRef.current + (on ? 1 : -1))
    wake()
  }, [wake])

  return { idle, wake, hold }
}
