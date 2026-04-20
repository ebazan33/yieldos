import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      {/* Vercel Web Analytics — tracks page views, referrers, countries.
          Privacy-friendly, no cookies, no PII. Free on Vercel hobby tier. */}
      <Analytics />
    </ErrorBoundary>
  </StrictMode>
)
