import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { Modal } from './ui/Modal'
import { Icon } from './ui/Icon'
import { Avatar } from './ui/Avatar'
import { Tabs } from './ui/Tabs'
import { timeAgo } from '../timeAgo'
import { kelaboKindIcon } from '../kelaboKind'
import { usePresenceContext } from '../presence/PresenceContext'

const SEARCH_DEBOUNCE_MS = 250

const TABS = [
  { id: 'contacts', label: 'Contacts' },
  { id: 'kelabos', label: 'Kelabos' },
]

/**
 * Global search, from the magnifier in the rail. One box, two tabs: people
 * (favourites and the org directory) and past kelabos (titles from the
 * record list, plus full text of the minutes — the server reads those out of
 * the archives, most recent first, so "where did we decide that?" is
 * answerable without remembering which kelabo it was).
 *
 * Rows act: a contact opens the call dialog via `onCall`; a kelabo opens its
 * record. With nothing typed, each tab shows what you would most likely reach
 * for — favourites, and the latest records.
 */
export function SearchDialog({ onClose, onCall }) {
  const navigate = useNavigate()
  const presence = usePresenceContext()
  const [tab, setTab] = useState('contacts')
  const [query, setQuery] = useState('')

  const [favourites, setFavourites] = useState([])
  const [people, setPeople] = useState(null) // null = nothing typed yet
  const [records, setRecords] = useState(null) // recent records, for the empty state
  const [hits, setHits] = useState(null) // server search results
  const [minutesCapped, setMinutesCapped] = useState(false)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    api.listContacts().then(d => setFavourites(d.favourites || [])).catch(() => {})
    api.listRecords().then(d => setRecords(d.records || [])).catch(() => setRecords([]))
  }, [])

  // One debounce drives both tabs — the query means the same thing in each,
  // and switching tabs after typing should show results, not restart them.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setPeople(null); setHits(null); setMinutesCapped(false); setSearching(false); return undefined }
    setSearching(true)
    const t = setTimeout(() => {
      Promise.allSettled([api.searchPeople(q), api.searchRecords(q)])
        .then(([p, r]) => {
          setPeople(p.status === 'fulfilled' ? p.value?.suggestions || [] : [])
          setHits(r.status === 'fulfilled' ? r.value?.results || [] : [])
          setMinutesCapped(r.status === 'fulfilled' ? !!r.value?.minutesCapped : false)
        })
        .finally(() => setSearching(false))
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const contactRows = useMemo(() => {
    if (people) return people.map(p => ({ email: p.email, name: p.displayName || p.email, avatarVariant: p.avatarVariant }))
    return favourites.map(f => ({ email: f.email, name: f.displayName || f.email, avatarVariant: f.avatarVariant }))
  }, [people, favourites])

  const kelaboRows = useMemo(() => {
    if (hits) return hits
    return (records || []).slice(0, 8).map(r => ({ ...r, matched: null }))
  }, [hits, records])

  const openRecord = id => { onClose(); navigate(`/kelabos/${id}`) }
  const openContact = email => { onClose(); navigate(`/contacts?q=${encodeURIComponent(email)}`) }

  return (
    <Modal
      open
      onDismiss={onClose}
      label="Search"
      className="modal-search"
      badge={<span className="modal-icon modal-icon-neutral"><Icon name="search" /></span>}
      title="Search"
      actions={null}
    >
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      <div className="call-picker">
        <div className="picker-search">
          <Icon name="search" size={14} />
          <input
            className="input"
            value={query}
            autoFocus
            placeholder={tab === 'contacts' ? 'Name or email…' : 'Title, or anything from the minutes…'}
            aria-label="Search"
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {tab === 'contacts' && (
          <>
            <div className="menu-label">{people ? 'Search results' : 'Favourites'}</div>
            <div className="picker-list">
              {searching && contactRows.length === 0 && <div className="menu-empty">Searching…</div>}
              {!searching && contactRows.length === 0 && (
                <div className="menu-empty">
                  {people ? 'Nobody matches that.' : 'No favourites yet — type to search your organisation.'}
                </div>
              )}
              {contactRows.map(c => {
                const online = presence.presence.has(c.email)
                return (
                  <div className="picker-row search-contact" key={c.email}>
                    <button type="button" className="search-contact-main" onClick={() => openContact(c.email)}>
                      <Avatar id={c.email} name={c.name} variant={c.avatarVariant} className="avatar-sm" />
                      <span className="picker-row-text">{c.name}</span>
                      <span className={'sdot ' + (online ? 'sdot-live' : 'sdot-ended')} title={online ? 'Online' : 'Offline'}></span>
                    </button>
                    {online && (
                      <button
                        type="button"
                        className="call-btn"
                        title={`Kelabo ${c.name}`}
                        aria-label={`Kelabo ${c.name}`}
                        onClick={() => onCall(c.email)}
                      >
                        <Icon name="phone" size={15} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {tab === 'kelabos' && (
          <>
            <div className="menu-label">{hits ? 'Search results' : 'Recent kelabos'}</div>
            <div className="picker-list">
              {searching && kelaboRows.length === 0 && <div className="menu-empty">Searching…</div>}
              {!searching && records === null && kelaboRows.length === 0 && <div className="menu-empty">Loading…</div>}
              {!searching && records !== null && kelaboRows.length === 0 && (
                <div className="menu-empty">
                  {!hits && <span className="empty-mark" aria-hidden="true"></span>}
                  {hits ? 'Nothing in your titles or minutes matches that.' : 'No past kelabos yet.'}
                </div>
              )}
              {kelaboRows.map(r => (
                <button type="button" className="picker-row" key={r.archiveId} onClick={() => openRecord(r.archiveId)}>
                  <Icon name={kelaboKindIcon(r)} size={14} className="kind-icon" />
                  <span className="search-hit">
                    <span className="search-hit-title">{r.title}</span>
                    {r.snippet && <span className="search-hit-snippet">{r.snippet}</span>}
                  </span>
                  {r.matched === 'minutes' && <span className="chip">minutes</span>}
                  <span className="row-meta">{r.endedAt ? timeAgo(r.endedAt) : ''}</span>
                </button>
              ))}
              {minutesCapped && (
                <div className="menu-note">Minutes of older kelabos were not searched — titles still were.</div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
