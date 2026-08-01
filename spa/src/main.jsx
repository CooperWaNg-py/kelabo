import { createRoot } from 'react-dom/client'
import App from './App'
import { config } from './config'
import { syncThemeColorOnLoad } from './theme'
import './styles/index.css'

// The inline head script sets data-theme/data-scheme before paint, but the
// stylesheet is not parsed yet at that point, so --bg cannot be read there.
syncThemeColorOnLoad()

// Name the deployment in the tab, so someone running more than one — a pilot
// and production, say — can tell their pinned tabs apart. Set once here rather
// than per route: it is baked into the bundle at build time and cannot change
// while the page is open, and index.html's plain "kelabo" stays the fallback
// for a deployment that configured no name.
if (config.orgName) document.title = `${config.orgName} · kelabo`

createRoot(document.getElementById('root')).render(<App />)
