import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ParticipantCard } from './ParticipantCard'
import { ScreenCard } from './ScreenCard'
import { AssistantTile } from './AssistantTile'
import { isStageLayout } from './layouts'

/**
 * Every layout, one container.
 *
 * The tiles are a single flat list of children whatever the layout; grid vs
 * stage-and-rail is CSS placement, not a different tree. That constraint is
 * what makes the switch animate: a card that moved from the grid to the stage
 * is the same DOM node, so `useFlip` can walk it from its old box to its new
 * one. Wrapping the rail in its own element — the obvious way to write this —
 * would remount every card on every switch and there would be nothing to
 * animate.
 */

// Beyond this the rail rows are too short to recognise a face in; the rest
// collapse into a count, the way Slack does it.
const RAIL_MAX = 6

/**
 * Largest tile width that fits `count` 16:9 tiles in the box, trying every
 * column count. CSS can do "equal columns" or "as many as fit", but not "the
 * arrangement that wastes the least canvas", and with 16:9 tiles the difference
 * between the two is most of the screen.
 */
function bestTileWidth(width, height, count, gap) {
  if (!width || !height || !count) return 0
  let best = 0
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const w = (width - (cols - 1) * gap) / cols
    const h = (height - (rows - 1) * gap) / rows
    const fit = Math.min(w, h * (16 / 9))
    if (fit > best) best = fit
  }
  return Math.max(96, Math.floor(best))
}

function useGridTileWidth(ref, count, active) {
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active) return undefined
    const measure = () => {
      // Everything is read from the element rather than assumed. clientWidth /
      // clientHeight include padding, and the stage's padding is what keeps
      // tiles clear of the floating chrome — measuring against it would size
      // them to a box they are not allowed to occupy. The gap is read for the
      // same reason and learned the hard way: it was hardcoded to 14, which
      // stopped being true the moment spacing became rem and scaled with the
      // viewport. Three tiles sized against a 14px gap do not fit beside a
      // 19px one, so a 4K window quietly dropped to two per row.
      const cs = getComputedStyle(el)
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
      const gap = parseFloat(cs.columnGap || cs.gap) || 0
      setWidth(bestTileWidth(w, h, count, gap))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, count, active])

  return width
}

export function Stage({
  flipRef,
  layout,
  tiles,
  stageId,
  contributions,
  onOpen,
  onCollapse,
  onSpeakingChange,
  favourites,
}) {
  const staged = isStageLayout(layout)
  const localRef = useRef(null)
  const ref = flipRef ?? localRef

  const gridCount = staged ? 0 : tiles.length
  const tileWidth = useGridTileWidth(ref, gridCount, !staged)

  // In stage layouts the rail holds everyone who is not on the stage, capped.
  const railIds = staged ? tiles.filter(t => t.id !== stageId).map(t => t.id) : []
  const visibleRail = railIds.slice(0, RAIL_MAX)
  const hiddenCount = railIds.length - visibleRail.length
  const railRows = Math.max(1, visibleRail.length + (hiddenCount > 0 ? 1 : 0))

  const variantFor = id => {
    if (!staged) return 'grid'
    if (id === stageId) return 'stage'
    return 'rail'
  }

  const style = staged
    // Explicit rows, because the stage cell spans `1 / -1` and that only means
    // "every row" against an explicit grid — with implicit rows it collapses to
    // a single one and the large card ends up rail-sized.
    ? { gridTemplateRows: `repeat(${railRows}, minmax(0, 1fr))` }
    : { '--tile-w': tileWidth ? tileWidth + 'px' : '260px' }

  return (
    <div className="stage" data-layout={layout} ref={ref} style={style}>
      {tiles.map(t => {
        const variant = variantFor(t.id)
        // Everyone past the rail cap stays mounted — a peer's audio element and
        // level analyser live in their card — but takes no space.
        const hidden = staged && variant === 'rail' && !visibleRail.includes(t.id)
        if (t.kind === 'assistant') {
          return (
            <div key="assistant" className={'tile-slot' + (hidden ? ' is-hidden' : '')} data-variant={variant}>
              <AssistantTile
                contributions={contributions}
                variant={variant}
                onOpen={onOpen}
                onCollapse={onCollapse}
              />
            </div>
          )
        }
        if (t.kind === 'screen') {
          return (
            <div key={t.id} className={'tile-slot' + (hidden ? ' is-hidden' : '')} data-variant={variant}>
              <ScreenCard
                id={t.id}
                name={t.name}
                stream={t.stream}
                isSelf={t.isSelf}
                variant={variant}
                onOpen={onOpen}
              />
            </div>
          )
        }
        return (
          <div key={t.id} className={'tile-slot' + (hidden ? ' is-hidden' : '')} data-variant={variant}>
            <ParticipantCard
              id={t.id}
              seedId={t.seedId}
              seedVariant={t.seedVariant}
              name={t.name}
              stream={t.stream}
              videoStream={t.videoStream}
              isSelf={t.isSelf}
              muted={t.muted}
              cameraOn={t.cameraOn}
              status={t.status}
              note={t.note}
              variant={variant}
              onOpen={onOpen}
              onSpeakingChange={onSpeakingChange}
              canFavourite={!t.isSelf && !!favourites?.canFavourite(t.id)}
              favourited={!!favourites?.has(t.id)}
              onFavourite={favourites?.toggle}
            />
          </div>
        )
      })}

      {hiddenCount > 0 && (
        <div className="tile-slot tile-more" data-variant="rail">
          <div className="tile tile-rail tile-overflow" aria-hidden="true">+{hiddenCount}</div>
        </div>
      )}
    </div>
  )
}
