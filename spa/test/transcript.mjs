// Transcript pipeline tests (docs 13). Plain node, no DOM, no network — the
// Compose and Project stages are pure by design precisely so this file can
// exist. Until now the SPA's only gate was `npm run build`, which is why every
// transcript boundary bug had to be found in a live kelabo.
import assert from 'node:assert/strict'
import { createComposer } from '../src/transcript/composer.js'
import {
  apply,
  emptyTranscript,
  messageParts,
  messageText,
  messages,
  renameSpeaker,
} from '../src/transcript/transcriptStore.js'
import { readResult } from '../src/transcript/deepgram.js'
import { fromWire, DELTA, SEALED, TAIL } from '../src/transcript/events.js'

let passed = 0
const ok = msg => {
  passed += 1
  console.log('ok:', msg)
}

// A composer wired to a controllable clock and a recording sink.
function harness({ speakerId = 'alice@example.com', ...opts } = {}) {
  const events = []
  let t = 1000
  const composer = createComposer({
    speakerId,
    emit: e => events.push(e),
    now: () => t,
    ...opts,
  })
  return {
    composer,
    events,
    advance: ms => {
      t += ms
    },
    at: () => t,
  }
}

// Project a list of events exactly the way a client does.
function project(events, meta = {}) {
  return events.reduce((state, e) => apply(state, e, meta), emptyTranscript())
}

// --- Read: the Deepgram wire format -----------------------------------------
// A Results frame as Deepgram documents it.
const dg = (start, duration, transcript, extra = {}) => ({
  type: 'Results',
  start,
  duration,
  is_final: false,
  channel: { alternatives: [{ transcript }] },
  ...extra,
})

{
  // The worked example from Deepgram's own docs: interims restate the segment in
  // progress, `is_final` settles it, and the next segment starts where that one
  // ended. A whole utterance is the concatenation of its finals.
  const frames = [
    dg(0.0, 1.1, 'yeah so'),
    dg(0.0, 2.2, 'yeah so my credit card number'),
    dg(0.0, 3.2, 'yeah so my credit card number is two two'),
    dg(0.0, 3.26, 'yeah so my credit card number is two two', { is_final: true, speech_final: false }),
    dg(3.26, 1.84, 'two two three three three three'),
    dg(3.26, 2.24, 'two two three three three three', { is_final: true, speech_final: true }),
  ]
  let cursor = 0
  const finals = []
  for (const f of frames) {
    const r = readResult(f, { cursor })
    if (r.cursor != null) cursor = r.cursor
    if (r.kind === 'final') finals.push(r.text)
  }
  assert.deepEqual(finals, [
    'yeah so my credit card number is two two',
    'two two three three three three',
  ])
  assert.equal(cursor, 5.5)
  ok('Deepgram’s documented interim/final sequence reads as two settled segments')
}

{
  // THE BUG THIS REPLACED. A final is authoritative the moment it arrives, so it
  // is read as settled without any pause signal. Waiting for `speech_final`,
  // `UtteranceEnd` or a `Finalize` answer — none of which are reliable once the
  // VAD gate has removed the silence they measure — left confirmed words sitting
  // as an unconfirmed tail for the whole utterance.
  const r = readResult(dg(0, 2, 'no pause signal anywhere', { is_final: true }), { cursor: 0 })
  assert.equal(r.kind, 'final')
  assert.equal(r.segments.length, 1)
  assert.equal(r.segments[0].text, 'no pause signal anywhere')
  ok('a final needs no speech_final, UtteranceEnd or Finalize to be settled')
}

{
  // Re-emission of an already finalized span (CJK models do this routinely).
  let cursor = 0
  const first = readResult(dg(0, 3.26, '今天天气很好', { is_final: true }), { cursor })
  cursor = first.cursor
  const again = readResult(dg(0, 3.26, '今天天气很好', { is_final: true }), { cursor })
  assert.equal(again.kind, 'covered')
  assert.equal(again.cursor, undefined, 'a covered span must never move the cursor back')
  ok('a final for a span already finalized is dropped, not committed twice')
}

{
  // Empty results are Deepgram idling on audio with no speech. They are not
  // activity (they must not hold the seal clock open) but an empty *final* still
  // settles its audio, so the cursor moves.
  const interim = readResult(dg(0, 1, ''), { cursor: 0 })
  assert.deepEqual(interim, { kind: 'idle', hasText: false })
  const final = readResult(dg(0, 1, '', { is_final: true }), { cursor: 0 })
  assert.equal(final.kind, 'idle')
  assert.equal(final.hasText, false)
  assert.equal(final.cursor, 1)
  ok('empty results are not activity, but an empty final still advances the span')
}

{
  // Non-Results frames (UtteranceEnd, SpeechStarted, Metadata) carry no
  // transcript. They are read, and they do nothing — deliberately.
  const r = readResult({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 3.1 }, { cursor: 2 })
  assert.deepEqual(r, { kind: 'other', hasText: false })
  ok('UtteranceEnd carries no transcript and changes nothing')
}

{
  // Diarized: a result is split into runs by speaker, so the composer sees a
  // speaker change and seals on it.
  const words = [
    { word: 'hello', start: 0.1, end: 0.5, speaker: 0 },
    { word: 'there', start: 0.5, end: 0.9, speaker: 0 },
    { word: 'hi', start: 1.0, end: 1.4, speaker: 1 },
  ]
  const r = readResult(
    { type: 'Results', start: 0, duration: 1.4, is_final: true, channel: { alternatives: [{ transcript: 'hello there hi', words }] } },
    { cursor: 0, diarize: true },
  )
  assert.deepEqual(r.segments.map(s => [s.sp, s.text]), [[0, 'hello there'], [1, 'hi']])
  ok('a diarized final splits into one segment per speaker')
}

{
  // A final that partially overlaps what is already committed contributes only
  // its new words — otherwise the overlap is transcribed twice.
  const words = [
    { word: 'already', start: 0.1, end: 0.5, speaker: 0 },
    { word: 'said', start: 0.5, end: 0.9, speaker: 0 },
    { word: 'new', start: 1.2, end: 1.6, speaker: 0 },
  ]
  const r = readResult(
    { type: 'Results', start: 0, duration: 1.6, is_final: true, channel: { alternatives: [{ transcript: 'already said new', words }] } },
    { cursor: 1.0, diarize: true },
  )
  assert.deepEqual(r.segments.map(s => s.text), ['new'])
  ok('a partially covered final contributes only the words it adds')
}

{
  // CJK: nova word lists mix phrase- and token-level entries, so re-joining them
  // duplicates text. Undiarized, the response transcript is authoritative.
  const words = [
    { word: '今天', start: 0, end: 0.5 },
    { word: '今天天气', start: 0, end: 1.0 },
  ]
  const r = readResult(
    { type: 'Results', start: 0, duration: 1.0, is_final: true, channel: { alternatives: [{ transcript: '今天天气', words }] } },
    { cursor: 0, diarize: false, joiner: '' },
  )
  assert.deepEqual(r.segments.map(s => s.text), ['今天天气'])
  ok('an undiarized final trusts the transcript, not a re-join of its word list')
}

{
  // End to end through the composer: three finals with no pause signal at all
  // become one message with all three committed — nothing left as a tail.
  const { composer, events, advance } = harness()
  let cursor = 0
  for (const f of [
    dg(0, 1.5, 'first part', { is_final: true }),
    dg(1.5, 1.5, 'second part', { is_final: true }),
    dg(3.0, 1.5, 'third part', { is_final: true }),
  ]) {
    const r = readResult(f, { cursor })
    cursor = r.cursor
    for (const seg of r.segments) {
      composer.addFragment({ text: seg.text, speakerLabel: 'Moon', tStart: seg.start, tEnd: seg.end })
    }
  }
  assert.equal(events.filter(e => e.type === DELTA).length, 3, 'each final committed on arrival')
  advance(1100)
  assert.equal(composer.sealIfIdle(), true)
  const sealed = events.find(e => e.type === SEALED)
  assert.equal(sealed.text, 'first part second part third part')
  assert.equal(sealed.reason, 'silence', 'sealed by silence, not stranded until stt_stalled')
  ok('finals commit as they arrive and seal on silence — never stranded as a tail')
}

// --- Compose: where messages begin and end ---------------------------------
{
  const { composer, events } = harness()
  composer.addFragment({ text: 'Alright.', speakerLabel: 'Moon', tStart: 0, tEnd: 500 })
  composer.addFragment({ text: "Let's get started.", speakerLabel: 'Moon', tStart: 500, tEnd: 1200 })
  composer.seal('silence')

  assert.equal(events.filter(e => e.type === DELTA).length, 2)
  const sealed = events.filter(e => e.type === SEALED)
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0].text, "Alright. Let's get started.")
  // Both fragments and the seal share one id — that id IS the message boundary,
  // and it is what every client groups by.
  assert.equal(new Set(events.map(e => e.messageId)).size, 1)
  ok('fragments and their seal share one message id')
}

{
  const { composer, events } = harness()
  composer.addFragment({ text: 'one', speakerLabel: 'Moon' })
  composer.seal('silence')
  composer.addFragment({ text: 'two', speakerLabel: 'Moon' })
  composer.seal('silence')
  const ids = new Set(events.map(e => e.messageId))
  assert.equal(ids.size, 2, 'a seal starts a genuinely new message')
  assert.equal(messages(project(events)).length, 2)
  ok('speech after a seal opens a new message, never reopens the old one')
}

// --- Compose: seal triggers -------------------------------------------------
{
  // The VAD gate has no vote in sealing. Deepgram's Finalize answer (sent when
  // the gate shuts) is just another message: it resets the clock like any
  // other, and the seal lands a second later if nothing follows.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'hello', speakerLabel: 'Moon' })
  advance(500)
  composer.noteActivity(true) // the Finalize answer comes back
  advance(500)
  assert.equal(composer.sealIfIdle(), false, 'still inside the second')
  advance(600)
  assert.equal(composer.sealIfIdle(), true)
  assert.equal(events.find(e => e.type === SEALED).reason, 'silence')
  ok('a gate close does not seal — 1s of Deepgram silence does')
}

{
  const { composer, events, advance } = harness({ maxOpenMs: 5000 })
  composer.addFragment({ text: 'still going', speakerLabel: 'Moon' })
  advance(6000)
  composer.addFragment({ text: 'and going', speakerLabel: 'Moon' })
  const sealed = events.filter(e => e.type === SEALED)
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0].reason, 'max_open_ms')
  // The cap seals on a fragment boundary, so no fragment is ever cut in half.
  assert.equal(sealed[0].text, 'still going and going')
  ok('the time cap seals on the next fragment boundary, not mid-fragment')
}

{
  const { composer, events } = harness({ maxWords: 5 })
  composer.addFragment({ text: 'one two three', speakerLabel: 'Moon' })
  composer.addFragment({ text: 'four five six', speakerLabel: 'Moon' })
  assert.equal(events.find(e => e.type === SEALED)?.reason, 'max_words')
  ok('the word cap bounds what can ever reach the LLM in one message')
}

{
  // CJK is not space-separated, so whitespace tokens alone would never reach the
  // cap and a Chinese speaker's message would be unbounded.
  const { composer, events } = harness({ maxWords: 5 })
  composer.addFragment({ text: '今天天气', speakerLabel: 'Moon' })
  composer.addFragment({ text: '很好啊', speakerLabel: 'Moon' })
  assert.equal(events.find(e => e.type === SEALED)?.reason, 'max_words')
  ok('the word cap counts CJK characters, which have no spaces to split on')
}

{
  const { composer, events } = harness()
  composer.addFragment({ text: 'from A', speakerLabel: 'A', key: 'A' })
  composer.addFragment({ text: 'from B', speakerLabel: 'B', key: 'B' })
  const sealed = events.filter(e => e.type === SEALED)
  assert.equal(sealed.length, 1)
  assert.equal(sealed[0].text, 'from A')
  assert.equal(sealed[0].reason, 'speaker_change')
  ok('a diarized speaker change seals the previous speaker’s message')
}

// --- Compose: THE seal rule -------------------------------------------------
{
  // The reported bug: continuous talking split into small messages. Any Deepgram
  // message — interim or final — has to reset the clock, so a speaker producing
  // a steady stream is never cut.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'I am still talking', speakerLabel: 'Moon' })
  for (let i = 0; i < 60; i++) {
    advance(800) // interims arriving faster than the 1s timeout
    composer.noteActivity(true)
    composer.sealIfIdle()
  }
  assert.equal(events.filter(e => e.type === SEALED).length, 0, '48s of speech stayed one message')
  ok('any Deepgram message resets the clock, so continuous speech is never cut')
}

{
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'done now', speakerLabel: 'Moon' })
  advance(999)
  assert.equal(composer.sealIfIdle(), false, 'not yet — still inside the second')
  advance(2)
  assert.equal(composer.sealIfIdle(), true)
  assert.equal(events.find(e => e.type === SEALED).reason, 'silence')
  ok('1s with nothing from Deepgram seals the message')
}

{
  // Interims count. `finalOnly` mode used to discard them before they could
  // reset the clock, so only finals restarted it — and finals are routinely more
  // than a second apart, which sealed continuously mid-speech.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'keep going', speakerLabel: 'Moon' })
  advance(900)
  composer.noteActivity(true) // an interim carrying text
  advance(900)
  assert.equal(composer.sealIfIdle(), false, 'the interim reset the clock')
  advance(200)
  assert.equal(composer.sealIfIdle(), true)
  assert.equal(events.filter(e => e.type === SEALED).length, 1)
  ok('an interim result resets the clock exactly like a final')
}

{
  // The rule is uniform: with silence skipping off there is no gate at all and
  // nothing about this changes.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'vad is off', speakerLabel: 'Moon' })
  advance(1100)
  assert.equal(composer.sealIfIdle(), true)
  assert.equal(events.filter(e => e.type === SEALED).length, 1)
  ok('the rule is identical whether or not the VAD gate is running')
}

{
  const { composer } = harness()
  assert.equal(composer.sealIfIdle(), false, 'nothing open, nothing to seal')
  ok('the idle poll is a no-op when no message is open')
}

// --- The live tail: one box, not two ----------------------------------------
{
  // The reported bug: two unclosed boxes for one utterance. The guess used to be
  // rendered outside the transcript as its own bubble alongside the open
  // message. It now lives *inside* the message, so there is only ever one box.
  const { composer, events } = harness()
  composer.setTail({ text: 'I think we should', speakerLabel: 'Moon' })
  composer.setTail({ text: 'I think we should ship', speakerLabel: 'Moon' })
  const state = project(events)
  assert.equal(messages(state).length, 1, 'one message, not one per revision')
  const m = messages(state)[0]
  assert.equal(m.text, '', 'nothing is confirmed yet')
  assert.equal(m.tail, 'I think we should ship', 'the newest guess replaced the older one')
  ok('a revised guess replaces the tail in place — one box, never two')
}

{
  // Confirmation moves words from the tail into the committed text.
  const { composer, events } = harness()
  composer.setTail({ text: 'hello ther', speakerLabel: 'Moon' })
  composer.addFragment({ text: 'hello there', speakerLabel: 'Moon' })
  const m = messages(project(events))[0]
  assert.equal(m.text, 'hello there')
  assert.equal(m.tail, '', 'the guess is gone once the words are confirmed')
  ok('a finalized fragment clears the tail and commits the words')
}

{
  // Speech shows up before anything is confirmed — the box appears at once, on
  // the speaker's screen and on every listener's.
  const { composer, events } = harness()
  composer.setTail({ text: 'starting to talk', speakerLabel: 'Moon' })
  assert.equal(events.filter(e => e.type === TAIL).length, 1, 'the guess is fanned out immediately')
  assert.equal(messages(project(events))[0].state, 'open')
  ok('a message appears as soon as there is any text, confirmed or not')
}

{
  // Deepgram or the network failed mid-utterance: the last segment stays a guess
  // and nothing more arrives. Close it rather than leave it hanging.
  const { composer, events, advance } = harness({ staleTimeoutMs: 5000 })
  composer.addFragment({ text: 'we should', speakerLabel: 'Moon' })
  composer.setTail({ text: 'we should probably', speakerLabel: 'Moon' })
  advance(1500)
  assert.equal(composer.sealIfIdle(), false, 'an outstanding guess gets longer than 1s')
  advance(4000)
  assert.equal(composer.sealIfIdle(), true)
  const sealed = events.find(e => e.type === SEALED)
  assert.equal(sealed.reason, 'stt_stalled')
  assert.equal(sealed.text, 'we should probably', 'closed on what was actually heard')
  ok('an unconfirmed last segment waits longer, then closes on what was heard')
}

{
  // Stopping mid-guess keeps the words. They were heard; discarding them to
  // avoid recording something unconfirmed would lose real speech.
  const { composer, events } = harness()
  composer.setTail({ text: 'one last thing', speakerLabel: 'Moon' })
  composer.seal('stop')
  const sealed = events.find(e => e.type === SEALED)
  assert.equal(sealed.text, 'one last thing')
  assert.equal(messages(project(events))[0].state, 'sealed')
  ok('sealing with only a guess keeps the words rather than dropping them')
}

{
  // Deepgram interims often restate the whole utterance instead of only the new
  // tail — CJK models do it routinely — so a naive append shows every word twice.
  const { composer, events } = harness()
  composer.addFragment({ text: 'we should', speakerLabel: 'Moon' })
  composer.setTail({ text: 'we should probably ship', speakerLabel: 'Moon' })
  composer.seal('stop')
  assert.equal(events.find(e => e.type === SEALED).text, 'we should probably ship')
  ok('a guess that restates confirmed words replaces them instead of duplicating')
}

{
  // Empty results are Deepgram idling on audio with no speech in it. Counting
  // them as activity kept the clock alive forever and the message never closed.
  const { composer, events, advance } = harness()
  composer.addFragment({ text: 'all done', speakerLabel: 'Moon' })
  for (let i = 0; i < 10; i++) {
    advance(300)
    composer.noteActivity(false) // empty interim results streaming in
    composer.sealIfIdle()
  }
  assert.equal(events.filter(e => e.type === SEALED).length, 1, 'empty results did not hold it open')
  ok('empty Deepgram results are not activity — they never block a seal')
}

// --- Render split: only the outstanding guess is live ------------------------
{
  // The reported bug: the whole box was styled as provisional whenever any tail
  // was outstanding, so a minute of settled transcript flickered as if it were
  // about to change. Only the trailing guess may still change.
  const split = m => messageParts(m)

  // Appended tail: the settled words keep their own styling.
  assert.deepEqual(
    split({ text: 'we should', tail: 'probably ship' }),
    { settled: 'we should', live: ' probably ship' },
  )

  // Restated tail (CJK models do this constantly): the boundary is NOT
  // text.length, so it is found by walking the guess.
  assert.deepEqual(
    split({ text: 'we should', tail: 'we should probably ship' }),
    { settled: 'we should ', live: 'probably ship' },
  )
  assert.deepEqual(
    split({ text: '今天天气', tail: '今天天气很好啊' }),
    { settled: '今天天气', live: '很好啊' },
  )

  // Punctuation and case differ between the guess and the confirmed text, and
  // the split still lands on the same words.
  assert.deepEqual(
    split({ text: 'Alright,', tail: 'alright — so' }),
    { settled: 'alright — ', live: 'so' },
  )

  assert.deepEqual(split({ text: 'all done', tail: '' }), { settled: 'all done', live: '' })
  assert.deepEqual(split({ text: '', tail: 'starting' }), { settled: '', live: 'starting' })
  assert.deepEqual(split(null), { settled: '', live: '' })
  ok('a message splits into settled words plus at most one live tail')
}

{
  // The split is a presentation of `messageText`, not a second opinion about it.
  // If they could disagree, the box would gain or lose words the instant the
  // tail cleared.
  for (const m of [
    { text: 'we should', tail: 'probably ship' },
    { text: 'we should', tail: 'we should probably ship' },
    { text: '今天天气', tail: '今天天气很好啊' },
    { text: 'hello ther', tail: 'hello there' },
    { text: '', tail: 'starting to talk' },
    { text: 'sealed already', tail: '' },
  ]) {
    const { settled, live } = messageParts(m)
    assert.equal(settled + live, messageText(m))
  }
  ok('settled + live is exactly what messageText renders — never more, never less')
}

{
  // End to end: a long confirmed message with a short outstanding guess is
  // mostly settled text, whatever the tail happens to restate.
  const { composer, events } = harness()
  composer.addFragment({ text: 'This is a fairly long thing I have already said.', speakerLabel: 'Moon' })
  composer.setTail({ text: 'and now I am', speakerLabel: 'Moon' })
  const { settled, live } = messageParts(messages(project(events))[0])
  assert.equal(settled, 'This is a fairly long thing I have already said.')
  assert.equal(live, ' and now I am')
  ok('a long settled message renders live only where Deepgram has got to')
}

// --- THE property this redesign exists to guarantee -------------------------
{
  // The speaker composes; the listener receives the same events over the wire.
  // Both project with the same reducer, so both must land on an identical
  // transcript. Every reported symptom — doubled bubbles, endlessly growing
  // boxes, host and participant disagreeing — was a violation of exactly this.
  const { composer, events } = harness({ speakerId: 'guest:moon' })
  composer.addFragment({ text: 'Alright.', speakerLabel: 'Moon', tStart: 0, tEnd: 400 })
  composer.addFragment({ text: "Let's get started.", speakerLabel: 'Moon', tStart: 400, tEnd: 900 })
  composer.seal('silence')
  composer.addFragment({ text: 'Look.', speakerLabel: 'Moon', tStart: 2000, tEnd: 2400 })
  composer.seal('silence')

  // Speaker's own view.
  const local = project(events, { mine: true, at: 5 })

  // Listener's view: identical events, but round-tripped through the gateway's
  // SSE shape and back via fromWire.
  const wire = events.map(e => ({
    speaker: e.speakerLabel,
    by: e.speakerId,
    text: e.text,
    tStart: e.tStart,
    tEnd: e.tEnd,
    messageId: e.messageId,
    seq: e.seq,
    kind: e.type,
    partial: e.type !== SEALED,
  }))
  const remote = wire.reduce((s, u) => apply(s, fromWire(u), { mine: false, at: 5 }), emptyTranscript())

  const shape = state =>
    messages(state).map(m => ({ id: m.messageId, speaker: m.speakerLabel, text: m.text, state: m.state }))

  assert.deepEqual(shape(remote), shape(local))
  assert.equal(shape(local).length, 2, 'two messages, split where the speaker sealed')
  assert.equal(shape(local)[0].text, "Alright. Let's get started.")
  assert.equal(shape(local)[1].text, 'Look.')
  ok('SPEAKER AND LISTENER PROJECT AN IDENTICAL TRANSCRIPT (the core invariant)')
}

// --- Project: delivery hazards ---------------------------------------------
{
  // A delta lost in flight must not corrupt the message permanently: the sealed
  // text is the whole message and replaces whatever the deltas assembled.
  const { composer, events } = harness()
  composer.addFragment({ text: 'first', speakerLabel: 'Moon' })
  composer.addFragment({ text: 'second', speakerLabel: 'Moon' })
  composer.seal('silence')

  const lossy = events.filter((e, i) => i !== 1) // drop the second delta
  const state = lossy.reduce((s, e) => apply(s, e), emptyTranscript())
  assert.equal(messages(state)[0].text, 'first second', 'the seal healed the gap')
  ok('a dropped delta self-heals when the sealed message arrives')
}

{
  const { composer, events } = harness()
  composer.addFragment({ text: 'echo', speakerLabel: 'Moon' })
  composer.seal('silence')
  const doubled = [...events, ...events] // every event redelivered
  const state = doubled.reduce((s, e) => apply(s, e), emptyTranscript())
  assert.equal(messages(state).length, 1)
  assert.equal(messages(state)[0].text, 'echo', 'redelivery did not duplicate the words')
  ok('duplicate delivery converges (a redelivered delta is ignored)')
}

{
  // The seal races the last delta: the seal is posted while the delta is still
  // in flight, so the delta can land afterwards. It must not reopen the message
  // or append to authoritative text.
  const { composer, events } = harness()
  composer.addFragment({ text: 'done', speakerLabel: 'Moon' })
  composer.seal('silence')
  const reordered = [events[1], events[0]] // seal first, then its delta
  const state = reordered.reduce((s, e) => apply(s, e), emptyTranscript())
  assert.equal(messages(state).length, 1)
  assert.equal(messages(state)[0].state, 'sealed')
  assert.equal(messages(state)[0].text, 'done', 'the late delta was ignored')
  ok('a delta arriving after its seal never reopens or corrupts the message')
}

{
  // Overlapping speakers: messages interleave by when the speech started, not by
  // when the packets happened to arrive.
  let state = emptyTranscript()
  state = apply(state, {
    type: SEALED, messageId: 'b', speakerId: 'B', speakerLabel: 'Bob',
    text: 'second', tStart: 5000, tEnd: 6000,
  })
  state = apply(state, {
    type: SEALED, messageId: 'a', speakerId: 'A', speakerLabel: 'Ann',
    text: 'first', tStart: 1000, tEnd: 2000,
  })
  assert.deepEqual(messages(state).map(m => m.text), ['first', 'second'])
  ok('out-of-order arrival is ordered by when the speech started')
}

{
  let state = emptyTranscript()
  state = apply(state, {
    type: SEALED, messageId: 'x', speakerId: 'A', speakerLabel: 'A',
    text: 'hi', tStart: 0, tEnd: 1,
  })
  state = renameSpeaker(state, 'A', 'Ann')
  assert.equal(messages(state)[0].speakerLabel, 'Ann')
  assert.equal(messages(state)[0].text, 'hi', 'rename touches the label, never the text')
  ok('speaker rename relabels without altering message text or boundaries')
}

{
  assert.equal(fromWire({ text: 'x' }), null, 'an event with no messageId is not projectable')
  assert.equal(fromWire(null), null)
  ok('malformed wire events are rejected rather than grouped by guesswork')
}

// A typed message (notes #4) is a message. It goes through the same reducer, is
// grouped by the same messageId and lands in the same ordered list as speech —
// `source` is a label the view may draw and nothing downstream branches on.
{
  let state = emptyTranscript()
  state = apply(state, {
    type: SEALED, messageId: 't1', speakerId: 'A', speakerLabel: 'Ann',
    text: '@kelabo what is the retry policy?', tStart: 1000, tEnd: 1000, source: 'typed',
  })
  state = apply(state, {
    type: SEALED, messageId: 's1', speakerId: 'B', speakerLabel: 'Bob',
    text: 'good question', tStart: 2000, tEnd: 3000,
  })
  const list = messages(state)
  assert.deepEqual(list.map(m => m.messageId), ['t1', 's1'], 'ordered with speech, by tStart')
  assert.equal(list[0].source, 'typed')
  assert.equal(list[1].source, undefined, 'speech carries no source')
  assert.equal(list[0].state, 'sealed', 'typed text arrives whole and is sealed on arrival')
  ok('a typed message is projected exactly like speech, carrying only a source label')
}

{
  // The gateway stamps `source` on the sealed utterance it fans out, so a
  // listener marks the line as typed too — not just the person who typed it.
  const e = fromWire({ messageId: 'w1', speaker: 'Ann', text: 'hi', kind: 'sealed', source: 'typed' })
  assert.equal(e.type, SEALED)
  assert.equal(e.source, 'typed')
  ok('a typed message survives the wire as a sealed event with its source intact')
}

console.log(`\n${passed} transcript tests passed`)
