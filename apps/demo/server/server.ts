/**
 * Demo server: several data sources behind one origin, a proxy to Piranha's
 * index service, and a static fallback for the built demo.
 *
 * Three sources are mounted, each on its own path prefix:
 *
 *  - `/api/db/platformdb`  — the original Postgres database (relational)
 *  - `/api/db/embeddings`  — a SQLite embedding store (vector mode)
 *  - `/api/db/code-graph`  — a SQLite `code-review-graph` database
 *
 * **Credentials and file paths come from the environment only.** There is no
 * default DSN in this file, nothing is logged that could contain one, and the
 * browser is never told anything about a connection beyond a display label.
 * Copy `.env.example` to `.env` and adjust.
 *
 * Everything degrades independently: a missing `.db` file, or a Postgres that
 * is not running, disables *that* source and leaves the rest working. See
 * `sources.ts`.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDbBrowserHandler } from '@jugaaadi/db-browser-pg'
import { createSqliteBrowserHandler, createSqliteDataSource } from '@jugaaadi/db-browser-sqlite'
import {
  ConnectionStore,
  ConnectorInstaller,
  registerSqliteOpener,
} from '@jugaaadi/db-browser-connectors'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  describeSources,
  getSource,
  proxyToIndexService,
  registerSources,
  sourceIds,
} from './sources.ts'
import { createConnectorsApi } from './connectors-api.ts'
import { createDemoIndexService } from './index-service.ts'
import type { DemoIndexService } from './index-service.ts'

try {
  process.loadEnvFile?.(fileURLToPath(new URL('../.env', import.meta.url)))
} catch {
  /* no .env file — rely on the real environment */
}

const PORT = Number(process.env.PORT ?? 6960)
/**
 * Which address to bind to.
 *
 * Loopback by default, and that default is load-bearing rather than merely
 * cautious: connection editing and connector installs are enabled **only** on
 * a loopback binding (see `connectors-api.ts` and the connectors package's
 * `loopbackGate.ts`). Setting `HOST=0.0.0.0` to reach the demo from another
 * machine is supported, and it turns those two features off with an
 * explanation rather than leaving an SSRF and credential-harvesting surface
 * open to whoever can reach the port.
 */
const HOST = process.env.HOST ?? '127.0.0.1'
const ALLOW_WRITES = process.env.DB_BROWSER_ALLOW_WRITES === 'true'
const TIMEOUT_MS = Number(process.env.DB_BROWSER_TIMEOUT_MS ?? 15_000)
const ALLOWED_ORIGINS = (process.env.DB_BROWSER_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Where semantic search and rebuilds are served from. Optional. */
const PIRANHA_API_URL = process.env.PIRANHA_API_URL?.trim() || undefined

/**
 * Use the local stand-in index service instead of proxying. See
 * `index-service.ts`: search is real (Ollama + a dot product over the stored
 * vectors), rebuild is a dry run that reports genuine progress and writes
 * nothing. Off by default — the real service is always the better answer.
 */
const DEMO_INDEX_SERVICE = process.env.DEMO_INDEX_SERVICE === 'true'
let demoIndex: DemoIndexService | null = null
let demoIndexError: string | null = null

async function getDemoIndex(): Promise<DemoIndexService> {
  if (demoIndex) return demoIndex
  if (demoIndexError) throw new Error(demoIndexError)
  try {
    demoIndex = await createDemoIndexService({ filename: process.env.EMBEDDINGS_DB as string })
    return demoIndex
  } catch (e) {
    demoIndexError = e instanceof Error ? e.message : 'Could not start the demo index service'
    throw new Error(demoIndexError)
  }
}

registerSources({
  databaseUrl: process.env.DATABASE_URL,
  allowWrites: ALLOW_WRITES,
  timeoutMs: TIMEOUT_MS,
  embeddingsDb: process.env.EMBEDDINGS_DB,
  codeGraphDb: process.env.CODE_GRAPH_DB,
})

// One handler per source. `@jugaaadi/db-browser-pg`'s handler serves the
// Postgres source and the SQLite package's serves the SQLite ones — they speak
// the same wire protocol, and the SQLite one additionally answers `/profile`.
const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<boolean>>()

async function handlerFor(id: string, basePath: string, engine: string) {
  const cached = handlers.get(id)
  if (cached) return cached
  const dataSource = await getSource(id)
  const shared = {
    dataSource,
    basePath,
    allowedOrigins: ALLOWED_ORIGINS,
    onError: (e: { code: string; message: string }) =>
      console.error(`[${id}] ${e.code}: ${e.message}`),
    // Demo only. A real deployment MUST authenticate here — see the README.
    authorize: () => null,
  }
  const handler =
    engine === 'sqlite' ? createSqliteBrowserHandler(shared) : createDbBrowserHandler(shared)
  handlers.set(id, handler)
  return handler
}

// ---------------------------------------------------------------------------
// The connector registry and the server-owned connection store
// ---------------------------------------------------------------------------

/**
 * SQLite's adapter is injected rather than imported by the connectors package,
 * which would otherwise be a dependency cycle (the SQLite package depends on
 * the connectors package for its descriptor and type map). The host process is
 * the right place to wire the two together.
 */
registerSqliteOpener(async ({ filename, readOnly, id, label }) =>
  createSqliteDataSource({
    filename,
    readOnly,
    id,
    ...(label ? { label } : {}),
    limits: { defaultLimit: 100, maxLimit: 1000 },
  }),
)

/**
 * Where connections live. **Server-side only** — never the browser. Secrets in
 * this directory are AES-256-GCM ciphertext under a key file created with mode
 * 0600 alongside them.
 */
const STATE_DIR =
  process.env.DB_BROWSER_STATE_DIR ?? fileURLToPath(new URL('../.db-browser', import.meta.url))

const connectionStore = new ConnectionStore({
  directory: STATE_DIR,
  statementTimeoutMs: TIMEOUT_MS,
})

const installer = new ConnectorInstaller({
  // Installs land in the repo root, which is where the workspace's
  // node_modules is — installing into apps/demo would resolve for the demo and
  // not for the packages that actually import the driver.
  cwd: fileURLToPath(new URL('../../..', import.meta.url)),
})

const connectorsApi = createConnectorsApi({
  store: connectionStore,
  installer,
  binding: () => server.address(),
  editingDisabled: process.env.DB_BROWSER_DISABLE_EDITING === 'true',
  onError: (e) => console.error(`[connectors] ${e.code}: ${e.message}`),
})

/** Handlers for saved connections, mounted at `/api/db/conn/<id>`. */
const connectionHandlers = new Map<
  string,
  (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
>()

async function connectionHandlerFor(id: string) {
  const cached = connectionHandlers.get(id)
  if (cached) return cached
  const dataSource = await connectorsApi.sourceFor(id)
  // The SQLite handler is used for every engine here: it is `DataSource`
  // generic and answers one extra route (`/profile`) that the Postgres one
  // does not. A source that cannot profile itself gets the honest
  // `relational` default rather than a 404.
  const handler = createSqliteBrowserHandler({
    dataSource,
    basePath: `/api/db/conn/${id}`,
    allowedOrigins: ALLOWED_ORIGINS,
    onError: (e: { code: string; message: string }) =>
      console.error(`[conn:${id}] ${e.code}: ${e.message}`),
    // Demo only. A real deployment MUST authenticate here — see the README.
    authorize: () => null,
  })
  connectionHandlers.set(id, handler)
  return handler
}

const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-headers', 'content-type, authorization')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    cors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    // The connector catalogue, the install jobs and the connection registry.
    // Mounted before `/api/db/*` so nothing here can be shadowed by a source.
    if (await connectorsApi.handle(req, res)) return

    // A saved connection, browsed through the same wire protocol as a
    // statically-configured source.
    const conn = /^\/api\/db\/conn\/([^/]+)\//.exec(path)
    if (conn) {
      const id = decodeURIComponent(conn[1])
      try {
        const handler = await connectionHandlerFor(id)
        if (await handler(req, res)) return
      } catch (e) {
        sendJson(res, 503, {
          error: {
            code: 'CONNECTION_UNAVAILABLE',
            // `openConnection` and the store already scrub secrets out of
            // their messages; nothing here re-adds any.
            message: e instanceof Error ? e.message : 'This connection could not be opened.',
          },
        })
        return
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } })
      return
    }

    // Which sources exist, and which are usable right now.
    if (path === '/api/sources') {
      sendJson(res, 200, {
        sources: await describeSources(),
        indexService: PIRANHA_API_URL ?? null,
      })
      return
    }

    // Proxy semantic search and rebuilds to Piranha's db-server. Only these two
    // prefixes are forwarded — this is not an open relay.
    if (path.startsWith('/api/index/')) {
      const upstream = path.slice('/api/index'.length)
      if (!/^\/(embeddings|code-graph)\//.test(upstream)) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown index route' } })
        return
      }
      const method = req.method === 'GET' ? 'GET' : 'POST'
      const body = method === 'POST' ? await readBody(req) : undefined

      if (DEMO_INDEX_SERVICE && process.env.EMBEDDINGS_DB) {
        try {
          const service = await getDemoIndex()
          const payload = (body ?? {}) as {
            query?: string
            limit?: number
            kinds?: string[]
            path_prefix?: string
          }
          if (upstream === '/embeddings/search') {
            sendJson(
              res,
              200,
              await service.search(
                String(payload.query ?? ''),
                Number(payload.limit ?? 10),
                payload.kinds,
                payload.path_prefix,
              ),
            )
            return
          }
          if (upstream === '/embeddings/rebuild' && method === 'POST') {
            sendJson(res, 202, service.startRebuild())
            return
          }
          const status = /^\/embeddings\/rebuild\/(.+)$/.exec(upstream)
          if (status && method === 'GET') {
            sendJson(res, 200, service.rebuildStatus(decodeURIComponent(status[1])))
            return
          }
        } catch (e) {
          // The store is there but the model is not, or Ollama is down. Say so
          // precisely — this is the message the search box will render.
          sendJson(res, 503, {
            error: {
              code: 'INDEX_SERVICE_ERROR',
              message: e instanceof Error ? e.message : 'The demo index service failed',
            },
          })
          return
        }
      }

      const result = await proxyToIndexService(PIRANHA_API_URL, upstream, method, body)
      sendJson(res, result.status, result.body)
      return
    }

    // Per-source db-browser routes.
    if (path.startsWith('/api/db/')) {
      for (const descriptor of await describeSources()) {
        if (!path.startsWith(descriptor.basePath + '/')) continue
        if (!descriptor.ready) {
          sendJson(res, 503, {
            error: {
              code: 'SOURCE_UNAVAILABLE',
              message: descriptor.error ?? 'This source could not be opened.',
            },
          })
          return
        }
        const handler = await handlerFor(descriptor.id, descriptor.basePath, descriptor.engine)
        if (await handler(req, res)) return
      }
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown source or route' } })
      return
    }

    // Static: the built demo, when it exists. `vite dev` serves it otherwise.
    const rel = normalize(path === '/' ? 'index.html' : path.replace(/^\/+/, ''))
    if (rel.startsWith('..')) {
      res.writeHead(403).end('forbidden')
      return
    }
    const file = join(distDir, rel)
    const body = await readFile(file).catch(() => null)
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch (e) {
    console.error('[server]', e instanceof Error ? e.message : 'request failed')
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('internal error')
  }
})

server.listen(PORT, HOST, async () => {
  const editing = connectorsApi.gate()
  console.log(`db-browser demo API on http://${HOST}:${PORT}/api`)
  console.log(`  mode         : ${ALLOW_WRITES ? 'READ-WRITE (Postgres only)' : 'read-only'}`)
  console.log(`  origins      : ${ALLOWED_ORIGINS.join(', ') || '(same-origin only)'}`)
  console.log(`  index service: ${PIRANHA_API_URL ?? '(none — search and rebuild disabled)'}`)
  console.log(`  connections  : ${STATE_DIR}`)
  console.log(`  editing      : ${editing.editable ? 'enabled' : 'DISABLED'} — ${editing.message}`)
  console.log('  sources      :')
  if (!sourceIds().length) {
    console.log('    (none configured — set DATABASE_URL, EMBEDDINGS_DB or CODE_GRAPH_DB)')
  }
  for (const s of await describeSources()) {
    console.log(
      `    ${s.ready ? 'ok  ' : 'FAIL'} ${s.id.padEnd(12)} ${s.engine.padEnd(9)} ${s.basePath}` +
        (s.error ? `\n           ${s.error}` : ''),
    )
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close()
    process.exit(0)
  })
}
