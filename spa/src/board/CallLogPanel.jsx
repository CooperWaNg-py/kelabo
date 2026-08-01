import { useEffect, useRef, useState } from 'react'
import { callLog } from '../rtc/callLog.js'
import { useConfirm } from '../components/ConfirmDialog'
import { Button } from '../components/ui/Button'

/**
 * The call debug log, viewed on demand.
 *
 * Everything the conference stack records (see rtc/callLog.js) is already
 * persisted in localStorage — this card is only a window onto it: the text
 * refreshes while the drawer is open, keeps itself scrolled to the newest
 * line, and copies or downloads as one timestamped block for analysis.
 */
export function CallLogPanel() {
  const confirm = useConfirm()
  const [text, setText] = useState(() => callLog.text())
  const preRef = useRef(null)

  // Mounted only while the debug drawer is open (see Kelabo.jsx), so polling
  // here costs nothing when nobody is looking.
  useEffect(() => {
    const t = setInterval(() => setText(callLog.text()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  const lines = text ? text.split('\n').length : 0

  const copy = async () => {
    try { await navigator.clipboard.writeText(text) } catch {}
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `kelabo-call-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const clear = async () => {
    const ok = await confirm({
      title: 'Clear call log?',
      body: 'This removes the recorded WebRTC/SFU/ICE events from this browser. It only affects your local session.',
      confirmLabel: 'Clear',
    })
    if (ok) {
      callLog.clear()
      setText('')
    }
  }

  return (
    <div className="card card-pad dbg-card">
      <div className="panel-toolbar">
        <span className="chip chip-accent">Call log</span>
        <span className="text-meta flex-1">
          {lines ? `${lines} line${lines === 1 ? '' : 's'} · kept across reloads` : 'No call events yet'}
        </span>
        {lines > 0 && (
          <span className="dbg-actions">
            <Button variant="ghost" size="sm" onClick={copy}>Copy</Button>
            <Button variant="ghost" size="sm" onClick={download}>Download</Button>
            <Button variant="danger-ghost" size="sm" onClick={clear}>Clear</Button>
          </span>
        )}
      </div>
      {!lines && (
        <p className="text-meta" style={{ marginTop: 0 }}>
          With debug on, everything WebRTC, SFU and ICE lands here as the call runs.
        </p>
      )}
      {lines > 0 && <pre ref={preRef} className="dbg-pre dbg-calllog">{text}</pre>}
    </div>
  )
}
