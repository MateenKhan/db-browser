import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DbBrowser, createHttpDataSource } from '@jugaaadi/db-browser'

// Stylesheet order: the embedded table first, then our chrome, so the
// `--dbb-*` tokens can pick up the table's `--jt-*` values.
// Importing the CSS entry does NOT evaluate the table's JS module — that
// happens later, from a dynamic import, after the localStorage scope is
// installed. See `react/lazyTable.tsx` in the library.
import '@jugaaadi/table/style.css'
import '@jugaaadi/db-browser/style.css'
import './demo.css'

/**
 * The browser talks to the demo server, never to Postgres directly — a browser
 * cannot open a Postgres socket, and it must never hold the credentials.
 */
const dataSource = createHttpDataSource({
  baseUrl: `${import.meta.env.VITE_API_URL ?? 'http://localhost:6960'}/api/db`,
  id: 'demo-platformdb',
})

// Reflect the server's real read-only/read-write posture in the UI.
dataSource.refreshCapabilities().catch(() => {
  /* the header just stays on its read-only default */
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DbBrowser dataSource={dataSource} defaultLimit={100} maxLimit={1000} />
  </StrictMode>,
)
