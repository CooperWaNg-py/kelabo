/**
 * The room's layouts.
 *
 * One list, used by the switcher, the keyboard shortcuts and the persisted
 * preference — adding a layout means adding an entry here and a `[data-layout]`
 * block in room.css, not touching the stage.
 */

export const LAYOUTS = [
  {
    id: 'grid',
    label: 'Grid',
    icon: 'grid',
    hint: 'Everyone the same size',
  },
  {
    id: 'focus',
    label: 'Focus',
    icon: 'layout-focus',
    hint: 'One card large, the rest in a rail — click any card to put it on the stage',
  },
  {
    id: 'spotlight',
    label: 'Spotlight',
    icon: 'spotlight',
    hint: 'Like Focus, but the stage follows whoever is speaking',
  },
]

export const DEFAULT_LAYOUT = 'grid'

/** Layouts that split the stage into one large card plus a rail. */
export function isStageLayout(id) {
  return id === 'focus' || id === 'spotlight'
}

/**
 * Every kelabo opens in the grid.
 *
 * The layout used to be remembered across kelabos, which sounds helpful and is
 * not: focus and spotlight are answers to what was happening in *one* kelabo —
 * a share to read, a person presenting — and restoring them on the way into the
 * next one drops you into a view of a room you have not seen yet, with four of
 * the five people in a rail. Grid is the only layout that makes no claim about
 * what matters, so it is where every kelabo starts. Switching during a kelabo
 * still works; it just does not follow you out.
 */
export function loadLayout() {
  return DEFAULT_LAYOUT
}

/**
 * Column count for the grid. Squarish rather than as-wide-as-possible: tiles
 * are 16:9, so a 5-across row of six people is mostly empty canvas.
 */
export function gridColumns(count) {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  if (count <= 16) return 4
  return 5
}
