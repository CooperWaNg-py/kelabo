import { createRoot } from 'react-dom/client'
import App from './App'
import { syncThemeColorOnLoad } from './theme'
import './styles/index.css'

// The inline head script sets data-theme/data-scheme before paint, but the
// stylesheet is not parsed yet at that point, so --bg cannot be read there.
syncThemeColorOnLoad()

createRoot(document.getElementById('root')).render(<App />)
