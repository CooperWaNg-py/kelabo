import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/ui/Icon'
import { AssistantStage } from './AssistantStage'
import { conKey } from './useBoard'

/**
 * The assistant, as a participant.
 *
 * It gets a card the same size and shape as a person's, in the same grid, for
 * the same reason it gets a name: it is in the kelabo, and a panel down the
 * side would make it a feature of the app rather than someone in the room. What
 * a person's card shows through video, this one shows through state — thinking,
 * searching, or having just said something.
 *
 * Clicking it puts it on the stage, which is where its contributions are
 * actually readable (`AssistantStage`).
 *
 * It deliberately takes no part in Spotlight's active-speaker follow. Spotlight
 * exists to keep the eye on whoever is talking; an agent that "speaks" in bursts
 * every couple of minutes would yank the stage away from a human mid-sentence.
 */

// A progress card whose title reads like a lookup gets the scanning animation
// rather than the thinking one — the two take visibly different amounts of time
// and it is worth knowing which one you are waiting on.
const SEARCHY = /search|look ?up|looking up|find|browse|fetch|query|web|retriev/i

/**
 * The answer as running text, for a card that is read rather than clicked.
 *
 * The tile used to show a title in a small pill, which told you an answer had
 * arrived and nothing about what it said — so every answer cost a trip to the
 * side panel. Markdown is flattened rather than rendered: at tile size the
 * structure (tables, lists, code) cannot survive anyway, and what people want
 * from across the room is the sentence.
 */
function toPlainText(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')            // fenced code
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // headings
    .replace(/^\s{0,3}>\s?/gm, '')               // quotes
    .replace(/^\s*[-*+]\s+/gm, '· ')             // bullets keep a marker
    .replace(/^\s*\d+\.\s+/gm, m => m.trim() + ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')            // table rows
    .replace(/!\[[^\]]*\]\([^)\s]*\)/g, ' ')     // images
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')   // links → their text
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// Long enough to notice after glancing back at the screen, short enough not to
// still be pulsing at the next contribution.
const ARRIVED_MS = 5200
// Contributions backfilled when you join are not arrivals — they already
// happened. Anything within this window of mount is treated as history.
const BACKFILL_GRACE_MS = 2500

function assistantPhase(working, flash) {
  if (working) return SEARCHY.test(`${working.title || ''} ${working.progress || ''}`) ? 'searching' : 'thinking'
  return flash ? 'arrived' : 'idle'
}

const PHASE_LABEL = {
  thinking: 'thinking…',
  searching: 'searching…',
  arrived: 'just contributed',
  idle: 'listening',
}

export function AssistantTile({ contributions, variant = 'grid', onOpen, onCollapse }) {
  const working = useMemo(
    () => contributions.find(c => c.status === 'working') ?? null,
    [contributions],
  )
  // "Skipped" cards are the agent explaining why it is NOT contributing. They
  // belong on the board, but they are not contributions: they must not bump the
  // badge count, and they must not flash the tile as if something arrived.
  const done = useMemo(
    () => contributions.filter(c => c.status !== 'working' && c.status !== 'skipped'),
    [contributions],
  )
  const latest = done.length ? done[done.length - 1] : null
  const latestKey = latest ? conKey(latest) : null

  const [flash, setFlash] = useState(false)
  const mountedAt = useRef(Date.now())

  useEffect(() => {
    if (!latestKey) return undefined
    if (Date.now() - mountedAt.current < BACKFILL_GRACE_MS) return undefined
    setFlash(true)
    const t = setTimeout(() => setFlash(false), ARRIVED_MS)
    return () => clearTimeout(t)
  }, [latestKey])

  const phase = assistantPhase(working, flash)
  const headline = working?.title || latest?.title || null
  // The rail is 90px of chrome down the side of a shared screen; it gets the
  // mark and nothing else. Everywhere else, the tile carries the answer.
  const body = variant === 'rail' ? '' : toPlainText(latest?.markdown)
  const showAnswer = !working && !!body
  // While it works, the phase line carries the live step ("Fetching bom.gov.au")
  // rather than a generic "searching…" — from across the grid that is the
  // difference between a tile that looks stuck and one that is visibly moving.
  const phaseText = working?.progress || PHASE_LABEL[phase]

  if (variant === 'stage') {
    return (
      <div data-flip="assistant" className="tile tile-assistant tile-stage" data-phase={phase}>
        <AssistantStage contributions={contributions} working={working} onCollapse={onCollapse} />
      </div>
    )
  }

  return (
    <div
      data-flip="assistant"
      className={'tile tile-assistant tile-' + variant + (showAnswer ? ' has-answer' : '')}
      data-phase={phase}
      role="button"
      tabIndex={0}
      aria-label="Assistant — open its contributions on the stage"
      title={showAnswer ? 'Click for the full answer and its sources' : 'Assistant — click to see every contribution, full size'}
      onClick={() => onOpen?.('assistant')}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        onOpen?.('assistant')
      }}
    >
      <div className="tile-media">
        <span className="atile-halo" aria-hidden="true"></span>
        <span className="atile-mark" aria-hidden="true">
          <Icon name="sparkles" size={variant === 'rail' ? 18 : 26} />
        </span>
        {phase === 'searching' && <span className="atile-scan" aria-hidden="true"></span>}
        {/* Reading the answer here is the point: the side panel is for the
            sources and the history, not for finding out what was said. Type
            size is set in container units, so the same block is legible in a
            240px grid tile and grows with the tile when it takes the stage. */}
        {showAnswer ? (
          <div className="atile-answer">
            {latest.title && <div className="atile-answer-title">{latest.title}</div>}
            <p className="atile-answer-body">{body}</p>
            {latest.to && latest.to !== 'all' && (
              <div className="atile-answer-to">→ {latest.to}</div>
            )}
          </div>
        ) : (
          headline && <span className="atile-headline" title={headline}>{headline}</span>
        )}
        <span className="tile-ring" aria-hidden="true"></span>
      </div>

      <div className="tile-badges">
        {done.length > 0 && (
          <span className="tile-badge tile-badge-accent" title={`${done.length} contributions`}>
            {done.length}
          </span>
        )}
      </div>

      <div className="tile-name">
        <span className="atile-pulse" aria-hidden="true"><i></i><i></i><i></i></span>
        <span className="tile-name-text">Assistant</span>
        <span className="atile-phase" title={phaseText}>{phaseText}</span>
      </div>
    </div>
  )
}
