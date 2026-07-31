import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * FLIP: make a layout change look like movement instead of a cut.
 *
 * Switching layouts re-flows every tile at once. Without this the grid simply
 * blinks into a stage-and-rail and the eye loses track of who is who — which is
 * exactly the information a layout switch exists to preserve. So: measure where
 * the tiles are *before* the state change (`capture`), let React re-flow them,
 * then animate each tile from its old box to its new one.
 *
 * This only works because every layout renders the same flat list of tiles into
 * the same container element. A tile that changed DOM parent would remount and
 * have nothing to animate from — see `Stage.jsx`, where the stage/rail split is
 * CSS grid placement rather than a nested wrapper, for that reason.
 *
 * Tiles opt in with `data-flip="<stable key>"`.
 */

const DURATION = 320
const EASING = 'cubic-bezier(.22,.85,.26,1)'

export function useFlip() {
  const ref = useRef(null)
  const prevRef = useRef(null)

  const capture = useCallback(() => {
    const root = ref.current
    if (!root) return
    // No WAAPI, or the user asked for less motion: skip straight to the cut.
    if (typeof root.animate !== 'function') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return
    const map = new Map()
    for (const node of root.querySelectorAll('[data-flip]')) {
      map.set(node.dataset.flip, node.getBoundingClientRect())
    }
    prevRef.current = map
  }, [])

  // Runs on every commit but does nothing unless a capture is outstanding, so
  // the common case costs one ref read rather than a forced reflow.
  useLayoutEffect(() => {
    const prev = prevRef.current
    if (!prev) return
    prevRef.current = null
    const root = ref.current
    if (!root) return

    for (const node of root.querySelectorAll('[data-flip]')) {
      const before = prev.get(node.dataset.flip)
      if (!before?.width || !before?.height) continue
      const after = node.getBoundingClientRect()
      if (!after.width || !after.height) continue

      const dx = before.left - after.left
      const dy = before.top - after.top
      const sx = before.width / after.width
      const sy = before.height / after.height
      const moved = Math.abs(dx) > 1 || Math.abs(dy) > 1
      const resized = Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01
      if (!moved && !resized) continue

      node.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transform: 'none' },
        ],
        { duration: DURATION, easing: EASING },
      )
    }
  })

  /**
   * Wrap any state change that moves tiles. Measuring has to happen before
   * React re-renders, and every caller forgetting to do so by hand is how FLIP
   * usually rots — so callers get a wrapper instead of an instruction.
   */
  const withFlip = useCallback(fn => (...args) => {
    capture()
    return fn(...args)
  }, [capture])

  return { ref, capture, withFlip }
}
