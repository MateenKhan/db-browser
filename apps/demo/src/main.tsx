import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DbBrowser, createHttpDataSource, createHttpVectorService } from '@jugaaadi/db-browser'
import type { BrowserSource, ConnectionsApi, VectorService } from '@jugaaadi/db-browser'
import { detectConnectionsApi } from './mockConnections.js'

// Stylesheet order: the embedded table first, then our chrome, so the
// `--dbb-*` tokens can pick up the table's `--jt-*` values.
// Importing the CSS entry does NOT evaluate the table's JS module — that
// happens later, from a dynamic import, after the localStorage scope is
// installed. See `react/lazyTable.tsx` in the library.
import '@jugaaadi/table/style.css'
import '@jugaaadi/db-browser/style.css'
import './demo.css'

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:6960'

/**
 * `?motion=reduce` — make the reduced-motion path testable without changing an
 * OS setting.
 *
 * The library's motion layer branches on `prefers-reduced-motion` in
 * JavaScript, not only in CSS (see `react/motion.tsx`), and that branch is the
 * part a stylesheet cannot express: under reduction no motion component is
 * mounted at all. But a guarantee nobody can exercise is a guarantee nobody
 * checks, and flipping the preference in Windows/macOS settings is not
 * something a reviewer will do — so the demo offers a switch.
 *
 * It has to run **here**, in the module body, and not inside a component:
 * `framer-motion` reads the media query once, on the first `useReducedMotion()`
 * call, which happens during the first render. This runs before that, and after
 * the hoisted imports have evaluated — the only window where the override
 * lands. Demo only; the library never touches `matchMedia` itself.
 */
if (new URLSearchParams(location.search).get('motion') === 'reduce') {
  const real = window.matchMedia.bind(window)
  window.matchMedia = ((query: string) =>
    query.includes('prefers-reduced-motion')
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as unknown as MediaQueryList)
      : real(query)) as typeof window.matchMedia
  document.documentElement.dataset.forcedReducedMotion = 'true'
}

interface SourceDescriptor {
  id: string
  label: string
  description: string
  engine: 'postgres' | 'sqlite'
  basePath: string
  ready: boolean
  error: string | null
}

/**
 * The demo lets you pick which database to browse — a relational Postgres, a
 * SQLite embedding store, or a SQLite code graph — so the rendering modes can
 * be compared side by side against real data.
 *
 * Every source is listed even when it cannot be opened, with the reason
 * attached. A picker that hides what is broken makes "why is my database
 * missing" an unanswerable question.
 *
 * The source picker is no longer passed through `headerSlot`: `DbBrowser` takes
 * `sources` / `activeSourceId` / `onSelectSource` directly, which is what lets
 * the sources appear in the command palette and behind the `mod+shift+s`
 * binding as well as in the dropdown. (Bindings are written in the canonical
 * form the registry uses — never as a platform's glyphs; `platform.ts` in the
 * library decides how each one is spelled for the machine it renders on.)
 * A slot could only ever have produced the dropdown.
 */
function Demo() {
  const [sources, setSources] = useState<SourceDescriptor[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [indexService, setIndexService] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connections, setConnections] = useState<{ api: ConnectionsApi; live: boolean } | null>(null)
  const [sourcesNonce, setSourcesNonce] = useState(0)

  useEffect(() => {
    fetch(`${API}/api/sources`)
      .then((r) => r.json())
      .then((body: { sources: SourceDescriptor[]; indexService: string | null }) => {
        setSources(body.sources)
        setIndexService(body.indexService)
        // Open the first *working* source, not simply the first one.
        setSelected((prev) => prev ?? body.sources.find((s) => s.ready)?.id ?? body.sources[0]?.id ?? null)
      })
      .catch((e: Error) =>
        setLoadError(
          `Could not reach the demo server at ${API}. Run \`npm run demo:server\`. (${e.message})`,
        ),
      )
  }, [sourcesNonce])

  // Real endpoints if the server has them, an in-memory stand-in otherwise.
  // Probed once: whether the API exists is a property of the deployment, not
  // of the moment.
  useEffect(() => {
    let cancelled = false
    void detectConnectionsApi(API).then((detected) => {
      if (!cancelled) setConnections(detected)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const active = sources?.find((s) => s.id === selected) ?? null

  // A new `DataSource` per selected source, keyed on its id.
  const dataSource = useMemo(() => {
    if (!active?.ready) return null
    const ds = createHttpDataSource({
      baseUrl: `${API}${active.basePath}`,
      id: `demo-${active.id}`,
    })
    // Reflect the server's real read-only posture *and its dialect*, which
    // drives the editor grammar, completion, formatting and the guard.
    ds.refreshCapabilities().catch(() => {
      /* the header just stays on its defaults */
    })
    return ds
  }, [active?.id, active?.ready, active?.basePath])

  /**
   * Search and rebuild are served by Piranha's db-server, reached through the
   * demo's proxy. `null` when no index service is configured — which the vector
   * view renders as "search is unavailable" rather than failing the page.
   */
  const vectorService: VectorService | null = useMemo(() => {
    if (!active?.ready || !indexService) return null
    return createHttpVectorService({
      baseUrl: `${API}/api/index`,
      kind: active.id === 'code-graph' ? 'codeGraph' : 'embeddings',
      id: `demo-index-${active.id}`,
    })
  }, [active?.id, active?.ready, indexService])

  const pickerSources = useMemo<BrowserSource[]>(
    () =>
      (sources ?? []).map((s) => ({
        id: s.id,
        label: s.label,
        detail: s.engine,
        disabled: !s.ready,
        disabledReason: s.error ?? undefined,
      })),
    [sources],
  )

  if (loadError) {
    return (
      <div className="demo-error" role="alert">
        <h1>Demo server unavailable</h1>
        <p>{loadError}</p>
      </div>
    )
  }

  if (!sources) return <div className="demo-loading">Loading sources…</div>

  if (!active || !dataSource) {
    return (
      <div className="demo-shell">
        <header className="demo-header">
          <label className="demo-picker">
            <span>Source</span>
            <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.ready}>
                  {s.label} · {s.engine}
                  {s.ready ? '' : ' (unavailable)'}
                </option>
              ))}
            </select>
          </label>
        </header>
        <div className="demo-error" role="alert">
          <h1>{active ? `${active.label} is unavailable` : 'No sources configured'}</h1>
          <p>
            {active?.error ??
              'Set DATABASE_URL, EMBEDDINGS_DB or CODE_GRAPH_DB in apps/demo/.env and restart the server.'}
          </p>
          <p className="demo-muted">
            The other sources in the picker are unaffected — this failure is scoped to one
            connection.
          </p>
        </div>
      </div>
    )
  }

  return (
    <DbBrowser
      // Remount on source change: schema, rows and staged edits all belong to
      // the connection they came from and must not survive a switch.
      key={active.id}
      dataSource={dataSource}
      vectorService={vectorService}
      defaultLimit={100}
      maxLimit={1000}
      sources={pickerSources}
      activeSourceId={active.id}
      onSelectSource={setSelected}
      connectionsApi={connections?.api ?? null}
      onConnectionsChanged={() => setSourcesNonce((n) => n + 1)}
      headerSlot={
        <>
          {connections && !connections.live ? (
            <span
              className="demo-hint"
              title="GET /api/connectors is not served yet, so the connection manager is running against an in-memory stand-in that implements the same contract."
            >
              mock connections API
            </span>
          ) : null}
          {!indexService ? (
            <span className="demo-hint" title="Set PIRANHA_API_URL in apps/demo/.env">
              no index service
            </span>
          ) : null}
        </>
      }
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
)
