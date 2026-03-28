import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const rootEl = document.getElementById('root')

if (!rootEl) {
  throw new Error('Missing #root element')
}

function showFatal(el: HTMLElement, err: unknown): void {
  el.innerHTML = ''
  const pre = document.createElement('pre')
  pre.style.whiteSpace = 'pre-wrap'
  pre.style.padding = '16px'
  pre.style.fontFamily =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
  if (err instanceof Error) {
    pre.textContent = err.stack || err.message
  } else {
    pre.textContent = String(err)
  }
  el.appendChild(pre)
}

window.addEventListener('error', (event) => {
  showFatal(rootEl, event.error || event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  showFatal(rootEl, event.reason)
})

rootEl.textContent = 'Booting…'

try {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (e: any) {
  showFatal(rootEl, e)
}
