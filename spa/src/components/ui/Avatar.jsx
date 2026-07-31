/**
 * A generated avatar — one per person, deterministic, nobody chooses it.
 *
 * Before this, everyone got their initials on one of five background colours,
 * which meant a room of six people reliably contained two identical avatars and
 * "AL" in pink was as likely to be Alice as it was to be Alan. Five buckets is
 * not an identity; it is a coincidence waiting to happen, and the whole job of a
 * face on a tile is to be told apart from the other faces at a glance.
 *
 * So the pattern comes from the person's own identity, GitHub-style: a hash
 * drives a 5×5 grid mirrored down the middle, plus a hue off the full circle.
 * The seed is the email wherever there is one, because a display name is
 * something people change — and an avatar that changes when you fix a typo in
 * your name is not an identity either.
 *
 * Pure: same seed in, same pixels out, on every device and every reload. There
 * is nothing stored and nothing to sync.
 */

// FNV-1a. Not for security — for a well-mixed 32 bits from a short string, so
// two addresses differing by one character do not land on adjacent hues.
function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

const GRID = 5
const HALF = Math.ceil(GRID / 2) // 3 generated columns; 2 are mirrored

/**
 * Which cells are filled, as a flat GRID×GRID array of booleans.
 *
 * Only the left half plus the centre column is generated and the rest is
 * mirrored, which is the entire reason these read as *emblems* rather than as
 * noise: symmetry is what the eye remembers when it cannot remember a pattern.
 */
export function identiconCells(seed) {
  const h = hash32(seed)
  const cells = new Array(GRID * GRID).fill(false)
  for (let col = 0; col < HALF; col++) {
    for (let row = 0; row < GRID; row++) {
      // A distinct bit per generated cell (15 of them, well inside 32), re-mixed
      // per column so a column is not simply a shifted copy of its neighbour.
      const bit = (Math.imul(h, col + 1) >>> (row + col * GRID) % 29) & 1
      if (!bit) continue
      cells[row * GRID + col] = true
      cells[row * GRID + (GRID - 1 - col)] = true
    }
  }
  // A hash that fills nothing leaves a blank square, which is the one outcome
  // that is not an identity. The centre column is a legible fallback and only
  // ever reached for seeds that produced no bits at all.
  if (!cells.some(Boolean)) {
    for (let row = 0; row < GRID; row++) cells[row * GRID + 2] = true
  }
  return cells
}

/** The person's colour: a hue off the full circle, fixed saturation/lightness. */
export function avatarHue(seed) {
  return hash32(`hue:${seed}`) % 360
}

/**
 * The seed for a person. Email first — it is the thing that does not change —
 * and only ever the display name for guests, who have nothing else. `variant`
 * is the re-roll salt (Settings → Avatar): 0/absent draws the default, any
 * other value re-derives pattern and hue. It is per-person data, so callers
 * pass whatever the payload that named the person carried.
 */
export function avatarSeed({ id, name, variant }) {
  const base = String(id || name || '?').trim().toLowerCase()
  const v = Number(variant) || 0
  return v > 0 ? `${base}#v${v}` : base
}

/** The signed-in user's own re-roll, straight from the synced local snapshot. */
export function myAvatarVariant() {
  return Number(localStorage.getItem('kelabo-avatar')) || 0
}

export function Avatar({ id, name, variant, size, className = '', title }) {
  const seed = avatarSeed({ id, name, variant })
  const cells = identiconCells(seed)
  const hue = avatarHue(seed)
  const label = name || id || 'Unknown'
  // Colours are computed rather than themed: they have to stay distinguishable
  // from each other, which a theme's palette makes no promise about. Lightness
  // is fixed so the foreground/background pair holds its contrast at every hue.
  const fg = `hsl(${hue} 58% 45%)`
  const bg = `hsl(${hue} 46% 92%)`

  return (
    <span
      className={'avatar ' + className}
      style={size ? { width: size, height: size } : undefined}
      title={title ?? label}
      role="img"
      aria-label={`${label}'s avatar`}
    >
      <svg viewBox={`0 0 ${GRID} ${GRID}`} width="100%" height="100%" aria-hidden="true" focusable="false">
        <rect width={GRID} height={GRID} fill={bg} />
        {cells.map((on, i) =>
          on ? <rect key={i} x={i % GRID} y={Math.floor(i / GRID)} width="1" height="1" fill={fg} /> : null
        )}
      </svg>
    </span>
  )
}
