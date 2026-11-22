import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/**
 * Demo mode runs the UI against a pretend server in the browser (src/demo). It is built in with
 * `pnpm build:demo`; in development, open the app with ?demo to try it (?demo=0 turns it off again).
 */
function demoMode(): boolean {
  if (import.meta.env.VITE_DEMO === 'true') return true
  if (!import.meta.env.DEV) return false
  const param = new URLSearchParams(window.location.search).get('demo')
  try {
    if (param !== null) {
      if (param === '0' || param === 'false') sessionStorage.removeItem('hubwatch.demo-mode')
      else sessionStorage.setItem('hubwatch.demo-mode', '1')
    }
    return sessionStorage.getItem('hubwatch.demo-mode') === '1'
  } catch {
    return param !== null && param !== '0' && param !== 'false'
  }
}

async function start() {
  if (demoMode()) await import('./demo/install')
  createRoot(document.getElementById('root')!).render(<App />)
}

start()
