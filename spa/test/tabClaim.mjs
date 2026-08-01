// One-tab-per-kelabo protocol tests. Plain node, no DOM, no BroadcastChannel —
// the reducer is pure by design so this file can exist. Every case here is a
// race, which is exactly what cannot be checked by opening two browser tabs.
import assert from 'node:assert/strict'
import { applyClaim, emptyClaim, holdsRoom, PROBE_MS } from '../src/room/tabClaim.js'

let passed = 0
const ok = msg => { passed += 1; console.log('ok:', msg) }

const sent = r => r.effects.filter(e => e.send).map(e => e.send)
const timers = r => r.effects.filter(e => typeof e.timer === 'number').map(e => e.timer)

/** Drive one tab through a list of events, collecting what it broadcast. */
function drive(tabId, events) {
  let state = emptyClaim(tabId)
  const out = []
  for (const ev of events) {
    const r = applyClaim(state, ev)
    state = r.state
    out.push(...sent(r))
  }
  return { state, out }
}

// The only tab: claims, hears nothing, opens the room.
{
  const first = applyClaim(emptyClaim('a'), { type: 'start' })
  assert.equal(first.state.phase, 'checking')
  assert.deepEqual(sent(first), [{ kind: 'claim', tabId: 'a' }])
  assert.deepEqual(timers(first), [PROBE_MS])
  const settled = applyClaim(first.state, { type: 'timeout' })
  assert.equal(settled.state.phase, 'holding')
  assert.equal(holdsRoom(settled.state), true)
  ok('a lone tab opens the room after the probe window')
}

// A second tab is answered and blocks itself. The room never mounts in it.
{
  const { state: held } = drive('a', [{ type: 'start' }, { type: 'timeout' }])
  const answer = applyClaim(held, { type: 'message', msg: { kind: 'claim', tabId: 'b' } })
  assert.equal(answer.state.phase, 'holding', 'the holder keeps the room')
  assert.deepEqual(sent(answer), [{ kind: 'held', tabId: 'a' }])

  const { state: second } = drive('b', [
    { type: 'start' },
    { type: 'message', msg: { kind: 'held', tabId: 'a' } },
  ])
  assert.equal(second.phase, 'blocked')
  assert.equal(holdsRoom(second), false)
  ok('a second tab is refused before it opens anything')
}

// Dead heat: both tabs claim before either can answer. Exactly one wins, and
// both agree on which — without another round trip.
{
  const aStart = applyClaim(emptyClaim('aaa'), { type: 'start' })
  const bStart = applyClaim(emptyClaim('zzz'), { type: 'start' })
  const a = applyClaim(aStart.state, { type: 'message', msg: { kind: 'claim', tabId: 'zzz' } })
  const b = applyClaim(bStart.state, { type: 'message', msg: { kind: 'claim', tabId: 'aaa' } })
  const aFinal = applyClaim(a.state, { type: 'timeout' }).state
  const bFinal = applyClaim(b.state, { type: 'timeout' }).state
  assert.equal(holdsRoom(aFinal), true)
  assert.equal(holdsRoom(bFinal), false)
  assert.equal([aFinal, bFinal].filter(holdsRoom).length, 1, 'never two holders')
  ok('simultaneous opens resolve to exactly one holder')
}

// Takeover: the blocked tab asks, the holder yields and becomes the blocked one.
{
  const { state: blocked } = drive('b', [
    { type: 'start' },
    { type: 'message', msg: { kind: 'held', tabId: 'a' } },
  ])
  const taking = applyClaim(blocked, { type: 'takeover' })
  assert.equal(taking.state.phase, 'taking')
  assert.deepEqual(sent(taking), [{ kind: 'take', tabId: 'b' }])

  const { state: held } = drive('a', [{ type: 'start' }, { type: 'timeout' }])
  const yielded = applyClaim(held, { type: 'message', msg: { kind: 'take', tabId: 'b' } })
  assert.equal(yielded.state.phase, 'blocked', 'the old tab stands down, and can take it back')
  assert.deepEqual(sent(yielded), [{ kind: 'yield', tabId: 'a' }])

  const done = applyClaim(taking.state, { type: 'message', msg: { kind: 'yield', tabId: 'a' } })
  assert.equal(holdsRoom(done.state), true)
  ok('takeover moves the room from one tab to the other')
}

// A holder that crashed cannot yield. The takeover must still complete, on the
// same timeout that decides a free kelabo in the first place.
{
  const { state: blocked } = drive('b', [
    { type: 'start' },
    { type: 'message', msg: { kind: 'held', tabId: 'a' } },
  ])
  const taking = applyClaim(blocked, { type: 'takeover' }).state
  const done = applyClaim(taking, { type: 'timeout' })
  assert.equal(holdsRoom(done.state), true)
  ok('takeover from a crashed holder completes on timeout')
}

// Closing the holder frees the room for a tab that is already waiting: the
// blocked tab reclaims itself rather than asking for a reload.
{
  const { state: held } = drive('a', [{ type: 'start' }, { type: 'timeout' }])
  const stopped = applyClaim(held, { type: 'stop' })
  assert.equal(stopped.state.phase, 'stopped')
  assert.deepEqual(sent(stopped), [{ kind: 'release', tabId: 'a' }])

  const { state: blocked } = drive('b', [
    { type: 'start' },
    { type: 'message', msg: { kind: 'held', tabId: 'a' } },
  ])
  const reclaim = applyClaim(blocked, { type: 'message', msg: { kind: 'release', tabId: 'a' } })
  assert.equal(reclaim.state.phase, 'checking')
  assert.deepEqual(sent(reclaim), [{ kind: 'claim', tabId: 'b' }])
  assert.equal(holdsRoom(applyClaim(reclaim.state, { type: 'timeout' }).state), true)
  ok('closing the holder reopens the room in the waiting tab')
}

// A tab must never block itself on its own echo.
{
  const start = applyClaim(emptyClaim('a'), { type: 'start' })
  const echo = applyClaim(start.state, { type: 'message', msg: { kind: 'held', tabId: 'a' } })
  assert.equal(echo.state.phase, 'checking')
  assert.equal(holdsRoom(applyClaim(echo.state, { type: 'timeout' }).state), true)
  ok('a tab ignores its own messages')
}

// A blocked tab holds nothing, so closing it must not release the kelabo out
// from under the tab that does.
{
  const { state: blocked } = drive('b', [
    { type: 'start' },
    { type: 'message', msg: { kind: 'held', tabId: 'a' } },
  ])
  const stopped = applyClaim(blocked, { type: 'stop' })
  assert.deepEqual(sent(stopped), [], 'no release from a tab that never held it')
  ok('closing a blocked tab releases nothing')
}

console.log(`\n${passed} tab-claim assertions passed`)
