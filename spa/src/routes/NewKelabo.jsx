import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTypeAnywhere } from '../useTypeAnywhere'
import { api } from '../api'
import { useAuth, displayName } from '../auth'
import { Switch } from '../components/ui/Switch'
import { Button } from '../components/ui/Button'
import { Crumbs } from '../components/ui/Crumbs'
import { useToast } from '../components/Toaster'

export default function NewKelabo() {
  const toast = useToast()
  const navigate = useNavigate()
  const { identity } = useAuth()
  const [title, setTitle] = useState('')
  const titleRef = useRef(null)
  // Typing or pasting anywhere on the page fills the title.
  useTypeAnywhere(titleRef)
  const [mcpEnabled, setMcpEnabled] = useState(true)
  // Off by default and asked for here, not in Settings: it is a decision about
  // THIS kelabo and the people who will be in it (notes #3).
  const [historyEnabled, setHistoryEnabled] = useState(false)
  // Transport for the kelabo's audio, fixed at creation — it cannot change
  // later without revoking the guarantee people joined under.
  const [secure, setSecure] = useState(false)
  const [creating, setCreating] = useState(false)

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      // No title means no title. The server supplies the placeholder used in
      // lists, and the archiver later replaces it with a generated one — the SPA
      // inventing the same string here only made "did the host name this?"
      // unanswerable.
      const m = await api.createKelabo(title.trim(), {
        mcpEnabled,
        historyEnabled,
        rtcMode: secure ? 'mesh' : 'sfu',
      })
      // The locally-set name is the user's own choice and must win over the
      // server identity (which is only ever the email local-part). Creating a
      // kelabo is NOT a name change, so nothing is written back here — doing so
      // clobbered the Settings name and pushed the clobber to every device.
      const name = localStorage.getItem('kelabo-name') || displayName(identity) || 'Host'
      try {
        await api.joinKelabo(m.kelaboId, name, 'audio-board')
        localStorage.setItem('kelabo-mode', 'audio-board')
      } catch {}
      toast('Kelabo created')
      navigate(`/m/${m.kelaboId}/lobby`)
    } catch (e) {
      setCreating(false)
      toast(e?.code === 'unauthorized' ? 'Sign in to create a kelabo' : 'Could not create kelabo — try again')
    }
  }

  return (
    <main className="page">
      <Crumbs className="crumbs-head" to="/" backLabel="Home" here="New kelabo" />

      <section className="card card-pad anim-in">
        <h1 className="page-title">Create a kelabo</h1>
        <p className="page-sub">You'll be the host. Anyone with the invite link can join.</p>

        <div className="field form-stack">
          <label className="label" htmlFor="title">Kelabo title</label>
          <input
            className="input"
            id="title"
            ref={titleRef}
            placeholder="Design sync"
            maxLength={80}
            value={title}
            autoFocus
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') create() }}
          />
        </div>

        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Use my MCP servers</div>
            <div className="sr-sub">Let the kelabo assistant call the tool servers configured in your Settings.</div>
          </div>
          <Switch checked={mcpEnabled} onChange={setMcpEnabled} ariaLabel="Use my MCP servers in this kelabo" />
        </div>

        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Let the assistant read my past kelabos</div>
            <div className="sr-sub">
              It can answer “what did we decide last time” from the minutes of kelabos you attended — nobody
              else's. Everyone in the room is told this is on, because it can surface an earlier kelabo in
              front of someone who was not at it.
            </div>
          </div>
          <Switch
            checked={historyEnabled}
            onChange={setHistoryEnabled}
            ariaLabel="Let the assistant read my past kelabos"
          />
        </div>

        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Secure kelabo (peer-to-peer audio)</div>
            <div className="sr-sub">
              Call audio flows directly between participants and no server can decrypt it — not ours, not
              Cloudflare's. Limited to a handful of participants; extra joiners are turned away rather than
              moved to a relay, and they can still follow the board. Transcription and the assistant work
              exactly as usual.
            </div>
          </div>
          <Switch checked={secure} onChange={setSecure} ariaLabel="Secure peer-to-peer kelabo" />
        </div>

        <div className="settings-row settings-row-plain">
          <div className="sr-main">
            <div className="sr-title">Translate transcript <span className="chip">soon</span></div>
            <div className="sr-sub">Show each line bilingually. Spoken languages are auto-detected.</div>
          </div>
          <Switch checked={false} disabled ariaLabel="Translate transcript (coming soon)" />
        </div>
        <div className="action-row">
          <Button variant="primary" onClick={create} disabled={creating}>
            {creating ? 'Creating…' : 'Create kelabo'}
          </Button>
        </div>
        <p className="form-note">Manage your MCP tool servers in Settings.</p>
      </section>
    </main>
  )
}
