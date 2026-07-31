import { useEffect, useMemo, useRef, useState } from 'react'
import { ContributionCard } from '../components/ContributionCard'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { SpeakerTag } from '../components/SpeakerTag'
import { usePrompt } from '../components/PromptDialog'
import { useToast } from '../components/Toaster'
import { renameSpeaker as apiRenameSpeaker } from '../api'
import { messageParts } from '../transcript/transcriptStore'
import { conKey } from './useBoard'

/**
 * The room's side panel: the whole conversation, or the whole board, on request.
 *
 * Nothing in here is needed to follow a kelabo — captions cover that — so it
 * opens narrow, over the stage, and closes again. It exists for the two things
 * captions cannot do: read back something said five minutes ago, and work
 * through the assistant's output without leaving the room.
 */

// How close to the bottom still counts as "following along". Scrolling back to
// re-read must not be yanked away by the next thing anyone says.
const FOLLOW_THRESHOLD_PX = 140

function fmtTime(at) {
  if (!at) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function MessageBody({ message }) {
  const { settled, live } = messageParts(message)
  return (
    <>
      {settled}
      {live && <span className="chat-tail">{live}</span>}
    </>
  )
}

function useFollowingScroll(dep, enabled) {
  const ref = useRef(null)
  const [pinned, setPinned] = useState(false)

  const atBottom = () => {
    const el = ref.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX
  }

  useEffect(() => {
    if (!enabled) return
    if (atBottom()) {
      const el = ref.current
      if (el) el.scrollTop = el.scrollHeight
      setPinned(false)
    } else {
      setPinned(true)
    }
  }, [dep, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const jump = () => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    setPinned(false)
  }

  return { ref, pinned, jump, onScroll: () => { if (pinned && atBottom()) setPinned(false) } }
}

function TranscriptTab({ capture, diarize, kelaboId, boardOnly, ended }) {
  const { state, messages, renameSpeaker, sendTyped } = capture
  const scroll = useFollowingScroll(messages, true)
  const prompt = usePrompt()
  const toast = useToast()
  const inputRef = useRef(null)

  const speakers = useMemo(() => {
    const seen = []
    for (const m of messages) {
      if (m.speakerLabel && !seen.includes(m.speakerLabel)) seen.push(m.speakerLabel)
    }
    return seen
  }, [messages])

  const doRename = async label => {
    const to = await prompt({
      title: `Rename speaker "${label}"`,
      placeholder: 'New name',
      initialValue: /^[A-Z]$/.test(label) ? '' : label,
      confirmLabel: 'Rename',
    })
    if (to == null) return
    const name = to.trim()
    if (!name || name === label) return
    // Optimistic local update; server SSE will confirm/echo to all clients.
    renameSpeaker?.(label, name)
    try {
      await apiRenameSpeaker({ kelaboId, from: label, to: name })
    } catch {
      toast('Could not rename speaker on the server — applied locally only')
    }
  }

  const submit = e => {
    e.preventDefault()
    const text = inputRef.current?.value ?? ''
    if (!text.trim()) return
    inputRef.current.value = ''
    sendTyped?.(text)
    // Typing lands at the bottom by definition — never leave the reader parked
    // above the thing they just wrote.
    scroll.jump()
  }

  return (
    <>
      {diarize && speakers.length > 0 && (
        <div className="side-speakers">
          <span className="text-meta">Speakers</span>
          {speakers.map(s => (
            <button key={s} className="chip chip-btn" title={`Rename speaker ${s}`} onClick={() => doRename(s)}>
              {s}<Icon name="pencil" size={11} />
            </button>
          ))}
        </div>
      )}

      <div className="side-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {messages.length === 0 && (
          <div className="empty">
            {boardOnly
              ? 'Watch-only — you joined without a microphone. Everyone else’s words still appear here.'
              : 'Speak — everyone’s words appear here as they are transcribed.'}
          </div>
        )}
        {messages.map(m => (
          <div key={m.messageId} className={'chat-msg' + (m.mine ? ' mine' : '')}>
            <div className="chat-meta">
              <SpeakerTag name={m.speakerLabel} />
              {m.source === 'typed' && (
                <Icon name="pencil" size={11} className="chat-typed" label="Typed" />
              )}
              <span className="chat-time">{fmtTime(m.at)}</span>
            </div>
            <div className={'chat-bubble' + (m.state === 'open' ? ' open' : '')}>
              <MessageBody message={m} />
            </div>
          </div>
        ))}
      </div>

      {scroll.pinned && (
        <button className="jump-latest" onClick={scroll.jump}>
          <Icon name="chevron-down" size={13} /> Jump to latest
        </button>
      )}

      {/* Typing into the transcript is saying something, not annotating it: the
          message is persisted, fans out to everyone and reaches the assistant
          exactly like speech. Which is why it belongs here rather than on the
          board, and why "@kelabo" is worth naming in the placeholder — an
          explicit mention is the one way to make the assistant answer without
          waiting for it to decide the room wanted an answer. */}
      {!ended && (
        <form className="compose" onSubmit={submit}>
          <input
            className="input"
            ref={inputRef}
            placeholder="Type a message, or @kelabo to ask…"
            aria-label="Type a message to the kelabo"
          />
          <Button type="submit" size="sm" iconOnly title="Send" aria-label="Send">
            <Icon name="send" size={15} />
          </Button>
        </form>
      )}

      <div className="side-foot">
        {boardOnly
          ? 'watch-only · you can still type into the transcript'
          : state === 'live'
            ? 'your device · Deepgram direct stream · only finals are posted'
            : `capture: ${state}`}
      </div>
    </>
  )
}

function BoardTab({ contributions, onPostNote, focusSignal, ended }) {
  const scroll = useFollowingScroll(contributions, true)
  const inputRef = useRef(null)

  // A tap on a board notification should land on the newest contribution.
  useEffect(() => {
    if (focusSignal) scroll.jump()
  }, [focusSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = e => {
    e.preventDefault()
    const text = inputRef.current?.value.trim()
    if (!text) return
    inputRef.current.value = ''
    onPostNote(text)
  }

  return (
    <>
      <div className="side-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
        {contributions.length === 0 && (
          <div className="empty">Contributions from the assistant appear here as the kelabo goes.</div>
        )}
        {contributions.map(c => <ContributionCard key={conKey(c)} con={c} />)}
      </div>

      {scroll.pinned && (
        <button className="jump-latest" onClick={scroll.jump}>
          <Icon name="chevron-down" size={13} /> Jump to latest
        </button>
      )}

      {!ended && (
        <form className="compose" onSubmit={submit}>
          <input
            className="input"
            ref={inputRef}
            placeholder="Add a note to the board…"
            aria-label="Add a note to the board"
          />
          <Button type="submit" size="sm">Post</Button>
        </form>
      )}
    </>
  )
}

export function SidePanel({
  tab,
  onTab,
  onClose,
  capture,
  diarize,
  boardOnly,
  kelaboId,
  translation,
  contributions,
  boardStatus,
  onPostNote,
  focusSignal,
  ended,
  onHold,
}) {
  return (
    <aside
      className="side"
      aria-label={tab === 'board' ? 'Board' : 'Transcript'}
      onMouseEnter={() => onHold?.(true)}
      onMouseLeave={() => onHold?.(false)}
    >
      <div className="side-head">
        <div className="side-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'transcript'}
            className={tab === 'transcript' ? 'is-on' : ''}
            onClick={() => onTab('transcript')}
          >
            Transcript
          </button>
          <button
            role="tab"
            aria-selected={tab === 'board'}
            className={tab === 'board' ? 'is-on' : ''}
            onClick={() => onTab('board')}
          >
            Board
            {contributions.length > 0 && <span className="chip chip-accent">{contributions.length}</span>}
          </button>
        </div>
        <Button variant="ghost" size="sm" iconOnly title="Close panel" aria-label="Close panel" onClick={onClose}>
          <Icon name="x" />
        </Button>
      </div>

      {tab === 'transcript' && translation?.enabled && (
        <div className="side-note">
          <span className="chip chip-accent" title="The host enabled translation">
            translated → {translation.targetLang || 'auto'}
          </span>
        </div>
      )}
      {tab === 'board' && boardStatus === 'reconnecting' && !ended && (
        <div className="side-note"><span className="chip">reconnecting…</span></div>
      )}

      {tab === 'transcript' ? (
        <TranscriptTab capture={capture} diarize={diarize} kelaboId={kelaboId} boardOnly={boardOnly} ended={ended} />
      ) : (
        <BoardTab
          contributions={contributions}
          onPostNote={onPostNote}
          focusSignal={focusSignal}
          ended={ended}
        />
      )}
    </aside>
  )
}
