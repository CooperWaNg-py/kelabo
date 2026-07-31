/**
 * "Untitled kelabo" is a placeholder, not a title.
 *
 * The server stores it whenever a host does not give one, which is right — a
 * kelabo needs *some* name in a list of kelabos, and the archiver later
 * replaces it with a title the assistant generates from what was discussed.
 *
 * But inside the room it is noise. The title sits at the top of the screen next
 * to Live / a timer / a headcount, and there it is a label announcing that
 * nobody labelled anything. Better to show the kelabo's actual state and
 * nothing else (notes #10).
 *
 * One function rather than a comparison at each call site, because the
 * placeholder string is written in the REST API and read in the SPA — two
 * places that will not be changed together.
 */

export const UNTITLED = 'Untitled kelabo'

/** The title to show in the room, or '' when there is nothing worth showing. */
export function roomTitle(title) {
  const t = String(title || '').trim()
  return !t || t.toLowerCase() === UNTITLED.toLowerCase() ? '' : t
}
