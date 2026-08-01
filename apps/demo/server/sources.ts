/**
 * The demo's data sources, and the proxy to Piranha's index service.
 *
 * ## Why sources are lazy
 *
 * Every source here is opened **on first use**, not at boot. A demo that hard-
 * fails because Postgres is not running, or because one `.db` file has been
 * moved, is a demo nobody can use to look at the sources that *are* available.
 * So a failure to open is recorded against that source and reported when it is
 * selected — the picker still lists it, and the other sources still work.
 *
 * ## Why the search/rebuild endpoints are proxied
 *
 * Semantic search needs to embed the *query*, which needs the embedding model.
 * That lives in Piranha's db-server, a separate process this demo does not own
 * and must not reach into. The demo therefore forwards `/embeddings/*` and
 * `/code-graph/*` to a configurable base URL and — the part that matters —
 * **degrades to a clear message when that service is not running** rather than
 * failing the page. Browsing an embedding store with the indexer down is a
 * perfectly reasonable thing to want to do: the stats, the chunks and the SQL
 * console all still work; only the search box and the rebuild button do not.
 */

import { createSqliteDataSource } from '@jugaaadi/db-browser-sqlite'
import { createPgDataSource } from '@jugaaadi/db-browser-pg'
import type { DataSource } from '@jugaaadi/db-browser/core'
import pg from 'pg'

export interface SourceDescriptor {
  id: string
  /** Shown in the picker. */
  label: string
  /** One line explaining what this source *is*. */
  description: string
  engine: 'postgres' | 'sqlite'
  /** Route prefix this source is mounted on, e.g. `/api/db/vector`. */
  basePath: string
  /** True once the source has been opened successfully. */
  ready: boolean
  /** Why it could not be opened, if it could not. */
  error: string | null
}

interface SourceDefinition extends Omit<SourceDescriptor, 'ready' | 'error'> {
  open: () => Promise<DataSource>
}

interface LoadedSource {
  definition: SourceDefinition
  dataSource: DataSource | null
  error: string | null
}

const registry = new Map<string, LoadedSource>()

export function defineSource(definition: SourceDefinition): void {
  registry.set(definition.id, { definition, dataSource: null, error: null })
}

/** Open a source on demand, remembering a failure so it is not retried per request. */
export async function getSource(id: string): Promise<DataSource> {
  const entry = registry.get(id)
  if (!entry) throw new Error(`Unknown source: ${id}`)
  if (entry.dataSource) return entry.dataSource
  if (entry.error) throw new Error(entry.error)
  try {
    entry.dataSource = await entry.definition.open()
    return entry.dataSource
  } catch (e) {
    // The message is kept, but never the stack or the driver's error object —
    // a SQLite error carries the absolute path, and a `pg` error carries the
    // pool's client config, password included.
    entry.error = e instanceof Error ? e.message : 'Could not open this source'
    throw new Error(entry.error)
  }
}

/**
 * Describe every source for the picker. Opening is attempted here so the UI can
 * grey out what is unavailable *and say why*, which is strictly more useful
 * than a picker whose entries fail only once clicked.
 */
export async function describeSources(): Promise<SourceDescriptor[]> {
  const out: SourceDescriptor[] = []
  for (const [id, entry] of registry) {
    if (!entry.dataSource && !entry.error) {
      try {
        await getSource(id)
      } catch {
        /* the error is now recorded on the entry */
      }
    }
    const { open: _open, ...rest } = entry.definition
    out.push({ ...rest, ready: !!entry.dataSource, error: entry.error })
  }
  return out
}

export function sourceIds(): string[] {
  return [...registry.keys()]
}

// ---------------------------------------------------------------------------
// The three sources
// ---------------------------------------------------------------------------

export interface RegisterOptions {
  databaseUrl?: string
  allowWrites: boolean
  timeoutMs: number
  embeddingsDb?: string
  codeGraphDb?: string
}

/** Database name only — never the user, host or password. */
function safeLabel(dsn: string): string {
  try {
    return new URL(dsn).pathname.replace(/^\//, '') || 'postgres'
  } catch {
    return 'postgres'
  }
}

export function registerSources(options: RegisterOptions): void {
  if (options.databaseUrl) {
    const dsn = options.databaseUrl
    defineSource({
      id: 'platformdb',
      label: safeLabel(dsn),
      description: 'A relational Postgres database — the original demo target.',
      engine: 'postgres',
      basePath: '/api/db/platformdb',
      open: async () => {
        const pool = new pg.Pool({
          connectionString: dsn,
          max: 5,
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 5_000,
        })
        pool.on('error', (e: Error) => console.error('[pool]', e.message))
        // Prove the DSN works now rather than on the first table click.
        const probe = await pool.connect()
        probe.release()
        return createPgDataSource({
          pool,
          label: safeLabel(dsn),
          readOnly: !options.allowWrites,
          statementTimeoutMs: options.timeoutMs,
          limits: { defaultLimit: 100, maxLimit: 1000 },
          id: `pg:${safeLabel(dsn)}`,
        })
      },
    })
  }

  if (options.embeddingsDb) {
    const filename = options.embeddingsDb
    defineSource({
      id: 'embeddings',
      label: 'code-embeddings',
      description: 'A SQLite embedding store — chunks, vectors and build metadata.',
      engine: 'sqlite',
      basePath: '/api/db/embeddings',
      open: () =>
        createSqliteDataSource({
          filename,
          // Always read-only, regardless of DB_BROWSER_ALLOW_WRITES: an index
          // is derived data, and hand-editing a vector produces a row that
          // survives until the next build and is wrong in the meantime.
          readOnly: true,
          limits: { defaultLimit: 100, maxLimit: 1000 },
          id: 'sqlite:embeddings',
        }),
    })
  }

  if (options.codeGraphDb) {
    const filename = options.codeGraphDb
    defineSource({
      id: 'code-graph',
      label: 'graph.db',
      description: 'A SQLite code graph — symbols and the edges between them.',
      engine: 'sqlite',
      basePath: '/api/db/code-graph',
      open: () =>
        createSqliteDataSource({
          filename,
          readOnly: true,
          limits: { defaultLimit: 100, maxLimit: 1000 },
          id: 'sqlite:code-graph',
        }),
    })
  }
}

// ---------------------------------------------------------------------------
// The index-service proxy
// ---------------------------------------------------------------------------

export interface ProxyResult {
  status: number
  body: unknown
}

/**
 * Forward one request to the index service.
 *
 * A connection failure is turned into a **503 with an actionable message**
 * rather than being allowed to reject: the browser's `VectorService` maps a
 * network error to a generic string, and "ECONNREFUSED 127.0.0.1:6952" is not
 * something a user of this demo can act on, whereas "the index service is not
 * running at http://localhost:6952" is.
 */
export async function proxyToIndexService(
  baseUrl: string | undefined,
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  timeoutMs = 30_000,
): Promise<ProxyResult> {
  if (!baseUrl) {
    return {
      status: 503,
      body: {
        error: {
          code: 'NO_INDEX_SERVICE',
          message:
            'No index service is configured. Set PIRANHA_API_URL in apps/demo/.env to enable ' +
            'semantic search and rebuilds. Browsing the store itself does not need it.',
        },
      },
    }
  }

  // A rebuild POST returns immediately with a job id, and a search should not
  // hang the page either — so every proxied call is bounded.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        return {
          status: 502,
          body: {
            error: {
              code: 'BAD_UPSTREAM',
              message: `The index service returned non-JSON (${res.status}).`,
            },
          },
        }
      }
    }
    return { status: res.status, body: parsed ?? {} }
  } catch (e) {
    const aborted = (e as Error)?.name === 'AbortError'
    return {
      status: 503,
      body: {
        error: {
          code: aborted ? 'INDEX_SERVICE_TIMEOUT' : 'INDEX_SERVICE_UNAVAILABLE',
          message: aborted
            ? `The index service at ${baseUrl} did not respond within ${Math.round(timeoutMs / 1000)}s.`
            : `The index service at ${baseUrl} is not reachable. Start Piranha's db-server, or ` +
              'clear PIRANHA_API_URL. Everything except search and rebuild still works.',
        },
      },
    }
  } finally {
    clearTimeout(timer)
  }
}
