import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import { App } from './app/App'

const container = document.getElementById('root')
if (!container) throw new Error('root container missing')

createRoot(container).render(<App />)
