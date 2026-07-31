/**
 * Appearance is two independent choices:
 *   scheme — which palette (clay | slate | sage | plum)
 *   theme  — light or dark within that palette
 *
 * Both are written to <html> as data attributes; kelabo.css resolves the pair
 * to a set of colour tokens. Nothing here knows any colour values.
 */

export const SCHEMES = [
  { id: 'clay', label: 'Clay', hint: 'Warm bone paper, terracotta' },
  { id: 'slate', label: 'Slate', hint: 'Cool grey, indigo' },
  { id: 'sage', label: 'Sage', hint: 'Grey-green, moss' },
  { id: 'plum', label: 'Plum', hint: 'Neutral grey, violet' },
  { id: 'mono', label: 'Mono', hint: 'Black, grey and white' },
  { id: 'matrix', label: 'Matrix', hint: 'Phosphor green terminal' },
]

const DEFAULT_SCHEME = 'clay'

/**
 * Point the browser-chrome colour at whatever --bg currently resolves to.
 * Reading the computed value keeps the single source of truth in the
 * stylesheet — with 4 schemes × 2 themes there are 8 possible backgrounds and
 * none of them should be restated here.
 */
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (!meta) return
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
  if (bg) meta.setAttribute('content', bg)
}

/** Called once at boot, after the stylesheet is available. */
export const syncThemeColorOnLoad = syncThemeColor

export function currentTheme() {
  return document.documentElement.dataset.theme || 'light'
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('kelabo-theme', theme)
  syncThemeColor()
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark')
  return currentTheme()
}

export function currentScheme() {
  const s = document.documentElement.dataset.scheme
  return SCHEMES.some(x => x.id === s) ? s : DEFAULT_SCHEME
}

export function setScheme(scheme) {
  // Guard: an unknown id would leave the app on whatever :root defaults to,
  // which looks like the setting silently failing.
  const id = SCHEMES.some(x => x.id === scheme) ? scheme : DEFAULT_SCHEME
  document.documentElement.dataset.scheme = id
  localStorage.setItem('kelabo-scheme', id)
  syncThemeColor()
  return id
}

// Name of the <Icon> to show in the theme toggle — the icon depicts what a
// click switches *to*, so the dark theme offers the sun.
export function themeIcon() {
  return currentTheme() === 'dark' ? 'sun' : 'moon'
}
