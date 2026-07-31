/**
 * Was this kelabo dialed on the spot or convened in advance? `isCall` is stamped
 * by the huddle endpoint and carried through the archive; the title test
 * catches calls recorded before the flag existed, whose generated titles are
 * the only trace left.
 */
export function isCallKelabo(r) {
  return !!r?.isCall || /^(call with|kelabo with|huddle)/i.test(r?.title || '')
}

/** The glyph a list row wears: a phone for a dialed kelabo, a camera for a convened one. */
export function kelaboKindIcon(r) {
  return isCallKelabo(r) ? 'phone' : 'video'
}
