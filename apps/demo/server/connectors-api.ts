/**
 * The connector and connection HTTP surface.
 *
 * Five route groups, in the demo server's own style (a `node:http` handler
 * that returns `true` when it took the request):
 *
 * ```
 * GET    /api/connectors                    -> ConnectorStatus[]  + the edit gate
 * POST   /api/connectors/:id/install        -> { job }            (202, returns immediately)
 * GET    /api/connectors/install/:jobId     -> { phase, percent, message, done, error }
 * GET    /api/connections                   -> PublicConnection[] (never a secret)
 * POST   /api/connections                   -> PublicConnection
 * PUT    /api/connections/:id               -> PublicConnection
 * DELETE /api/connections/:id               -> { ok: true }
 * POST   /api/connections/:id/test          -> { ok, durationMs, message }
 * POST   /api/connections/test              -> { ok, … }          (an unsaved form)
 * ```
 *
 * ## Two rules this file exists to hold
 *
 * **1. Every mutating route passes through `assertEditable` first.** Connection
 * create/edit/delete and connector install are disabled unless the server is
 * bound to loopback — see `loopbackGate.ts` for why that is not optional. The
 * check is the first statement in each handler, before the body is even read,
 * so there is no path where a body is parsed and acted on before the gate.
 *
 * **2. No response, log line or error ever contains a password.** The store
 * only ever hands out `PublicConnection`, which has no secret field at all;
 * `testConnection` scrubs the driver's message against the config's own
 * secrets; and the installer scrubs registry tokens out of its output. The
 * `onError` hook logs a code and a message that have already been through
 * those filters.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ConnectionStore,
  ConnectorInstaller,
  assertEditable,
  connectorStatuses,
  evaluateEditGate,
  openConnection,
  requireDescriptor,
  testConnection,
} from '@jugaaadi/db-browser-connectors'
import type { EditGate } from '@jugaaadi/db-browser-connectors'
import type { DataSource } from '@jugaaadi/db-browser/core'
import { DbBrowserError } from '@jugaaadi/db-browser/core'

export interface ConnectorsApiOptions {
  store: ConnectionStore
  installer: ConnectorInstaller
  /** What the HTTP server is actually bound to. `server.address()`. */
  binding: () => { address?: string | null; port?: number } | string | null
  /** Force-disable editing even on loopback. */
  editingDisabled?: boolean
  onError?: (e: { code: string; message: string }) => void
}

interface Handled {
  status: number
  body: unknown
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const MAX_BODY = 256 * 1024

function send(res: ServerResponse, handled: Handled): void {
  const payload = JSON.stringify(handled.body)
  res.writeHead(handled.status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function err(code: string, message: string, detail?: string) {
  return { error: { code, message, ...(detail ? { detail } : {}) } }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new DbBrowserError('BODY_TOO_LARGE', 'Request body is too large')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new DbBrowserError('BAD_JSON', 'Request body is not valid JSON')
  }
}

/**
 * Map an error to a status.
 *
 * `EDITING_DISABLED` is a **403 with the gate's own message**, not a bare
 * refusal: the reason is the entire justification for the restriction, and a
 * UI that can only say "forbidden" makes it look like a bug.
 */
function mapError(e: unknown): Handled {
  if (e instanceof DbBrowserError) {
    const status =
      e.code === 'EDITING_DISABLED'
        ? 403
        : e.code === 'CONNECTION_NOT_FOUND'
          ? 404
          : e.code === 'INSTALL_IN_PROGRESS'
            ? 409
            : 400
    return { status, body: err(e.code, e.message, e.detail) }
  }
  // Never surface a raw error: a driver error carries the client config.
  return { status: 500, body: err('INTERNAL', 'The request failed') }
}

export function createConnectorsApi(options: ConnectorsApiOptions) {
  const { store, installer } = options

  const gate = (): EditGate =>
    evaluateEditGate(options.binding(), { disabled: options.editingDisabled ?? false })

  /**
   * Data sources opened from saved connections, cached per connection id.
   *
   * Opening is lazy — a connection whose server is down must not stop the
   * others being listed — and the cache is dropped when the connection is
   * edited or deleted, because a stale pool pointed at the old host is worse
   * than reconnecting.
   */
  const opened = new Map<string, Promise<DataSource>>()

  async function sourceFor(id: string): Promise<DataSource> {
    const cached = opened.get(id)
    if (cached) return cached
    const pending = openConnection(store.resolve(id))
    opened.set(id, pending)
    pending.catch(() => opened.delete(id))
    return pending
  }

  async function forget(id: string): Promise<void> {
    const existing = opened.get(id)
    opened.delete(id)
    if (!existing) return
    try {
      const source = (await existing) as DataSource & { close?: () => unknown }
      await source.close?.()
    } catch {
      /* the connection never opened, or is already gone */
    }
  }

  async function dispatch(
    req: IncomingMessage,
    path: string,
    method: string,
  ): Promise<Handled | null> {
    // ---- connectors -------------------------------------------------------

    if (path === '/api/connectors' && method === 'GET') {
      const g = gate()
      return {
        status: 200,
        body: {
          connectors: connectorStatuses(),
          // The UI needs the gate to decide whether to render the "Install"
          // and "New connection" buttons at all — a disabled button with an
          // explanation beats a button that 403s.
          editing: {
            enabled: g.editable,
            reason: g.reason,
            boundAddress: g.boundAddress,
            message: g.message,
          },
        },
      }
    }

    const install = /^\/api\/connectors\/([^/]+)\/install$/.exec(path)
    if (install && method === 'POST') {
      // The gate first, before anything else touches the request.
      assertEditable(gate())
      const job = installer.start(decodeURIComponent(install[1]))
      return { status: 202, body: { job } }
    }

    const jobStatus = /^\/api\/connectors\/install\/([^/]+)$/.exec(path)
    if (jobStatus && method === 'GET') {
      const job = installer.get(decodeURIComponent(jobStatus[1]))
      if (!job) return { status: 404, body: err('JOB_NOT_FOUND', 'No such install job') }
      return {
        status: 200,
        body: {
          // The shape the brief asked for, flat, plus the job's own detail.
          phase: job.phase,
          percent: job.percent,
          message: job.message,
          done: job.done,
          error: job.error,
          job,
        },
      }
    }

    // ---- connections ------------------------------------------------------

    if (path === '/api/connections' && method === 'GET') {
      const g = gate()
      return {
        status: 200,
        body: {
          connections: store.list(),
          editing: { enabled: g.editable, reason: g.reason, message: g.message },
        },
      }
    }

    if (path === '/api/connections' && method === 'POST') {
      assertEditable(gate())
      return { status: 201, body: { connection: store.create(await readJson(req)) } }
    }

    if (path === '/api/connections/test' && method === 'POST') {
      // Testing an unsaved form. Still gated: it is an outbound connection to
      // a host named in the request, which is the SSRF primitive itself.
      assertEditable(gate())
      const body = await readJson(req)
      return { status: 200, body: await testConnection(store.resolveTransient(body)) }
    }

    const byId = /^\/api\/connections\/([^/]+)$/.exec(path)
    if (byId) {
      const id = decodeURIComponent(byId[1])
      if (method === 'GET') {
        const found = store.get(id)
        if (!found) return { status: 404, body: err('CONNECTION_NOT_FOUND', 'No such connection') }
        return { status: 200, body: { connection: found } }
      }
      if (method === 'PUT' || method === 'PATCH') {
        assertEditable(gate())
        const updated = store.update(id, await readJson(req))
        await forget(id)
        return { status: 200, body: { connection: updated } }
      }
      if (method === 'DELETE') {
        assertEditable(gate())
        store.remove(id)
        await forget(id)
        return { status: 200, body: { ok: true } }
      }
    }

    const test = /^\/api\/connections\/([^/]+)\/test$/.exec(path)
    if (test && method === 'POST') {
      assertEditable(gate())
      const id = decodeURIComponent(test[1])
      const body = await readJson(req)
      // Merged, not transient: the browser was never given the password, so it
      // cannot send it back — the stored one fills the gap.
      const config = Object.keys(body).length ? store.resolveMerged(id, body) : store.resolve(id)
      return { status: 200, body: await testConnection(config) }
    }

    return null
  }

  /** Returns true when this handler took the request. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (!path.startsWith('/api/connectors') && !path.startsWith('/api/connections')) return false
    try {
      const handled = await dispatch(req, path, req.method ?? 'GET')
      if (!handled) {
        send(res, { status: 404, body: err('NOT_FOUND', 'Unknown route') })
        return true
      }
      send(res, handled)
    } catch (e) {
      const mapped = mapError(e)
      const body = mapped.body as { error: { code: string; message: string } }
      options.onError?.({ code: body.error.code, message: body.error.message })
      send(res, mapped)
    }
    return true
  }

  return {
    handle,
    gate,
    sourceFor,
    /** Descriptor lookup, so the demo server can label a mounted connection. */
    describe: (engine: string) => requireDescriptor(engine),
    async closeAll() {
      for (const id of [...opened.keys()]) await forget(id)
    },
  }
}
