// Presence reducer tests (docs 18 §5). Plain node, no DOM, no network — the
// reducer is pure by design so this file can exist. What a tab shows for a
// contact, and how a reconnect re-syncs, lives here rather than in a hook.
import assert from 'node:assert/strict'
import { apply, emptyPresence, isOnline, isInKelabo } from '../src/presence/presenceStore.js'

let passed = 0
const ok = msg => { passed += 1; console.log('ok:', msg) }

// snapshot replaces the whole set — the recovery mechanism.
{
  let s = emptyPresence()
  s = apply(s, { kind: 'online', identity: 'a@x.com', inKelabo: false })
  s = apply(s, { kind: 'snapshot', online: [{ identity: 'b@x.com', inKelabo: true }] })
  assert.equal(isOnline(s, 'a@x.com'), false, 'snapshot drops anyone not in it')
  assert.equal(isOnline(s, 'b@x.com'), true)
  assert.equal(isInKelabo(s, 'b@x.com'), true)
  ok('snapshot replaces the whole set (reconnect re-syncs)')
}

// online / offline upsert and remove one person.
{
  let s = emptyPresence()
  s = apply(s, { kind: 'online', identity: 'a@x.com', inKelabo: false })
  assert.equal(isOnline(s, 'a@x.com'), true)
  s = apply(s, { kind: 'offline', identity: 'a@x.com' })
  assert.equal(isOnline(s, 'a@x.com'), false)
  ok('online then offline toggles one contact')
}

// busy updates inKelabo without changing online.
{
  let s = emptyPresence()
  s = apply(s, { kind: 'online', identity: 'a@x.com', inKelabo: false })
  assert.equal(isInKelabo(s, 'a@x.com'), false)
  s = apply(s, { kind: 'busy', identity: 'a@x.com', inKelabo: true })
  assert.equal(isOnline(s, 'a@x.com'), true)
  assert.equal(isInKelabo(s, 'a@x.com'), true)
  ok('busy flips inKelabo while staying online')
}

// Immutability: apply returns a new reference on change, the same on no-op.
{
  const s = emptyPresence()
  const same = apply(s, { kind: 'offline', identity: 'nobody@x.com' })
  assert.equal(same, s, 'a no-op offline returns the same reference')
  const s2 = apply(s, { kind: 'online', identity: 'a@x.com' })
  assert.notEqual(s2, s, 'a real change returns a new reference')
  assert.equal(s.size, 0, 'the original is untouched')
  ok('reducer is immutable and reference-stable on no-ops')
}

// Malformed / unknown events pass through unchanged.
{
  const s = apply(emptyPresence(), { kind: 'online', identity: 'a@x.com' })
  assert.equal(apply(s, null), s)
  assert.equal(apply(s, { kind: 'weird' }), s)
  assert.equal(apply(s, { kind: 'online' }), s, 'online without an identity is ignored')
  ok('malformed and unknown events are ignored')
}

console.log(`\n${passed} presence tests passed`)
