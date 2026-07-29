/**
 * Demo server: a Postgres pool + the db-browser HTTP handler + a static
 * fallback for the built demo, in about a hundred lines.
 *
 * **Credentials come from the environment only.** There is no default DSN in
 * this file, nothing is logged that could contain one, and the browser is
 * never told anything about the connection beyond a display label. Copy
 * `.env.example` to `.env` and adjust.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createDbBrowserHandler, createPgDataSource } from '@jugaaadi/db-browser-pg'

try {
  process.loadEnvFile?.(fileURLToPath(new URL('../.env', import.meta.url)))
} catch {
  /* no .env file — rely on the real environment */
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set. Copy apps/demo/.env.example to apps/demo/.env, or export it.',
  )
  process.exit(1)
}

const PORT = Number(process.env.PORT ?? 6960)
const ALLOW_WRITES = process.env.DB_BROWSER_ALLOW_WRITES === 'true'
const ALLOWED_ORIGINS = (process.env.DB_BROWSER_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PGPOOL_MAX ?? 5),
  // A browser tool must never be the reason a connection slot leaks.
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
})

// The pool's own errors can carry the client config — log only the message.
pool.on('error', (e: Error) => console.error('[pool]', e.message))

const dataSource = createPgDataSource({
  pool,
  // A display label. Deliberately derived from the database name only — never
  // the DSN, which would leak the password into every capabilities response.
  label: safeLabel(DATABASE_URL),
  readOnly: !ALLOW_WRITES,
  statementTimeoutMs: Number(process.env.DB_BROWSER_TIMEOUT_MS ?? 15_000),
  limits: { defaultLimit: 100, maxLimit: 1000 },
  id: `pg:${safeLabel(DATABASE_URL)}`,
})

const api = createDbBrowserHandler({
  dataSource,
  basePath: '/api/db',
  allowedOrigins: ALLOWED_ORIGINS,
  onError: (e) => console.error(`[api] ${e.code}: ${e.message}`),
  // Demo only. A real deployment MUST authenticate here — see the README.
  authorize: () => null,
})

const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
}

const server = createServer(async (req, res) => {
  try {
    if (await api(req, res)) return

    // Static: the built demo, when it exists. `vite dev` serves it otherwise.
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
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

server.listen(PORT, () => {
  console.log(`db-browser demo API on http://localhost:${PORT}/api/db`)
  console.log(`  database : ${safeLabel(DATABASE_URL)}`)
  console.log(`  mode     : ${ALLOW_WRITES ? 'READ-WRITE (writes enabled)' : 'read-only'}`)
  console.log(`  origins  : ${ALLOWED_ORIGINS.join(', ') || '(same-origin only)'}`)
})

/** Database name only — never the user, host or password. */
function safeLabel(dsn: string): string {
  try {
    const url = new URL(dsn)
    return url.pathname.replace(/^\//, '') || 'postgres'
  } catch {
    return 'postgres'
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close()
    pool.end().finally(() => process.exit(0))
  })
}
