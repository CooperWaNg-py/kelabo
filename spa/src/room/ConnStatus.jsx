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

// The transcription light names whichever provider this deployment mints
// sessions for, because the point it is making is *where your audio goes* —
// "Kelabo never handles it" is only reassuring if you can see who does. The
// name is supplied by the capture hook (`provider.label`), so this component
// knows no provider; `who` is the fallback for the states that occur before a
// session has been minted and there is nothing to name yet.
const sttStates = who => ({
  live: ['ok', `Streaming to ${who} from your device — Kelabo never handles your audio.`],
  muted: ['ok', 'Connected, but muted — nothing is streamed while you are muted.'],
  connecting: ['warn', `Opening the ${who} stream…`],
  reconnecting: ['bad', `${who} dropped — reconnecting. Words spoken now may not be transcribed.`],
  mic_denied: ['bad', 'Your browser blocked the microphone, so there is nothing to transcribe.'],
  stt_unavailable: ['bad', 'Transcription is unavailable right now. The call and the board are unaffected.'],
  insecure_context: ['bad', 'The microphone needs https or localhost — no audio is being captured.'],
  idle: ['off', 'Not transcribing.'],
  ended: ['off', 'Transcription has stopped.'],
})

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
/**
 * `live` means media is leaving this machine for that service RIGHT NOW, as
 * opposed to the connection merely being healthy. It is worth its own signal
 * because the two come apart constantly and only one of them is what a person
 * actually wants to know: a green transcription light means "the socket is
 * fine", which says nothing about whether the room is listening to you.
 *
 * It carries a privacy claim as much as a technical one. Kelabo's whole pitch
 * for capture is that audio goes straight from your device to the provider and
 * never through us — a claim nobody can check. A dot that appears exactly while
 * audio is going out, and vanishes the moment it stops, is the observable half
 * of it.
 *
 * The dot is drawn by CSS whenever `live` is set. It also pulses, but the pulse
 * is decoration on top of a state change, never the state itself — see the note
 * in room.css. An indicator that exists only as a keyframe disappears on any
 * machine set to reduce motion, which is most Windows machines tuned for
 * performance, and this room has been caught by that once already.
 */
function Light({ icon, label, tone, title, live = false }) {
  return (
    <span
      className={'conn conn-' + tone + (live ? ' conn-live' : '')}
      title={`${label} — ${title}`}
    >
      <Icon name={icon} size={16} />
      <span className="sr-only">{`${label}: ${title}${live ? ' (sending now)' : ''}`}</span>
    </span>
  )
}

export function ConnStatus({
  boardStatus,
  captureState,
  callState,
  callMode,
  transcribing,
  sttLabel,
  sttLive = false,
  callLive = false,
  callOn = true,
}) {
  const who = sttLabel || 'transcription'
  const [kTone, kTitle] = look(KELABO, boardStatus)
  const [dTone, dTitle] = look(sttStates(who), captureState)
  const [cTone, cTitle] = look(CALL, callState)

  return (
    <div className="cbar-group conn-group" role="status" aria-label="Connection status">
      <Light icon="cloud" label="Kelabo" tone={kTone} title={kTitle} />
      {/* Watch-only participants have no capture pipeline at all, so reporting
          it as "off" would invite them to go looking for a fault they cannot
          fix. It is simply not part of their kelabo. Same for a deployment
          with no STT configured — `transcribing` is false there too. */}
      {transcribing && (
        <Light
          icon="waveform"
          label={sttLabel || 'Transcription'}
          tone={dTone}
          // Only while frames are actually going out. With silence skipping on
          // that is exactly while somebody is speaking, so the dot tracks
          // speech — and on a provider billed by the second, it is also the
          // only moment the meter is running.
          live={sttLive}
          title={sttLive ? `${dTitle} Audio is being sent right now.` : dTitle}
        />
      )}
      {/* And the same again for conference audio that was never configured:
          a grey "off" light is a fault indicator for a service that is simply
          not part of this deployment (docs 19 §2). */}
      {callOn && (
        <Light
          icon="broadcast"
          label={callMode === 'mesh' ? 'P2P' : 'SFU'}
          tone={cTone}
          // Publishing, which for a conference track means unmuted and
          // connected — WebRTC keeps sending through your pauses, so unlike the
          // transcription light this one does not track speech. Steady while
          // you are open to the room, gone the instant you mute, which is the
          // one thing people actually want to be sure of.
          live={callLive}
          title={callLive ? `${cTitle} Your microphone is open to the room.` : cTitle}
        />
      )}
    </div>
  )
}
