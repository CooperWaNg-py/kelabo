import assert from 'node:assert/strict'
import { createCallLog } from '../src/rtc/callLog.js'

/**
 * The call log is the only evidence left after a broken call has been
 * reloaded away. These tests pin the behaviours that make it trustworthy:
 * the flag gates capture, lines are timestamped and append-only, the store
 * survives a reload (a fresh instance picks up what the last one wrote), the
 * cap drops the oldest lines rather than stopping, and clear really clears.
 */

let passed = 0
const tests = []
const test = (name, fn) => tests.push([name, fn])

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    map,
  }
}

let clockMs = 1_700_000_000_000
const now = () => new Date(clockMs)
const ts = () => new Date(clockMs).toISOString()

// --- gating ----------------------------------------------------------------

test('nothing is captured while the flag is off', () => {
  let on = false
  const log = createCallLog({ enabled: () => on, storage: fakeStorage(), now })
  log.info('sfu', 'should not land')
  log.error('mesh', 'nor should this')
  assert.equal(log.text(), '')
  assert.equal(log.count(), 0)
})

test('flipping the flag mid-call takes effect on the next event', () => {
  let on = false
  const log = createCallLog({ enabled: () => on, storage: fakeStorage(), now })
  log.info('call', 'before')
  on = true
  log.info('call', 'after')
  assert.equal(log.text(), `${ts()} INFO  [call] after`)
})

// --- line format -----------------------------------------------------------

test('lines are timestamped, levelled and scoped', () => {
  const log = createCallLog({ enabled: () => true, storage: null, now })
  log.debug('sfu', 'ice gathering: gathering')
  log.warn('mesh', 'glare')
  assert.deepEqual(log.text().split('\n'), [
    `${ts()} DEBUG [sfu] ice gathering: gathering`,
    `${ts()} WARN  [mesh] glare`,
  ])
})

test('the data tail serializes as JSON; Errors keep message and code', () => {
  const log = createCallLog({ enabled: () => true, storage: null, now })
  const err = new Error('boom')
  err.code = 'not_found_track_error'
  log.error('sfu', 'pull failed', err)
  log.info('sfu', 'pull accepted', { mid: '3' })
  const [l1, l2] = log.text().split('\n')
  assert.ok(l1.endsWith('[sfu] pull failed {"message":"boom","code":"not_found_track_error"}'))
  assert.ok(l2.endsWith('[sfu] pull accepted {"mid":"3"}'))
})

test('circular data never throws', () => {
  const log = createCallLog({ enabled: () => true, storage: null, now })
  const a = {}
  a.self = a
  log.info('x', 'circle', a)
  assert.ok(log.text().includes('[circular]'))
})

// --- persistence -----------------------------------------------------------

test('flush writes the log through to storage', () => {
  const storage = fakeStorage()
  const log = createCallLog({ enabled: () => true, storage, now, persistDebounceMs: 10_000 })
  log.info('call', 'joined')
  assert.equal(storage.getItem('kelabo-call-log'), null) // debounced
  log.flush()
  assert.equal(storage.getItem('kelabo-call-log'), `${ts()} INFO  [call] joined`)
})

test('a fresh instance picks up what a previous page left behind', () => {
  const storage = fakeStorage()
  const first = createCallLog({ enabled: () => true, storage, now })
  first.warn('call', 'connection: failed')
  first.flush()
  // The reload: a brand-new instance over the same storage, flag now off —
  // the old record must still be readable even though nothing new is captured.
  const second = createCallLog({ enabled: () => false, storage, now })
  assert.equal(second.text(), `${ts()} WARN  [call] connection: failed`)
  second.info('call', 'not captured')
  assert.equal(second.count(), 1)
})

test('the cap drops the oldest lines, never the newest', () => {
  const log = createCallLog({ enabled: () => true, storage: null, now, maxChars: 120 })
  for (let i = 0; i < 20; i++) log.info('s', `line-${String(i).padStart(2, '0')}`)
  const lines = log.text().split('\n')
  assert.ok(lines.length < 20)
  assert.ok(lines.at(-1).endsWith('line-19'))
  assert.ok(!log.text().includes('line-00'))
})

test('clear empties the log and the store', () => {
  const storage = fakeStorage()
  const log = createCallLog({ enabled: () => true, storage, now })
  log.info('call', 'something')
  log.flush()
  assert.ok(storage.getItem('kelabo-call-log'))
  log.clear()
  assert.equal(log.text(), '')
  assert.equal(storage.getItem('kelabo-call-log'), null)
})

// --- runner ----------------------------------------------------------------

for (const [name, fn] of tests) {
  try {
    await fn()
    passed++
    console.log(`ok ${passed} - ${name}`)
  } catch (err) {
    console.error(`not ok - ${name}`)
    console.error(err)
    process.exit(1)
  }
}
console.log(`\n${passed}/${tests.length} callLog tests passed`)
