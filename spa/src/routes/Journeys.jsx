import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth'
import { SkeletonRows } from '../components/ui/Skeleton'
import { Banner } from '../components/ui/Banner'
import { Icon } from '../components/ui/Icon'
import { Button } from '../components/ui/Button'
import { Avatar } from '../components/ui/Avatar'
import { Modal } from '../components/ui/Modal'
import { useToast } from '../components/Toaster'
import { timeAgo } from '../timeAgo'

/** health -> the chip class already used for kelabo/RSVP status (docs 20 §5) —
 *  no new colour vocabulary, the same fixed success/warn/danger tokens. */
const HEALTH_CHIP = { green: 'chip-live', yellow: 'chip-warn', red: 'chip-danger' }
const HEALTH_LABEL = { green: 'On track', yellow: 'At risk', red: 'Off track' }

export function JourneyHealthChip({ health }) {
  if (!health) return null
  return <span className={'chip ' + (HEALTH_CHIP[health] || '')}>{HEALTH_LABEL[health] || health}</span>
}

function JourneyRow({ j, delay }) {
  return (
    <Link className={'row anim-in' + (delay ? ` anim-in-d${Math.min(delay, 4)}` : '')} to={`/journeys/${j.journeyId}`}>
      <Avatar id={j.journeyId} variant={j.avatarVariant} size={32} />
      <div className="row-main">
        <div className="row-title">
          {j.title}
          {j.status === 'completed' && <span className="chip chip-ended">completed</span>}
          {j.visibility === 'public' && <span className="chip">public</span>}
          <JourneyHealthChip health={j.health} />
        </div>
        <div className="row-sub">
          {j.kelaboCount} kelabo{j.kelaboCount === 1 ? '' : 's'}
          {typeof j.progress === 'number' ? ` · ${j.progress}%` : ''}
          {j.reportCount ? ` · ${j.reportCount} report${j.reportCount === 1 ? '' : 's'}` : ''}
        </div>
      </div>
      <span className="row-meta">{timeAgo(j.updatedAt || j.createdAt)}</span>
      <span className="row-chevron"><Icon name="chevron-right" /></span>
    </Link>
  )
}

function NewJourneyModal({ onClose, onCreated }) {
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState('private')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const titleRef = useRef(null)

  const submit = async e => {
    e?.preventDefault()
    if (saving || !title.trim()) return
    setSaving(true)
    try {
      const created = await api.createJourney({
        title: title.trim(),
        visibility,
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      onCreated(created.journeyId)
    } catch {
      setSaving(false)
      toast('Could not create the journey — try again')
    }
  }

  return (
    <Modal
      open
      onDismiss={onClose}
      label="New journey"
      as="form"
      onSubmit={submit}
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="book-open" /></span>}
      title="New journey"
      actions={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !title.trim()}>
            {saving ? 'Creating…' : 'Create journey'}
          </Button>
        </>
      }
    >
      <div className="field form-stack">
        <label className="label" htmlFor="j-title">Title</label>
        <input
          id="j-title"
          ref={titleRef}
          className="input"
          autoFocus
          maxLength={80}
          placeholder="Q3 launch"
          value={title}
          onChange={e => setTitle(e.target.value)}
        />
      </div>
      <div className="field form-stack">
        <label className="label" htmlFor="j-desc">Description (optional)</label>
        <textarea
          id="j-desc"
          className="input"
          rows={3}
          maxLength={20000}
          placeholder="What this project is, so the second kelabo starts with context"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
      </div>
      <div className="settings-row settings-row-plain">
        <div className="sr-main">
          <div className="sr-title">Visibility</div>
          <div className="sr-sub">
            {visibility === 'public'
              ? 'Everyone at your tenant can view, edit and link kelabos into it.'
              : 'Only you and accessors you add can see it.'}
          </div>
        </div>
        <div className="hstack">
          <Button
            type="button"
            size="sm"
            variant={visibility === 'private' ? 'primary' : 'outline'}
            onClick={() => setVisibility('private')}
          >
            Private
          </Button>
          <Button
            type="button"
            size="sm"
            variant={visibility === 'public' ? 'primary' : 'outline'}
            onClick={() => setVisibility('public')}
          >
            Public
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export default function Journeys() {
  const { identity } = useAuth()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [showNew, setShowNew] = useState(false)

  useEffect(() => {
    if (!identity) return
    api.listJourneys()
      .then(d => { setData(d); setError(false) })
      .catch(() => setError(true))
  }, [identity])

  const mine = data?.mine || []
  const accessible = data?.accessible || []
  const publicJourneys = data?.public || []
  const empty = data && mine.length === 0 && accessible.length === 0 && publicJourneys.length === 0

  return (
    <main className="page">
      <div className="title-row">
        <h1 className="page-title">Journeys</h1>
        <Button variant="primary" onClick={() => setShowNew(true)}>
          <Icon name="plus" size={14} />New journey
        </Button>
      </div>
      <p className="page-sub">
        A journey links related kelabos so decisions, documents and history carry from one meeting to the next.
      </p>

      {data === null && !error && <SkeletonRows n={3} />}
      {error && <Banner kind="warn">Couldn't load your journeys — check your connection and reload.</Banner>}
      {empty && (
        <div className="empty empty-hero">
          <span className="empty-mark" aria-hidden="true"></span>
          No journeys yet — create one, then link the kelabos that belong to it.
        </div>
      )}

      {mine.length > 0 && (
        <>
          <div className="section-title">Mine</div>
          {mine.map((j, i) => <JourneyRow key={j.journeyId} j={j} delay={i} />)}
        </>
      )}
      {accessible.length > 0 && (
        <>
          <div className="section-title">Shared with me</div>
          {accessible.map((j, i) => <JourneyRow key={j.journeyId} j={j} delay={i + mine.length} />)}
        </>
      )}
      {publicJourneys.length > 0 && (
        <>
          <div className="section-title">Public in your tenant</div>
          {publicJourneys.map((j, i) => <JourneyRow key={j.journeyId} j={j} delay={i + mine.length + accessible.length} />)}
        </>
      )}

      {showNew && (
        <NewJourneyModal
          onClose={() => setShowNew(false)}
          onCreated={id => navigate(`/journeys/${id}`)}
        />
      )}
    </main>
  )
}
