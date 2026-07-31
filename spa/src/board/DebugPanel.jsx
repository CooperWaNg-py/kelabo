import { useConfirm } from '../components/ConfirmDialog'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'

/**
 * The agent's call history, as a tree on a timeline.
 *
 * The panel used to be a flat stack of request/response cards. Every exchange
 * was there, which is the point of a debug view, but tracing one search meant
 * reading nine cards in a row and reconstructing from memory which sub-agent
 * made which call and in what order — the two things you actually want when
 * something went wrong.
 *
 * So the same data is now a tree: turn → (gate, orchestrator, sub-agents) →
 * calls → tool calls. Every row carries its offset from the start of the turn
 * and its own duration, so the shape of a search — where the twenty seconds
 * went — is readable without opening anything. Bodies stay one click away, and
 * the two live readouts (VAD, transcript ledger) fold out of the way.
 */

function fmtTime(at) {
  if (!at) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

// Offset from the start of the turn: "+2.4s". This is the column that makes the
// tree a timeline.
function fmtOffset(ms) {
  if (!Number.isFinite(ms)) return ''
  if (ms < 0) return '+0.0s'
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`
  return `+${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// 1234 -> "1.2k". Token counts run to hundreds of thousands, so raw digits are
// unreadable at a glance.
function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`
  return String(v)
}

function sumUsage(records) {
  const present = records.filter(Boolean)
  if (!present.length) return null
  return present.reduce(
    (a, u) => ({
      cacheRead: a.cacheRead + (u.cacheRead || 0),
      cacheWrite: a.cacheWrite + (u.cacheWrite || 0),
      input: a.input + (u.input || 0),
      output: a.output + (u.output || 0),
      total: a.total + (u.total || 0),
    }),
    { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 }
  )
}

// "42k/8.1k/1.2k (hit/in/out)" — cache-hit prompt tokens, freshly-billed prompt
// tokens, generated tokens. The three buckets are disjoint, so they add to the total.
export function TokenChip({ usage, label }) {
  if (!usage || !usage.total) return null
  const title =
    `cache hit: ${usage.cacheRead}\n` +
    (usage.cacheWrite ? `cache write: ${usage.cacheWrite}\n` : '') +
    `input: ${usage.input}\noutput: ${usage.output}\ntotal: ${usage.total}`
  return (
    <span className="chip" title={title}>
      {label ? `${label} ` : ''}tokens {fmtTokens(usage.cacheRead)}/{fmtTokens(usage.input)}/{fmtTokens(usage.output)}
      <span className="dbg-token-unit">(hit/in/out)</span>
    </span>
  )
}

// This drawer is LLM traffic only. Every caption the client posted used to be
// mirrored here as well, which meant a tail every 250ms per speaker — the
// agent's turns, which is what the drawer exists for, were unreadable between
// them. The transcript's own record is the Transcript ledger below.
const KIND_LABEL = {
  gate: 'Trigger gate',
  main: 'Main agent',
  subagent: 'Sub-agent',
  minutes: 'Minutes',
}

// A tool call, as one line: what was asked for, not the whole JSON.
function toolCallLabel(tc) {
  const input = tc.input ?? {}
  if (tc.name === 'web_search') return `web_search · ${input.query ?? ''}`
  if (tc.name === 'web_fetch') return `web_fetch · ${input.url ?? ''}`
  if (tc.name === 'mcp_query') {
    const req = input.request ?? {}
    return `mcp_query · ${input.server ?? '?'}${req.listTools ? ' · listTools' : req.tool ? ` · ${req.tool}` : ''}`
  }
  if (tc.name === 'dispatch_subagent') return `dispatch · ${input.task_id ?? '?'} · ${input.objective ?? ''}`
  return `${tc.name} · ${JSON.stringify(input)}`
}

/* ---------- tree primitives ---------- */

/**
 * One row of the tree. With `children` it is an expandable node; without, a
 * leaf. Either way the layout is the same — offset gutter, label, chips,
 * tokens, duration — so rows line up down the whole tree.
 */
function TreeNode({ offset, label, sublabel, chips, usage, duration, tone, defaultOpen = false, children }) {
  const row = (
    <>
      <span className="dbg-t">{offset}</span>
      <span className="dbg-node-label">
        {label}
        {sublabel && <span className="dbg-node-sub">{sublabel}</span>}
      </span>
      {chips}
      <span className="spacer"></span>
      <TokenChip usage={usage} />
      {duration && <span className="dbg-dur">{duration}</span>}
    </>
  )
  if (!children) {
    return <div className={'dbg-row dbg-leaf' + (tone ? ` is-${tone}` : '')}>{row}</div>
  }
  return (
    <details className={'dbg-node' + (tone ? ` is-${tone}` : '')} open={defaultOpen}>
      <summary className="dbg-row">
        <span className="dbg-twisty" aria-hidden="true"><Icon name="chevron-right" size={12} /></span>
        {row}
      </summary>
      <div className="dbg-children">{children}</div>
    </details>
  )
}

/** The raw request/response body of a single LLM exchange. */
function ExchangeBody({ request, response }) {
  const entry = request ?? response ?? {}
  const messages = entry.messages || []
  return (
    <div className="dbg-exchange">
      {entry.system && (
        <details className="dbg-block">
          <summary>system prompt</summary>
          <pre className="dbg-pre">{entry.system}</pre>
        </details>
      )}
      {messages.length > 0 && (
        <details className="dbg-block">
          <summary>
            context sent to model ({messages.length} message{messages.length === 1 ? '' : 's'}
            {typeof entry.threadLen === 'number' ? `, thread=${entry.threadLen}` : ''})
          </summary>
          {messages.map((m, i) => (
            <div key={i} className="dbg-msg">
              <div className="text-meta">{m.role}</div>
              <pre className="dbg-pre">{typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}</pre>
            </div>
          ))}
        </details>
      )}
      {response && (
        <details className="dbg-block" open>
          <summary>response</summary>
          <pre className="dbg-pre">{response.raw || '(empty response)'}</pre>
          {(response.toolCalls || []).length > 0 && (
            <pre className="dbg-pre">{response.toolCalls.map(tc => `→ ${tc.name}(${JSON.stringify(tc.input)})`).join('\n')}</pre>
          )}
          {response.reason && <div className="text-meta">reason: {response.reason}</div>}
          {response.query && <div className="text-meta">query: {response.query}</div>}
        </details>
      )}
      {!response && <div className="text-meta">no response captured (still running, or the call failed)</div>}
    </div>
  )
}

/**
 * One LLM round trip as a node: the call itself, expandable to its bodies, with
 * every tool call it returned as a child leaf. This is the level at which a
 * trace is actually read — "call 2 took 6s and asked for bom.gov.au".
 */
function CallNode({ call, turnAt }) {
  const usage = call.response?.usage ?? call.request?.usage
  const toolCalls = call.response?.toolCalls || []
  return (
    <TreeNode
      offset={fmtOffset(call.at - turnAt)}
      label={call.label}
      chips={
        <>
          {call.model && <span className="chip">{call.model}</span>}
          {call.verdict && <span className="chip chip-accent">{call.verdict}{typeof call.confidence === 'number' ? ` ${call.confidence}` : ''}</span>}
          {!call.response && <span className="chip">pending</span>}
          {call.error && <span className="chip chip-danger">error</span>}
        </>
      }
      usage={usage}
      duration={fmtDuration(call.endAt - call.at)}
      tone={call.error ? 'danger' : undefined}
    >
      <ExchangeBody request={call.request} response={call.response} />
      {toolCalls.map((tc, i) => (
        <TreeNode key={i} offset="" label={<code className="dbg-tool">{toolCallLabel(tc)}</code>} />
      ))}
    </TreeNode>
  )
}

/** One sub-agent: its whole tool loop, plus the force-conclude call if it ran. */
function SubAgentNode({ taskId, calls, objective, turnAt }) {
  const usage = sumUsage(calls.map(c => c.response?.usage ?? c.request?.usage))
  const first = calls[0]
  const last = calls[calls.length - 1]
  const concluded = last?.response && !(last.response.toolCalls || []).length
  return (
    <TreeNode
      offset={fmtOffset((first?.at ?? turnAt) - turnAt)}
      label={<><span className="chip chip-accent">sub-agent</span> {taskId}</>}
      sublabel={objective}
      chips={
        <>
          <span className="chip">{calls.length} call{calls.length === 1 ? '' : 's'}</span>
          {concluded && <span className="chip">concluded</span>}
        </>
      }
      usage={usage}
      duration={fmtDuration((last?.endAt ?? last?.at ?? 0) - (first?.at ?? 0))}
      defaultOpen
    >
      {calls.map((c, i) => <CallNode key={i} call={c} turnAt={turnAt} />)}
    </TreeNode>
  )
}

/** A full orchestration turn: gate → orchestrator → the sub-agents it dispatched. */
function TurnNode({ turn }) {
  const subIds = Object.keys(turn.subs)
  const dispatched = turn.main.some(c => (c.response?.toolCalls || []).length)
  // Cost of the entire search: the gate decision that triggered it, the
  // orchestrator call, and every sub-agent iteration. Prefer the gateway's own
  // rolled-up `turn_usage` for the agent half (it includes the force-conclude
  // call, which has no debug exchange of its own), falling back to summing the
  // visible exchanges when that entry hasn't arrived yet.
  const subUsage = subIds.flatMap(id => turn.subs[id].calls.map(c => c.response?.usage ?? c.request?.usage))
  const agentUsage = turn.usage || sumUsage([...turn.main.map(c => c.response?.usage ?? c.request?.usage), ...subUsage])
  const totalUsage = sumUsage([agentUsage, ...turn.gate.map(c => c.response?.usage ?? c.request?.usage)])
  const query = turn.query || turn.gate.find(c => c.response?.query)?.response?.query
  const endAt = Math.max(
    turn.at,
    ...turn.main.map(c => c.endAt || c.at),
    ...subIds.flatMap(id => turn.subs[id].calls.map(c => c.endAt || c.at))
  )

  return (
    <div className="card card-pad dbg-turn">
      <div className="panel-toolbar">
        <span className="chip chip-accent">Turn</span>
        {query && <span className="dbg-query">{query}</span>}
        <span className="spacer"></span>
        {subIds.length > 0 && <span className="chip">{subIds.length} sub-agent{subIds.length === 1 ? '' : 's'}</span>}
        {!dispatched && <span className="chip">no dispatch</span>}
        <TokenChip usage={totalUsage} />
        <span className="chip" title="Wall-clock time from the gate decision to the last response">
          <Icon name="clock" size={11} />{fmtDuration(endAt - turn.at) || '—'}
        </span>
        <span className="text-meta">{fmtTime(turn.at)}</span>
      </div>

      <div className="dbg-tree">
        {turn.gate.length > 0 && (
          <TreeNode
            offset={fmtOffset(turn.gate[0].at - turn.at)}
            label={<><span className="chip">gate</span> {turn.gate[0].response?.verdict ?? 'decision'}</>}
            sublabel={turn.gate[0].response?.reason}
            usage={sumUsage(turn.gate.map(c => c.response?.usage))}
            duration={fmtDuration(turn.gate[0].endAt - turn.gate[0].at)}
          >
            {turn.gate.map((c, i) => <CallNode key={i} call={c} turnAt={turn.at} />)}
          </TreeNode>
        )}

        <TreeNode
          offset={fmtOffset((turn.main[0]?.at ?? turn.at) - turn.at)}
          label={<><span className="chip">orchestrator</span> {dispatched ? 'dispatched' : 'no dispatch'}</>}
          usage={sumUsage(turn.main.map(c => c.response?.usage))}
          duration={fmtDuration((turn.main.at(-1)?.endAt ?? 0) - (turn.main[0]?.at ?? 0))}
          defaultOpen
        >
          {turn.main.map((c, i) => <CallNode key={i} call={c} turnAt={turn.at} />)}
        </TreeNode>

        {subIds.map(id => (
          <SubAgentNode
            key={id}
            taskId={id}
            calls={turn.subs[id].calls}
            objective={turn.subs[id].objective}
            turnAt={turn.at}
          />
        ))}
      </div>
    </div>
  )
}

/* ---------- stream → tree ---------- */

const CALL_LABEL = {
  gate: 'gate decision',
  main: 'orchestrator call',
  subagent: 'call',
  minutes: 'minutes',
}

/**
 * Fold a flat entry list into request/response pairs. The gateway emits one
 * entry per phase; a call is a request plus whichever response follows it, so
 * the pair is what carries a duration.
 */
function pairCalls(entries, kind) {
  const calls = []
  let open = null
  for (const e of entries) {
    const isRequest = e.phase === 'request' || e.phase === 'conclude_request'
    const isConclude = e.phase?.startsWith('conclude')
    if (isRequest) {
      open = {
        label: isConclude ? 'force-conclude' : `${CALL_LABEL[kind] || 'call'}${e.iteration ? ` #${e.iteration}` : ''}`,
        at: e.at,
        endAt: e.at,
        model: e.model,
        request: e,
        response: null,
      }
      calls.push(open)
      continue
    }
    // A response with no request before it (panel opened mid-turn, or entries
    // cleared) still deserves a row rather than being dropped.
    const target = open ?? { label: CALL_LABEL[kind] || 'call', at: e.at, endAt: e.at, model: e.model, request: null, response: null }
    if (!open) calls.push(target)
    target.response = e
    target.endAt = e.at
    target.verdict = e.verdict
    target.confidence = e.confidence
    target.error = e.phase === 'conclude_error'
    open = null
  }
  return calls
}

/**
 * Group the chronological SSE entry stream into turns. Entries carrying a
 * turnId (main + subagent) collapse into one turn; the gate decision that woke
 * that turn is attached to it; everything else (orphan gate decisions with no
 * dispatch, minutes) stays as its own item.
 */
function buildTimeline(entries) {
  const turns = new Map()
  const items = []
  let pendingGate = null

  const ensureTurn = (turnId, at) => {
    let t = turns.get(turnId)
    if (!t) {
      t = { type: 'turn', turnId, at, mainEntries: [], subEntries: new Map(), gateEntries: [], usage: null, query: '' }
      turns.set(turnId, t)
      if (pendingGate) {
        t.gateEntries = pendingGate
        t.at = pendingGate[0]?.at ?? at
        pendingGate = null
      }
      items.push(t)
    }
    return t
  }

  for (const e of entries) {
    if (e.kind === 'gate') {
      if (!pendingGate) pendingGate = []
      pendingGate.push(e)
      // A NONE verdict never becomes a turn. Flush it as its own item now,
      // rather than letting it wait around and be adopted by the next turn —
      // which is how one turn used to show four unrelated gate decisions.
      if (e.phase === 'response' && e.verdict === 'NONE') {
        items.push({ type: 'gate-orphan', entries: pendingGate })
        pendingGate = null
      }
      continue
    }
    if (e.kind === 'turn_usage' && e.turnId) {
      ensureTurn(e.turnId, e.at).usage = e.usage
      continue
    }
    if ((e.kind === 'main' || e.kind === 'subagent') && e.turnId) {
      const t = ensureTurn(e.turnId, e.at)
      if (e.kind === 'main') {
        t.mainEntries.push(e)
        if (e.query) t.query = e.query
      } else {
        const key = e.taskId || '(no id)'
        if (!t.subEntries.has(key)) t.subEntries.set(key, { objective: '', entries: [] })
        const sub = t.subEntries.get(key)
        if (e.objective) sub.objective = e.objective
        sub.entries.push(e)
      }
      continue
    }
    // Standalone traffic with no turn (minutes, mostly). Its request and
    // response are separate entries — keep consecutive ones of the same kind in
    // one item so they pair into a single call rather than two half-cards.
    const last = items[items.length - 1]
    if (last?.type === 'entry' && last.kind === e.kind) last.entries.push(e)
    else items.push({ type: 'entry', kind: e.kind, entries: [e] })
  }

  if (pendingGate) items.push({ type: 'gate-orphan', entries: pendingGate })

  // Pair every branch's entries into calls once the grouping is complete.
  for (const t of turns.values()) {
    t.gate = pairCalls(t.gateEntries, 'gate')
    t.main = pairCalls(t.mainEntries, 'main')
    t.subs = {}
    for (const [taskId, sub] of t.subEntries) {
      t.subs[taskId] = { objective: sub.objective, calls: pairCalls(sub.entries, 'subagent') }
    }
  }
  return items
}

/* ---------- live readouts ---------- */

// Live VAD gate readout. A cycle is one open→shut pass of the speech gate, which
// is what seals a spoken message — so these numbers say directly whether the
// gate is landing on thought-groups (a few cycles a minute, mean open in the
// seconds) or chopping inside sentences (many short cycles), which is the knob
// behind `hangoverMs` in capture/vad.js.
function GateStats({ stats }) {
  if (!stats || !stats.framesSeen) return null
  const pct = n => `${Math.round(n * 100)}%`
  return (
    <details className="card card-pad dbg-card dbg-fold">
      <summary className="dbg-fold-head">
        <span className="dbg-twisty" aria-hidden="true"><Icon name="chevron-right" size={12} /></span>
        VAD gate
        <span className="text-meta">{stats.cycles} cycles · {stats.cyclesPerMin}/min</span>
      </summary>
      <div className="dbg-kv">
        <span title="Open→shut passes of the speech gate. Each one normally seals a message.">
          cycles <b>{stats.cycles}</b> ({stats.cyclesPerMin}/min)
        </span>
        <span title="Mean time the gate stays open — roughly the length of one utterance.">
          mean open <b>{stats.meanOpenMs}ms</b>
        </span>
        <span title="Mean silence between utterances, as measured on the mic.">
          mean shut <b>{stats.meanShutMs}ms</b>
        </span>
        <span title="Share of captured audio never sent to Deepgram, and so never billed.">
          silence skipped <b>{pct(stats.skipped)}</b>
        </span>
        <span title="Audio actually streamed vs wall clock.">
          streamed <b>{Math.round(stats.sentMs / 1000)}s</b> / {Math.round(stats.seenMs / 1000)}s
        </span>
      </div>
    </details>
  )
}

// Message ledger: every message in this client's transcript, by the id the
// SPEAKER minted. Two participants comparing this panel see the same ids, the
// same boundaries and the same delta counts — or they do not, and the
// divergence is visible instead of having to be inferred from screenshots.
//
// Folded shut by default: it is a reference you open when boundaries look
// wrong, and it was pushing the agent's turns — the reason the drawer exists —
// below the fold on every screen.
function MessageLedger({ messages }) {
  if (!messages?.length) return null
  const open = messages.filter(m => m.state === 'open').length
  return (
    <details className="card card-pad dbg-card dbg-fold">
      <summary className="dbg-fold-head">
        <span className="dbg-twisty" aria-hidden="true"><Icon name="chevron-right" size={12} /></span>
        Transcript ledger
        <span className="text-meta">
          {messages.length} message{messages.length === 1 ? '' : 's'}{open ? `, ${open} still open` : ''}
        </span>
      </summary>
      <div className="dbg-ledger">
        {messages.slice(-40).map(m => (
          <div key={m.messageId} className="dbg-ledger-row">
            <code title="Message id — minted by the speaker, identical on every client">{m.messageId}</code>
            <span className={'chip' + (m.mine ? ' chip-accent' : '')}>{m.mine ? 'mine' : 'received'}</span>
            <span className="chip" title="Speaker label">{m.speakerLabel}</span>
            <span
              className={'chip' + (m.state === 'open' ? '' : ' chip-live')}
              title={m.state === 'sealed' ? `sealed: ${m.reason || 'remote'}` : 'still open'}
            >
              {m.state === 'sealed' ? m.reason || 'sealed' : 'open'}
            </span>
            <span className="text-meta" title="Deltas folded into this message">Δ{m.deltas}</span>
            <span className="text-meta">{m.text.length}c</span>
          </div>
        ))}
      </div>
    </details>
  )
}

export function DebugPanel({ entries, onClear, gateStats, messages }) {
  const confirm = useConfirm()
  const items = buildTimeline(entries)
  const turnCount = items.filter(i => i.type === 'turn').length
  // Kelabo-wide total. Turns that reported a rolled-up `turn_usage` are counted
  // from that figure; everything else (gate decisions, standalone exchanges) is
  // summed from its own entries, so nothing is double-counted.
  const sessionUsage = sumUsage(
    items.flatMap(item => {
      if (item.type === 'turn') {
        const subUsage = Object.values(item.subs).flatMap(s => s.calls.map(c => c.response?.usage))
        const agent = item.usage || sumUsage([...item.main.map(c => c.response?.usage), ...subUsage])
        return [agent, ...item.gate.map(c => c.response?.usage)]
      }
      return (item.entries ?? []).map(e => e.usage)
    })
  )
  const clearLogs = async () => {
    const ok = await confirm({
      title: 'Clear debug log?',
      body: 'This removes every captured request/response from this view. It only affects your local session — nothing is deleted from the kelabo itself.',
      confirmLabel: 'Clear',
    })
    if (ok) onClear()
  }

  return (
    <div>
      <div className="panel-toolbar">
        <span className="text-meta flex-1">
          {entries.length
            ? `${entries.length} event${entries.length === 1 ? '' : 's'} · ${turnCount} turn${turnCount === 1 ? '' : 's'}`
            : 'Nothing yet — LLM requests and raw responses appear here as they happen.'}
        </span>
        <TokenChip usage={sessionUsage} label="kelabo" />
        {entries.length > 0 && <Button variant="danger-ghost" size="sm" onClick={clearLogs}>Clear</Button>}
      </div>
      <GateStats stats={gateStats} />
      <MessageLedger messages={messages} />
      {[...items].reverse().map((item, i) => {
        if (item.type === 'turn') return <TurnNode key={item.turnId} turn={item} />
        if (item.type === 'gate-orphan') {
          const calls = pairCalls(item.entries, 'gate')
          const at = calls[0]?.at ?? 0
          return (
            <div key={`gate-${i}`} className="card card-pad dbg-card">
              <div className="panel-toolbar">
                <span className="chip">gate</span>
                <span className="dbg-query">{calls[0]?.response?.verdict ?? 'decision'} — no dispatch</span>
                <span className="spacer"></span>
                <TokenChip usage={sumUsage(calls.map(c => c.response?.usage))} />
                <span className="text-meta">{fmtTime(at)}</span>
              </div>
              <div className="dbg-tree">
                {calls.map((c, j) => <CallNode key={j} call={c} turnAt={at} />)}
              </div>
            </div>
          )
        }
        const calls = pairCalls(item.entries, item.kind)
        const at = calls[0]?.at ?? item.entries[0]?.at ?? 0
        return (
          <div key={`e-${i}`} className="card card-pad dbg-card">
            <div className="panel-toolbar">
              <span className="chip">{KIND_LABEL[item.kind] || item.kind}</span>
              <span className="spacer"></span>
              <TokenChip usage={sumUsage(calls.map(c => c.response?.usage))} />
              <span className="text-meta">{fmtTime(at)}</span>
            </div>
            <div className="dbg-tree">
              {calls.map((c, j) => <CallNode key={j} call={c} turnAt={at} />)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
