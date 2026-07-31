import { useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../components/Markdown'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { conKey } from './useBoard'

/**
 * The assistant, full size.
 *
 * This is what the assistant card opens into: the equivalent of a participant
 * sharing their screen, except the screen is everything the agent has
 * contributed. The card in the grid can only ever show a headline; a
 * contribution is a document — sources, code, a rationale — and reading one
 * should not mean squinting at a 240px tile or hunting for it in a side list.
 *
 * Left: the contributions, newest last, the way they arrived in the kelabo.
 * Right: the selected one, rendered in full. Selection follows the newest
 * arrival only while the reader is already on the newest — the same rule as a
 * transcript that stops auto-scrolling once you scroll back.
 */

const KIND_LABEL = {
  answer: 'Answers',
  link: 'Links',
  code: 'Code',
  clarify: 'Clarifications',
  minutes: 'Minutes',
  note: 'Notes',
}

// Date as well as time when the card is not from today: an agent can post to
// the board before the kelabo starts (docs 16 §5), and "14:30" with no date
// reads as thirty seconds ago.
function fmtAt(at, now = Date.now()) {
  if (!at) return ''
  try {
    const d = new Date(at)
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const today = new Date(now)
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
  } catch {
    return ''
  }
}

export function AssistantStage({ contributions, working, onCollapse }) {
  const [kind, setKind] = useState('all')
  const [selectedKey, setSelectedKey] = useState(null)
  const listRef = useRef(null)
  // Follow the newest arrival unless the reader has deliberately selected an
  // older one — then leave them where they are.
  const followRef = useRef(true)

  // Same rule as the tile: a "skipped" card explains an absence and has no
  // document to read, so it does not belong in the reading list.
  const done = useMemo(
    () => contributions.filter(c => c.status !== 'working' && c.status !== 'skipped'),
    [contributions],
  )

  const kinds = useMemo(() => {
    const seen = []
    for (const c of done) {
      const k = c.kind || 'note'
      if (!seen.includes(k)) seen.push(k)
    }
    return seen
  }, [done])

  const shown = useMemo(
    () => (kind === 'all' ? done : done.filter(c => (c.kind || 'note') === kind)),
    [done, kind],
  )

  const newestKey = shown.length ? conKey(shown[shown.length - 1]) : null

  useEffect(() => {
    if (followRef.current) setSelectedKey(newestKey)
  }, [newestKey])

  // A filter change can hide whatever was selected; fall back to the newest one
  // that survived it rather than showing an empty detail pane.
  useEffect(() => {
    if (selectedKey && shown.some(c => conKey(c) === selectedKey)) return
    setSelectedKey(newestKey)
  }, [shown, selectedKey, newestKey])

  useEffect(() => {
    if (!followRef.current) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [shown.length])

  const selected = shown.find(c => conKey(c) === selectedKey) ?? null

  const select = c => {
    const key = conKey(c)
    followRef.current = key === newestKey
    setSelectedKey(key)
  }

  return (
    <div className="astage">
      <div className="astage-head">
        <span className="astage-mark" aria-hidden="true"><Icon name="sparkles" size={16} /></span>
        <span className="astage-title">Assistant</span>
        <span className="chip chip-accent">{done.length}</span>
        {working && (
          <span className="chip chip-live" title={working.title || ''}>
            <span className="dot"></span>{working.progress || working.title || 'working…'}
          </span>
        )}
        <span className="spacer"></span>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          title="Back to the room"
          aria-label="Back to the room"
          onClick={e => { e.stopPropagation(); onCollapse?.() }}
        >
          <Icon name="minimize" />
        </Button>
      </div>

      {kinds.length > 1 && (
        <div className="astage-filters">
          <button
            className={'chip chip-btn' + (kind === 'all' ? ' is-on' : '')}
            onClick={e => { e.stopPropagation(); setKind('all') }}
          >
            All
          </button>
          {kinds.map(k => (
            <button
              key={k}
              className={'chip chip-btn kind-' + k + (kind === k ? ' is-on' : '')}
              onClick={e => { e.stopPropagation(); setKind(k) }}
            >
              {KIND_LABEL[k] || k}
            </button>
          ))}
        </div>
      )}

      <div className="astage-body">
        <div className="astage-list" ref={listRef}>
          {shown.length === 0 && (
            <div className="astage-empty">
              Nothing yet. The assistant contributes as the conversation gives it
              something to answer, look up or clarify.
            </div>
          )}
          {shown.map(c => {
            const key = conKey(c)
            return (
              <button
                key={key}
                className={'astage-item' + (key === selectedKey ? ' is-on' : '')}
                data-kind={c.kind || 'note'}
                onClick={e => { e.stopPropagation(); select(c) }}
              >
                <span className="astage-item-title">{c.title || 'Untitled'}</span>
                <span className="astage-item-meta">
                  <span className={'chip kind-' + (c.kind || 'note')}>{c.kind || 'note'}</span>
                  <span className="text-meta">{fmtAt(c.at)}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="astage-detail">
          {selected ? (
            <article className="astage-doc" key={selectedKey}>
              <header className="astage-doc-head">
                <h2>{selected.title || 'Untitled'}</h2>
                <div className="astage-doc-meta">
                  <span className={'chip kind-' + (selected.kind || 'note')}>{selected.kind || 'note'}</span>
                  <span className="chip">to: {selected.to || 'all'}</span>
                  {(selected.origin === 'local' || selected.origin === 'opencode') && (
                    <span
                      className="chip chip-dev"
                      title={`Produced from a local repo by ${selected.agentLabel || selected.runtime || 'opencode'}`}
                    >
                      {selected.runtime || 'local repo'}
                    </span>
                  )}
                  <span className="text-meta">{selected.author || 'assistant'} · {fmtAt(selected.at)}</span>
                </div>
              </header>
              {selected.markdown && <Markdown text={selected.markdown} />}
              {Array.isArray(selected.sources) && selected.sources.length > 0 && (
                <div className="astage-src">
                  {selected.sources.map((s, i) =>
                    s.url ? (
                      <a
                        key={i}
                        className="chip kind-link"
                        href={s.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={e => e.stopPropagation()}
                      >
                        {s.title}
                      </a>
                    ) : (
                      <span key={i} className="chip kind-link">{s.title}</span>
                    ),
                  )}
                </div>
              )}
            </article>
          ) : (
            <div className="astage-empty astage-empty-lg">
              <Icon name="sparkles" size={22} />
              <p>The assistant is listening. Whatever it contributes lands here, full size.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
