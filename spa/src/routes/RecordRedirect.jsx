import { Navigate, useParams } from 'react-router-dom'

/**
 * `/records/:id` → `/kelabos/:id`.
 *
 * The archive was called "records" and is now called kelabos, but links to it
 * are already out in the world — in service-worker notification payloads, in
 * whatever people pasted into chat when a kelabo ended. Renaming a URL is only
 * free if the old one still arrives somewhere sensible.
 */
export function RecordRedirect() {
  const { id } = useParams()
  return <Navigate to={`/kelabos/${id}`} replace />
}
