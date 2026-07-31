import { formatDistanceToNow } from 'date-fns'

export function timeAgo(ts) {
  if (!ts) return ''
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true })
  } catch {
    return ''
  }
}
