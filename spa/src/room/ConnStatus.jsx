import { Icon } from '../components/ui/Icon'

/**
 * The three connections a kelabo actually runs on, side by side.
 *
 * A kelabo depends on three independent services and, until this existed, a
 * participant could only ever infer which one had gone: audio you cannot hear
 * and a transcript that stopped look identical from the room, and "is it me or
 * is it Kelabo?" is not a question anyone should have to answer by opening
 * devtools. Each one reports itself here, named, so a failure is attributable.
 *
 * Deliberately read-only and deliberately small: nothing here is a control. The
 * conditions that need a decision (denied mic, a full mesh room) still raise
 * their own banner — this is the always-on background reading, not an alert.
 */

/**
 * Every state each connection can be in, mapped to the four things a reader
 * needs to tell apart: working, working-on-it, broken, and not-in-use. Mapping
 * is a table rather than a chain of conditionals because the *interesting* part
 * is which states are missing from it — an unlisted state falls to `warn`, so a
 * new one shows up as "something is happening" rather than silently reading as
 * healthy.
 */
const KELABO = {
  live: ['ok', 'Connected — contributions, transcript echo and signalling are flowing.'],
  connecting: ['warn', 'Connecting to the Kelabo server…'],
  reconnecting: ['bad', 'Lost the Kelabo server — reconnecting. The board and the call cannot update until it is back.'],
  ended: ['off', 'The kelabo has ended; the stream is closed.'],
}

const DEEPGRAM = {
  live: ['ok', 'Streaming to Deepgram from your device — Kelabo never handles your audio.'],
  muted: ['ok', 'Connected, but muted — nothing is streamed or billed while you are muted.'],
  connecting: ['warn', 'Opening the Deepgram stream…'],
  reconnecting: ['bad', 'Deepgram dropped — reconnecting. Words spoken now may not be transcribed.'],
  mic_denied: ['bad', 'Your browser blocked the microphone, so there is nothing to transcribe.'],
  stt_unavailable: ['bad', 'Transcription is unavailable right now. The call and the board are unaffected.'],
  insecure_context: ['bad', 'The microphone needs https or localhost — no audio is being captured.'],
  idle: ['off', 'Not transcribing.'],
  ended: ['off', 'Transcription has stopped.'],
}

const CALL = {
  live: ['ok', 'Conference audio is connected.'],
  joining: ['warn', 'Joining the call…'],
  idle: ['off', 'Not on the call.'],
  full: ['bad', 'This peer-to-peer kelabo is full, so you are not on the call.'],
  unavailable: ['off', 'Conference audio is not configured on this deployment.'],
  error: ['bad', 'Could not join the call. Captions and the board are unaffected.'],
}

function look(table, state) {
  return table[state] || ['warn', `Unknown state: ${state}`]
}

/**
 * One light. Icon and colour only — the name and the explanation live in the
 * tooltip. Three labelled pills were wide enough to wrap the control bar onto a
 * second row, and a status readout that pushes the mute button around is worse
 * than no readout at all. Colour carries the state (green working, amber
 * connecting, red broken, grey not in use) and the icon carries which service;
 * hovering gives you the sentence.
 */
function Light({ icon, label, tone, title }) {
  return (
    <span className={'conn conn-' + tone} title={`${label} — ${title}`}>
      <Icon name={icon} size={16} />
      <span className="sr-only">{`${label}: ${title}`}</span>
    </span>
  )
}

export function ConnStatus({ boardStatus, captureState, callState, callMode, transcribing }) {
  const [kTone, kTitle] = look(KELABO, boardStatus)
  const [dTone, dTitle] = look(DEEPGRAM, captureState)
  const [cTone, cTitle] = look(CALL, callState)

  return (
    <div className="cbar-group conn-group" role="status" aria-label="Connection status">
      <Light icon="cloud" label="Kelabo" tone={kTone} title={kTitle} />
      {/* Watch-only participants have no capture pipeline at all, so reporting
          it as "off" would invite them to go looking for a fault they cannot
          fix. It is simply not part of their kelabo. */}
      {transcribing && <Light icon="waveform" label="Deepgram" tone={dTone} title={dTitle} />}
      <Light
        icon="broadcast"
        label={callMode === 'mesh' ? 'P2P' : 'SFU'}
        tone={cTone}
        title={cTitle}
      />
    </div>
  )
}
