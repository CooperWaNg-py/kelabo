import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { Menu, MenuHeader, MenuItem, MenuToggle, MenuValue } from '../components/ui/Menu'
import { ConnStatus } from './ConnStatus'
import { LAYOUTS } from './layouts'
import { SCHEMES } from '../theme'

/**
 * Every control in the room, in one row.
 *
 * They used to be strung along the header: a mute button, four loose
 * checkboxes, a language dropdown, a debug toggle, a menu and two more buttons,
 * all at the same visual weight, so finding mute meant reading the whole row.
 * Here they are grouped by what they act on — your microphone, what you can
 * read, how the room is arranged — and the settings that are set once a kelabo
 * live behind the chevron of the thing they configure, rather than in the row
 * you use every minute.
 */

const LANGS = [
  ['en', 'English'],
  ['zh', '中文'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['multi', 'Auto (multi)'],
]

// Same list, keyed — the Language row shows what it is set to without opening.
const LANG_LABEL = Object.fromEntries(LANGS)

/**
 * Why the camera is or is not going to work, in the user's terms.
 *
 * Every branch here is a real state someone hit: a deployment with video turned
 * off, a page served over plain http, a machine with no camera, a permission
 * the browser is remembering a "block" for, and a call that has not connected
 * yet so nothing you send reaches anyone.
 */
function camNote(cam, available, publishing) {
  if (!available) return 'Video is turned off for this deployment.'
  if (cam.state === 'insecure') return 'The camera needs a secure page — open this app over https or on localhost.'
  if (cam.state === 'unavailable') return 'No camera found on this device.'
  if (cam.state === 'denied') return 'Your browser blocked camera access. Allow it for this site in the address bar, then try again.'
  if (cam.state === 'requesting') return 'Waiting for you to allow camera access…'
  if (cam.on && !publishing) return 'Your camera is on, but the call is not connected — nobody else can see you yet.'
  if (!cam.on) return 'Turn the camera on and your browser will ask for permission. Devices are only named once it is granted.'
  if (cam.devices.length === 0) return 'No camera found on this device.'
  return ''
}

function CAM_TITLE(cam, available, publishing) {
  const note = camNote(cam, available, publishing)
  if (!available || cam.error) return note
  return cam.on ? 'Turn the camera off' : 'Turn the camera on'
}

export function ControlBar({
  ended,
  boardOnly,
  capture,
  cam,
  screen,
  // Audio output selection ({ supported, deviceId, devices, setDeviceId }).
  // Absent or unsupported (Safari) simply hides the row.
  speaker,
  camAvailable,
  camPublishing,
  // Non-null when a screen share cannot be admitted right now (mesh room at
  // its participants-plus-shares cap); the string says why.
  shareNote = null,
  stt,
  micPrefs = {},
  captionsOn,
  onToggleCaptions,
  panel,
  onPanel,
  boardCount,
  layout,
  onLayout,
  onToggleDebug,
  onCopyInvite,
  onJoinCode,
  onGenerateMinutes,
  onToggleTheme,
  onScheme,
  scheme,
  themeIcon,
  onHold,
  conn,
}) {
  const micDisabled =
    ended ||
    capture.state === 'mic_denied' ||
    capture.state === 'insecure_context' ||
    capture.state === 'stt_unavailable'
  const current = LAYOUTS.find(l => l.id === layout) ?? LAYOUTS[0]

  return (
    <div
      className="cbar"
      onMouseEnter={() => onHold?.(true)}
      onMouseLeave={() => onHold?.(false)}
    >
      {/* First in the row: it is the only thing in the bar you read rather than
          press, so it sits at the leading edge and stays out of the way of the
          controls people reach for every minute. */}
      <ConnStatus {...conn} />

      {!boardOnly && (
        <div className="cbar-group cbar-pair">
          <button
            className={'cbtn cbtn-mic' + (capture.muted ? ' is-off' : ' is-on')}
            disabled={micDisabled}
            aria-pressed={!capture.muted}
            title={
              capture.muted
                ? micPrefs.held
                  ? 'Auto-muted because this tab is inactive — unmute to talk now, or come back to the tab'
                  : 'Unmute'
                : 'Mute — the microphone stays open, but nothing is streamed or billed'
            }
            onClick={() => (capture.muted ? capture.unmute() : capture.mute())}
          >
            <Icon name={capture.muted ? 'mic-off' : 'mic'} size={18} />
            <span className={'meter' + (capture.muted || capture.state !== 'live' ? ' muted' : '')} aria-hidden="true">
              <i></i><i></i><i></i><i></i><i></i>
            </span>
          </button>
          <Menu
            ariaLabel="Audio and transcription settings"
            onOpenChange={onHold}
            renderTrigger={props => (
              <button className="cbtn cbtn-chev" title="Audio and transcription settings" {...props}>
                <Icon name="chevron-up" size={14} />
              </button>
            )}
          >
            {({ view, open, back }) => (view === 'speaker' && speaker ? (
              <>
                <MenuHeader onBack={back}>Speaker</MenuHeader>
                <MenuItem
                  icon={<Icon name="volume" />}
                  className={!speaker.deviceId ? 'is-on' : ''}
                  disabled={ended}
                  onClick={() => { back(); speaker.setDeviceId('') }}
                >
                  System default
                  {!speaker.deviceId && <span className="menu-tick"><Icon name="check" size={14} /></span>}
                </MenuItem>
                {speaker.devices.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => (
                  <MenuItem
                    key={d.deviceId || i}
                    icon={<Icon name="volume" />}
                    className={speaker.deviceId === d.deviceId ? 'is-on' : ''}
                    disabled={ended}
                    onClick={() => { back(); speaker.setDeviceId(d.deviceId) }}
                  >
                    {d.label || `Speaker ${i + 1}`}
                    {speaker.deviceId === d.deviceId && <span className="menu-tick"><Icon name="check" size={14} /></span>}
                  </MenuItem>
                ))}
              </>
            ) : view === 'lang' ? (
              <>
                <MenuHeader onBack={back}>Language</MenuHeader>
                {/* The globe on every row is not decoration: it is the icon
                    column the camera and layout pickers have, and without it the
                    language labels sat flush left while the header's title —
                    indented past its back arrow — did not. */}
                {LANGS.map(([v, l]) => (
                  <MenuItem
                    key={v}
                    icon={<Icon name="globe" />}
                    className={stt.lang === v ? 'is-on' : ''}
                    disabled={ended}
                    onClick={() => { back(); stt.onLang(v) }}
                  >
                    {l}
                    {stt.lang === v && <span className="menu-tick"><Icon name="check" size={14} /></span>}
                  </MenuItem>
                ))}
              </>
            ) : (
              <>
                {/* Toggles wear a switch; the one setting with several values
                    shows the value it is on and drills into the list. The
                    section headings that used to sit here are gone: with an
                    icon on every row and the control on the right, "Microphone"
                    and "Transcription" were labelling what the rows already
                    said. */}
                <MenuToggle
                  icon={<Icon name="mic-off" />}
                  checked={!!micPrefs.muteHidden}
                  disabled={ended}
                  title="Mute as soon as you switch away from this tab, and unmute again when you come back — so whatever you switched away to do does not go into the kelabo. A mute you set yourself is never undone."
                  onChange={v => micPrefs.onMuteHidden?.(v)}
                >
                  Auto mute
                </MenuToggle>
                <MenuValue
                  icon={<Icon name="globe" />}
                  value={LANG_LABEL[stt.lang] || stt.lang}
                  disabled={ended}
                  title="The language Deepgram transcribes this kelabo in."
                  onClick={() => open('lang')}
                >
                  Language
                </MenuValue>
                {/* Only when the browser can actually switch outputs (Safari
                    cannot) — a picker that does nothing is worse than none. */}
                {speaker?.supported && speaker.devices.length > 0 && (
                  <MenuValue
                    icon={<Icon name="volume" />}
                    value={
                      speaker.devices.find(d => d.deviceId === speaker.deviceId)?.label
                        || 'Default'
                    }
                    disabled={ended}
                    title="Which audio output the call plays through."
                    onClick={() => open('speaker')}
                  >
                    Speaker
                  </MenuValue>
                )}
                <MenuToggle
                  icon={<Icon name="users" />}
                  checked={stt.diarize}
                  disabled={ended}
                  title="Detect and label different speakers (A, B, …). You can rename them."
                  onChange={stt.onDiarize}
                >
                  Speakers
                </MenuToggle>
                <MenuToggle
                  icon={<Icon name="waveform" />}
                  checked={stt.vad}
                  disabled={ended}
                  title="Only stream audio while you are speaking — silence is skipped, which is most of a kelabo for any one person. Turn off if quiet speech is being cut."
                  onChange={stt.onVad}
                >
                  VAD
                </MenuToggle>
                <MenuToggle
                  icon={<Icon name="captions" />}
                  checked={stt.finalOnly}
                  disabled={ended}
                  title="Hide the unconfirmed tail of each utterance — only settled words."
                  onChange={stt.onFinalOnly}
                >
                  Slow caption
                </MenuToggle>
              </>
            ))}
          </Menu>
        </div>
      )}

      {!boardOnly && (
        <div className="cbar-group cbar-pair">
          <button
            className={'cbtn cbtn-cam' + (cam.on ? ' is-on' : '')}
            disabled={ended || !camAvailable}
            aria-pressed={cam.on}
            title={CAM_TITLE(cam, camAvailable, camPublishing)}
            onClick={cam.toggle}
          >
            <Icon name={cam.on ? 'video' : 'video-off'} size={18} />
          </button>
          <Menu
            ariaLabel="Choose a camera"
            onOpenChange={onHold}
            renderTrigger={props => (
              <button className="cbtn cbtn-chev" title="Choose a camera" {...props}>
                <Icon name="chevron-up" size={14} />
              </button>
            )}
          >
            {({ close }) => (
              <>
                <MenuHeader>Camera</MenuHeader>
                {/* Whatever is stopping video says so here. A disabled button
                    with the reason in a `title` is a reason nobody reads —
                    which is exactly how "it never asked for permission" turns
                    into a mystery instead of a message. */}
                {camNote(cam, camAvailable, camPublishing) && (
                  <div className="menu-note">{camNote(cam, camAvailable, camPublishing)}</div>
                )}
                {cam.devices.map((d, i) => (
                  <MenuItem
                    key={d.deviceId || i}
                    icon={<Icon name="video" />}
                    className={cam.deviceId === d.deviceId ? 'is-on' : ''}
                    onClick={() => { close(); cam.setDeviceId(d.deviceId) }}
                  >
                    {d.label || `Camera ${i + 1}`}
                    {cam.deviceId === d.deviceId && <span className="menu-tick"><Icon name="check" size={14} /></span>}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
        </div>
      )}

      {!boardOnly && (
        <div className="cbar-group">
          <button
            className={'cbtn cbtn-share' + (screen.on ? ' is-on' : '')}
            disabled={ended || !camAvailable || screen.state === 'unavailable' || (!!shareNote && !screen.on)}
            aria-pressed={screen.on}
            title={
              screen.state === 'unavailable'
                ? 'This browser cannot share a screen'
                : !camAvailable
                  ? 'Screen sharing is not available on this call'
                  : shareNote && !screen.on
                    ? shareNote
                    : screen.on ? 'Stop sharing your screen' : 'Share your screen'
            }
            onClick={screen.toggle}
          >
            <Icon name="screen-share" size={18} />
          </button>
        </div>
      )}

      <div className="cbar-group">
        <button
          className={'cbtn' + (captionsOn ? ' is-on' : '')}
          aria-pressed={captionsOn}
          title={captionsOn ? 'Hide live captions' : 'Show live captions'}
          onClick={onToggleCaptions}
        >
          <Icon name="captions" size={18} />
        </button>
        <button
          className={'cbtn' + (panel === 'transcript' ? ' is-on' : '')}
          aria-pressed={panel === 'transcript'}
          title="Transcript — the whole conversation, in a side panel"
          onClick={() => onPanel('transcript')}
        >
          <Icon name="panel-right" size={18} />
        </button>
        <button
          className={'cbtn' + (panel === 'board' ? ' is-on' : '')}
          aria-pressed={panel === 'board'}
          title="Board — assistant contributions and notes"
          onClick={() => onPanel('board')}
        >
          <Icon name="message-square" size={18} />
          {boardCount > 0 && <span className="cbtn-count">{boardCount}</span>}
        </button>
      </div>

      <div className="cbar-group cbar-pair">
        <button
          className="cbtn"
          title={`Layout: ${current.label}`}
          onClick={() => {
            const i = LAYOUTS.findIndex(l => l.id === layout)
            onLayout(LAYOUTS[(i + 1) % LAYOUTS.length].id)
          }}
        >
          <Icon name={current.icon} size={18} />
        </button>
        <Menu
          ariaLabel="Choose a layout"
          onOpenChange={onHold}
          renderTrigger={props => (
            <button className="cbtn cbtn-chev" title="Choose a layout" {...props}>
              <Icon name="chevron-up" size={14} />
            </button>
          )}
        >
          {({ close }) => (
            <>
              <MenuHeader>Layout</MenuHeader>
              {LAYOUTS.map(l => (
                <MenuItem
                  key={l.id}
                  icon={<Icon name={l.icon} />}
                  className={layout === l.id ? 'is-on' : ''}
                  title={l.hint}
                  onClick={() => { close(); onLayout(l.id) }}
                >
                  {l.label}
                  {layout === l.id && <span className="menu-tick"><Icon name="check" size={14} /></span>}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
      </div>

      <div className="cbar-group">
        {/* A control, not a menu item. Light and dark get swapped for a reason
            that arrives suddenly — a window moved onto a bright screen, a
            recording about to start — and two clicks through a "more" menu is
            two more than that is worth. The icon names where it goes, not what
            it does. */}
        <button
          className="cbtn"
          title={themeIcon === 'sun' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          aria-label={themeIcon === 'sun' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          onClick={onToggleTheme}
        >
          <Icon name={themeIcon} size={18} />
        </button>
        {/* A button of its own, flat in the row like every other one here — not
            chevroned onto the theme toggle. The palette is not a setting *of*
            light/dark, and gluing them made a three-button lump in a bar whose
            every other control is a single flat icon. */}
        <Menu
          ariaLabel="Choose a colour palette"
          onOpenChange={onHold}
          renderTrigger={props => (
            <button className="cbtn" title="Colour palette" aria-label="Colour palette" {...props}>
              <Icon name="palette" size={18} />
            </button>
          )}
        >
          {({ close }) => (
            <>
              <MenuHeader>Palette</MenuHeader>
              {SCHEMES.map(sch => (
                <MenuItem
                  key={sch.id}
                  icon={
                    // Each row previews its own palette by rendering the
                    // swatches inside a nested data-scheme — the same trick
                    // Settings uses, so no colour value is restated in JS.
                    <span className="scheme-swatches scheme-swatches-sm" data-scheme={sch.id} aria-hidden="true">
                      <span className="scheme-sw scheme-sw-bg"></span>
                      <span className="scheme-sw scheme-sw-accent"></span>
                      <span className="scheme-sw scheme-sw-text"></span>
                    </span>
                  }
                  className={scheme === sch.id ? 'is-on' : ''}
                  title={sch.hint}
                  onClick={() => { close(); onScheme(sch.id) }}
                >
                  {sch.label}
                  {scheme === sch.id && <span className="menu-tick"><Icon name="check" size={14} /></span>}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        {/* A flat button, not a menu item, because you reach for it mid-call —
            under the same time pressure as the code itself. */}
        <button
          className="cbtn"
          title="Join code: read a six-character code down a phone"
          aria-label="Join code"
          onClick={onJoinCode}
        >
          <Icon name="phone" size={18} />
        </button>
        <Menu
          ariaLabel="More kelabo actions"
          onOpenChange={onHold}
          renderTrigger={props => (
            <button className="cbtn" title="More" {...props}>
              <Icon name="more-horizontal" size={18} />
            </button>
          )}
        >
          {({ close }) => (
            <>
              <MenuItem icon={<Icon name="link" />} onClick={() => { close(); onCopyInvite() }}>
                Copy invite link
              </MenuItem>
              <MenuItem icon={<Icon name="file-text" />} onClick={() => { close(); onGenerateMinutes() }}>
                Generate minutes
              </MenuItem>
              <MenuItem icon={<Icon name="bug" />} onClick={() => { close(); onToggleDebug() }}>
                Debug log
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </div>
  )
}
