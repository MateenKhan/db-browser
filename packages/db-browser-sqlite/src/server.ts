/**
 * A dependency-free `node:http` handler exposing a SQLite `DataSource` over the
 * wire protocol the browser's HTTP adapter speaks.
 *
 * ## Why this is not just re-exported from `@jugaaadi/db-browser-pg`
 *
 * The handler there is `DataSource`-generic and would work — but importing it
 * would make every SQLite consumer install `pg` (and a Postgres driver) to
 * serve a local file, which is exactly the dependency this package exists to
 * avoid. It also has to grow one route the Postgres one does not need
 * (`/profile`, for vector-store and code-graph detection), so the two are
 * genuinely different surfaces rather than a copy.
 *
 * Deliberately unopinionated about auth, and deliberately blunt about it: this
 * endpoint hands out the contents of a file on disk. Do not mount it on a
 * public origin without authentication in front of it.
 *
 * Nothing here ever logs a file path, a bound value, or a row.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { DB_BROWSER_ROUTES, DbBrowserError, SqlGuardError } from '@jugaaadi/db-browser/core'
import type { DataSource } from '@jugaaadi/db-browser/core'

export interface SqliteServerOptions {
  dataSource: DataSource
  /** Path the routes hang off, e.g. `/api/sqlite`. Default `''`. */
  basePath?: string
  /**
   * Return `null` to allow, or `{ status, message }` to refuse. Called for
   * every request before anything touches the database.
   */
  authorize?: (req: IncomingMessage) => { status: number; message: string } | null
  /** Exact origins allowed to call this (CORS). Default: none (same-origin). */
  allowedOrigins?: string[]
  /** Max request body in bytes. Default 1 MiB. */
  maxBodyBytes?: number
  /** Called with sanitised errors. Default: nothing (no logging at all). */
  onError?: (error: { code: string; message: string }) => void
}

interface Handled {
  status: number
  body: unknown
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function err(code: string, message: string, detail?: string) {
  return { error: { code, message, ...(detail ? { detail } : {}) } }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, never>> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new DbBrowserError('BODY_TOO_LARGE', 'Request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({} as Record<string, never>)
      try {
        resolve(JSON.parse(raw) as Record<string, never>)
      } catch {
        reject(new DbBrowserError('BAD_JSON', 'Request body is not valid JSON'))
      }
    })
    req.on('error', () => reject(new DbBrowserError('BAD_REQUEST', 'Request failed')))
  })
}

export function createSqliteBrowserHandler(options: SqliteServerOptions) {
  const base = (options.basePath ?? '').replace(/\/+$/, '')
  const maxBody = options.maxBodyBytes ?? 1024 * 1024
  const ds = options.dataSource

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(base + '/')) return false
    const route = url.pathname.slice(base.length)
    if (!Object.values(DB_BROWSER_ROUTES).includes(route as never)) return false

    const origin = req.headers.origin
    if (origin && options.allowedOrigins?.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      res.setHeader('access-control-allow-headers', 'content-type, authorization')
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return true
    }
    if (req.method !== 'POST') {
      send(res, { status: 405, body: err('METHOD_NOT_ALLOWED', 'Use POST') })
      return true
    }

    const denial = options.authorize?.(req) ?? null
    if (denial) {
      send(res, { status: denial.status, body: err('UNAUTHORIZED', denial.message) })
      return true
    }

    try {
      const body = await readJson(req, maxBody)
      send(res, await dispatch(route, body))
    } catch (e) {
      const mapped = mapError(e)
      options.onError?.({ code: mapped.body.error.code, message: mapped.body.error.message })
      send(res, mapped)
    }
    return true
  }

  async function dispatch(route: string, body: Record<string, never>): Promise<Handled> {
    switch (route) {
      case DB_BROWSER_ROUTES.capabilities:
        return { status: 200, body: { capabilities: ds.capabilities() } }
      case DB_BROWSER_ROUTES.tables:
        return { status: 200, body: { tables: await ds.listTables() } }
      case DB_BROWSER_ROUTES.describe:
        return { status: 200, body: { schema: await ds.describeTable(body.table) } }
      case DB_BROWSER_ROUTES.profile: {
        if (!ds.describeDatabase) {
          // Relational is the honest answer from a source that cannot classify
          // itself — and it keeps an older adapter working against a newer UI.
          return {
            status: 200,
            body: { profile: { mode: 'relational', detectedBy: 'this source does not classify itself' } },
          }
        }
        return { status: 200, body: { profile: await ds.describeDatabase() } }
      }
      case DB_BROWSER_ROUTES.select:
        return { status: 200, body: { page: await ds.select(body.query) } }
      case DB_BROWSER_ROUTES.insert:
        return { status: 200, body: { row: await ds.insert(body.table, body.row) } }
      case DB_BROWSER_ROUTES.update:
        return { status: 200, body: { row: await ds.update(body.table, body.pk, body.patch) } }
      case DB_BROWSER_ROUTES.delete:
        await ds.delete(body.table, body.pk)
        return { status: 200, body: { ok: true } }
      case DB_BROWSER_ROUTES.query:
        return { status: 200, body: { result: await ds.runQuery(body.sql, body.options) } }
      case DB_BROWSER_ROUTES.binary: {
        if (!ds.fetchBinary) {
          return { status: 400, body: err('NO_BINARY_FETCH', 'This source cannot fetch binary cells') }
        }
        return { status: 200, body: { data: await ds.fetchBinary(body.table, body.pk, body.column) } }
      }
      default:
        return { status: 404, body: err('NOT_FOUND', 'Unknown route') }
    }
  }
}

interface HandledError extends Handled {
  body: { error: { code: string; message: string; detail?: string } }
}

/** Guard rejections are 400s the user can act on; everything else is 500. */
function mapError(e: unknown): HandledError {
  if (e instanceof SqlGuardError) return { status: 400, body: err(e.code, e.message) }
  if (e instanceof DbBrowserError) {
    const status =
      e.code === 'READ_ONLY' || e.code === 'NOT_UPDATABLE'
        ? 403
        : e.code === 'TABLE_NOT_FOUND' || e.code === 'COLUMN_NOT_FOUND' || e.code === 'ROW_NOT_FOUND'
          ? 404
          : 400
    return { status, body: err(e.code, e.message, e.detail) }
  }
  // Never surface a raw error: a SQLite driver error can carry the absolute
  // path of the database file, which discloses the server's filesystem layout.
  return { status: 500, body: err('INTERNAL', 'The request failed') }
}

function send(res: ServerResponse, handled: Handled): void {
  const payload = JSON.stringify(handled.body)
  res.writeHead(handled.status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}
