import { Link } from 'react-router-dom'
import { TopBar } from '../components/TopBar'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'

/**
 * What the second tab on a kelabo shows instead of the room.
 *
 * Deliberately a page and not a dialog over the room: the room must not be
 * mounted at all here (see `useSingleTab`), so there is nothing behind this to
 * dim. Deliberately not a dead end either — the usual cause is a tab someone
 * forgot about hours ago, and "close your other tab" is useless advice when
 * they cannot remember which window it is in.
 */
export function TabTaken({ kelaboId, onTakeOver, busy }) {
  return (
    <>
      <TopBar />
      <main className="page">
        <section className="card card-pad anim-in">
          <h1 className="page-title">Already open in another tab</h1>
          <Banner kind="warn">
            This kelabo is open in another tab of this browser. Two tabs would take
            the microphone twice — echo, and every sentence transcribed twice — and
            the newer one would take over the call, leaving the other silent.
          </Banner>
          <p className="page-sub">
            Carry on in the other tab, or move the kelabo here. Moving it leaves the
            other tab on this screen, so nothing is lost either way.
          </p>
          <div className="row-actions">
            <Button variant="primary" onClick={onTakeOver} disabled={busy}>
              {busy ? 'Moving…' : 'Open here instead'}
            </Button>
            <Button as={Link} variant="ghost" to={`/kelabos/${kelaboId}`}>Kelabo details</Button>
          </div>
        </section>
      </main>
    </>
  )
}
