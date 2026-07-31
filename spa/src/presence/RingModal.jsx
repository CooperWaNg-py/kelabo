import { Button } from '../components/ui/Button'
import { Avatar } from '../components/ui/Avatar'
import { Modal } from '../components/ui/Modal'

/**
 * The incoming-ring modal (docs 18 §6): "X is calling", Decline / Join.
 * Escape declines.
 *
 * Structurally identical to every other dialog in the app — the same
 * `.modal-title` with a badge, the same `.modal-body`, the same right-aligned
 * `.modal-actions` with the dismissive answer on the left. It used to be
 * centre-composed with an oversized avatar, on the argument that an incoming
 * call is answered before it is read; in practice that just made one dialog
 * look like it came from a different product. The caller's avatar takes the
 * badge slot the other dialogs give an icon, and keeps its pulse — that is the
 * only thing here that says "ringing, now" rather than "something happened".
 */
export function RingModal({ ring, onAccept, onDecline }) {
  const who = ring.fromName || ring.from
  return (
    <Modal
      open
      onDismiss={onDecline}
      label={`${who} is calling`}
      badge={<Avatar id={ring.from} name={who} variant={ring.fromAvatar} className="modal-icon ring-avatar" />}
      title={`${who} is calling`}
      actions={
        <>
          <Button variant="ghost" onClick={onDecline}>Decline</Button>
          <Button variant="primary" onClick={onAccept}>Join</Button>
        </>
      }
    >
      <p className="modal-body">
        {ring.title
          ? `They want you in “${ring.title}”. Joining takes you straight in.`
          : 'Joining takes you straight into the kelabo.'}
      </p>
    </Modal>
  )
}
