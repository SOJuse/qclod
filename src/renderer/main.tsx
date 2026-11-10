import { createRoot } from 'react-dom/client'
// Fonts ship inside the build from their packages; nothing is fetched at runtime.
import '@fontsource-variable/inter'
import '@fontsource-variable/inter/wght-italic.css'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/geist-mono/wght-italic.css'
import './styles/tokens.css'
import { App } from './app/App'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

createRoot(container).render(<App />)
