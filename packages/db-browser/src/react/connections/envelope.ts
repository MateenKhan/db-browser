/**
 * Reading the connection API's responses — **tolerantly, and out loud.**
 *
 * ## The bug this file exists to make impossible
 *
 * `GET /api/connectors` answers `{ "connectors": [ … ] }`. An earlier client
 * read it as `body.connectors ?? []`. That is tolerant of the envelope it knows
 * and *silently catastrophic* about every other one: a server that answered
 * `{ drivers: [ … ] }`, or `{ data: { connectors } }`, or a 200 carrying an
 * error object, produced an empty array, and the panel rendered
 * **"Drivers 0/0 — no driver is installed"** over a server with eight of them.
 * The user does not conclude "the client cannot parse this"; they conclude they
 * have no drivers, and go and install one they already had.
 *
 * A silent empty list that contradicts the server is worse than a loud failure.
 * So every parser here has exactly two outcomes:
 *
 *  - it **recognises** the shape — a bare array, or the documented envelope, or
 *    one of the alternate spellings listed below — and returns it; or
 *  - it **throws** a {@link ConnectionsEnvelopeError} naming the route, what was
 *    expected, and what actually arrived (type, and top-level keys). The panel
 *    renders that message in its error banner.
 *
 * There is no third outcome. `?? []` is not written anywhere in this file, and
 * an empty list is only ever returned because the server really sent one.
 *
 * ## What "tolerant" is allowed to mean
 *
 * Tolerance is for shapes that are genuinely in the wild, and each one is
 * spelled out rather than inferred:
 *
 * | route | accepted |
 * | :-- | :-- |
 * | `GET /connectors` | `[…]` · `{ connectors: […], editing? }` |
 * | `GET /connections` | `[…]` · `{ connections: […], editing? }` |
 * | `POST /connectors/:id/install` | `{ job: { id } }` · `{ jobId }` · `{ id }` |
 * | `GET /connectors/install/:job` | flat `{ phase, percent, done }` · `{ job: {…} }` |
 * | `POST /connections[/:id]` | `{ connection }` · a bare connection record |
 * | `POST …/test` | flat `{ ok, … }` · `{ result: {…} }` |
 *
 * Per-item tolerance is narrower still: a connector may arrive as
 * `{ descriptor, installed }` or as a flat descriptor with `installed` beside
 * its `id`, and a connection's write-only secret keys may arrive as
 * `secretsSet: ['password']` or as `secrets: { password: true }`. Anything else
 * is a shape nobody documented, and guessing at it is how the silent-empty bug
 * gets reintroduced.
 */

import type {
  ConnectorDescriptor,
  ConnectorStatus,
  InstallProgress,
  StoredConnection,
  TestResult,
} from './types.js'

/** The server's editing gate, in either of the shapes it may arrive in. */
export interface EditingGate {
  enabled?: boolean
  editable?: boolean
  reason?: string
  message?: string
}

/**
 * A response this client cannot read.
 *
 * It carries the route and a description of what arrived because the person who
 * has to act on it is looking at a UI, not at a network tab — "GET /connectors
 * answered an object with keys: drivers, editing" is a bug report; "no drivers"
 * is a wild goose chase.
 */
export class ConnectionsEnvelopeError extends Error {
  readonly route: string
  readonly expected: string
  readonly observed: string

  constructor(route: string, expected: string, body: unknown, detail?: string) {
    const observed = describeShape(body)
    super(
      `${route} answered a shape this client does not recognise. Expected ${expected}; got ${observed}.` +
        (detail ? ` ${detail}` : ''),
    )
    this.name = 'ConnectionsEnvelopeError'
    this.route = route
    this.expected = expected
    this.observed = observed
  }
}

/** A short, safe description of a value: its type and, for objects, its keys. */
export function describeShape(body: unknown): string {
  if (body === null) return 'null'
  if (body === undefined) return 'nothing'
  if (Array.isArray(body)) return `an array of ${body.length} item${body.length === 1 ? '' : 's'}`
  const type = typeof body
  if (type !== 'object') return `a ${type} (${JSON.stringify(body)?.slice(0, 60) ?? type})`
  const keys = Object.keys(body as Record<string, unknown>)
  if (!keys.length) return 'an empty object'
  const shown = keys.slice(0, 8).join(', ')
  return `an object with keys: ${shown}${keys.length > 8 ? `, … (${keys.length} total)` : ''}`
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The array a list route returned, from either the bare or the enveloped shape.
 *
 * The distinction that matters: a **missing** key is a shape this client does
 * not understand and throws, while a key present and holding an empty array is
 * a real, believable answer and is returned. `body.connectors ?? []` collapsed
 * those two into the same, wrong result.
 */
function requireList(body: unknown, key: string, route: string, expected: string): unknown[] {
  if (Array.isArray(body)) return body
  if (isRecord(body)) {
    const value = body[key]
    if (Array.isArray(value)) return value
    // A 200 that carries an error object is a real server behaviour and reads
    // far better relayed than reported as a parse failure.
    const error = body.error
    if (typeof error === 'string') throw new Error(`${route} answered an error: ${error}`)
    if (isRecord(error) && typeof error.message === 'string') {
      throw new Error(`${route} answered an error: ${error.message}`)
    }
    throw new ConnectionsEnvelopeError(
      route,
      expected,
      body,
      `No "${key}" array is present, so this client cannot tell an empty list from a shape it ` +
        'does not understand — and it will not guess.',
    )
  }
  throw new ConnectionsEnvelopeError(route, expected, body)
}

function readGate(body: unknown): EditingGate | undefined {
  if (!isRecord(body)) return undefined
  const editing = body.editing ?? body.policy
  return isRecord(editing) ? (editing as EditingGate) : undefined
}

// ---------------------------------------------------------------------------
// GET /connectors
// ---------------------------------------------------------------------------

/**
 * One connector's status, from either the nested or the flat spelling.
 *
 * `supported` defaults to **true** when the server does not send it: a server
 * that has no opinion is not saying "unusable", and defaulting the other way
 * would grey out every engine on an older server — the same class of failure as
 * rendering 0 of 8.
 */
function toConnectorStatus(item: unknown, index: number, route: string): ConnectorStatus {
  if (!isRecord(item)) {
    throw new ConnectionsEnvelopeError(route, 'each connector to be an object', item, `Item ${index}.`)
  }
  const nested = isRecord(item.descriptor) ? (item.descriptor as unknown as ConnectorDescriptor) : null
  const flat = typeof item.id === 'string' && Array.isArray(item.connectionFields)
  if (!nested && !flat) {
    throw new ConnectionsEnvelopeError(
      route,
      'each connector to carry a `descriptor` (or to be a descriptor itself)',
      item,
      `Item ${index} has neither.`,
    )
  }
  const descriptor = nested ?? (item as unknown as ConnectorDescriptor)
  if (typeof descriptor.id !== 'string' || !descriptor.id) {
    throw new ConnectionsEnvelopeError(route, 'every connector descriptor to have a string `id`', item, `Item ${index}.`)
  }
  const status: ConnectorStatus = {
    descriptor,
    installed: item.installed === true,
    supported: item.supported !== false,
  }
  if (typeof item.installedVersion === 'string') status.installedVersion = item.installedVersion
  if (typeof item.error === 'string') status.error = item.error
  if (typeof item.installCommand === 'string') status.installCommand = item.installCommand
  if (item.versionMismatch === true) status.versionMismatch = true
  return status
}

export interface ParsedConnectors {
  connectors: ConnectorStatus[]
  editing?: EditingGate
}

/** `GET /connectors` — the route whose misparse this whole file is about. */
export function parseConnectorsBody(body: unknown, route = 'GET /connectors'): ParsedConnectors {
  const list = requireList(body, 'connectors', route, 'an array of connectors, or `{ connectors: [ … ] }`')
  return {
    connectors: list.map((item, i) => toConnectorStatus(item, i, route)),
    editing: readGate(body),
  }
}

// ---------------------------------------------------------------------------
// GET /connections
// ---------------------------------------------------------------------------

function toStoredConnection(item: unknown, index: number, route: string): StoredConnection {
  if (!isRecord(item)) {
    throw new ConnectionsEnvelopeError(route, 'each connection to be an object', item, `Item ${index}.`)
  }
  const id = item.id
  if (typeof id !== 'string' || !id) {
    throw new ConnectionsEnvelopeError(route, 'every connection to have a string `id`', item, `Item ${index}.`)
  }
  const engine = typeof item.engine === 'string' ? item.engine : typeof item.connectorId === 'string' ? item.connectorId : null
  if (!engine) {
    throw new ConnectionsEnvelopeError(route, 'every connection to name its `engine`', item, `Item ${index}.`)
  }
  // Secret *keys* may arrive as a list or as a map of key → true. Never a value:
  // if a server ever sent one, this drops it on the floor by construction.
  const secretsSet = Array.isArray(item.secretsSet)
    ? item.secretsSet.filter((k): k is string => typeof k === 'string')
    : isRecord(item.secrets)
      ? Object.keys(item.secrets).filter((k) => (item.secrets as Record<string, unknown>)[k] === true)
      : undefined

  const connection: StoredConnection = {
    id,
    name: typeof item.name === 'string' ? item.name : id,
    engine,
    values: isRecord(item.values) ? (item.values as StoredConnection['values']) : {},
  }
  if (secretsSet) connection.secretsSet = secretsSet
  if (typeof item.readOnly === 'boolean') connection.readOnly = item.readOnly
  if (typeof item.createdAt === 'string') connection.createdAt = item.createdAt
  if (typeof item.updatedAt === 'string') connection.updatedAt = item.updatedAt
  return connection
}

export interface ParsedConnections {
  connections: StoredConnection[]
  editing?: EditingGate
}

/** `GET /connections` — same envelope class, same failure mode, same rule. */
export function parseConnectionsBody(body: unknown, route = 'GET /connections'): ParsedConnections {
  const list = requireList(body, 'connections', route, 'an array of connections, or `{ connections: [ … ] }`')
  return {
    connections: list.map((item, i) => toStoredConnection(item, i, route)),
    editing: readGate(body),
  }
}

/** One connection, as `POST` / `PUT /connections` return it. */
export function parseConnectionBody(body: unknown, route: string): StoredConnection {
  if (isRecord(body) && isRecord(body.connection)) return toStoredConnection(body.connection, 0, route)
  if (isRecord(body) && typeof body.id === 'string') return toStoredConnection(body, 0, route)
  throw new ConnectionsEnvelopeError(body === undefined ? route : route, 'a connection record, or `{ connection: { … } }`', body)
}

// ---------------------------------------------------------------------------
// The install job
// ---------------------------------------------------------------------------

/**
 * `POST /connectors/:id/install` → the job id.
 *
 * The old client read `body.jobId ?? body.job?.id` and, finding neither, said
 * "the server accepted the install but returned no job id" — which describes
 * the server rather than the client that could not read it. This says which it
 * is.
 */
export function parseInstallJobBody(body: unknown, route: string): { jobId: string } {
  if (isRecord(body)) {
    const candidates = [body.jobId, isRecord(body.job) ? body.job.id : undefined, body.id]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate) return { jobId: candidate }
    }
  }
  throw new ConnectionsEnvelopeError(route, '`{ job: { id } }`, `{ jobId }` or `{ id }`', body)
}

/**
 * `GET /connectors/install/:jobId` → the progress tick.
 *
 * A tick is only believable if it carries at least one of the three things a
 * progress bar is made of. An object with none of them is not a slow install,
 * it is an unreadable response — and a bar that sits at 0 % forever is the
 * spinner-over-a-hang this UI exists to avoid.
 */
export function parseInstallProgressBody(body: unknown, route: string): InstallProgress {
  const source = isRecord(body) && isRecord(body.job) && body.phase === undefined ? body.job : body
  if (!isRecord(source)) {
    throw new ConnectionsEnvelopeError(route, '`{ phase, percent, done, message?, error? }`', body)
  }
  const hasPhase = typeof source.phase === 'string'
  const hasPercent = typeof source.percent === 'number' && Number.isFinite(source.percent)
  const hasDone = typeof source.done === 'boolean'
  const hasError = typeof source.error === 'string'
  if (!hasPhase && !hasPercent && !hasDone && !hasError) {
    throw new ConnectionsEnvelopeError(
      route,
      '`{ phase, percent, done, message?, error? }`',
      body,
      'None of `phase`, `percent`, `done` or `error` is present, so there is no progress to report.',
    )
  }
  const percent = hasPercent ? Math.max(0, Math.min(100, source.percent as number)) : 0
  const progress: InstallProgress = {
    phase: hasPhase ? (source.phase as string) : hasError ? 'failed' : 'working',
    percent,
    done: hasDone ? (source.done as boolean) : percent >= 100 || hasError,
  }
  if (typeof source.message === 'string') progress.message = source.message
  if (hasError) progress.error = source.error as string
  return progress
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

/**
 * A test result. `ok` is the one field the UI branches on, so its absence is
 * fatal rather than falsy: rendering "Connection failed" because a field was
 * spelled differently would be the same lie in a smaller place.
 */
export function parseTestResultBody(body: unknown, route: string): TestResult {
  const source = isRecord(body) && isRecord(body.result) ? body.result : body
  if (!isRecord(source)) {
    throw new ConnectionsEnvelopeError(route, '`{ ok, message?, latencyMs?, error? }`', body)
  }
  const hasOk = typeof source.ok === 'boolean'
  const hasError = typeof source.error === 'string'
  if (!hasOk && !hasError) {
    throw new ConnectionsEnvelopeError(
      route,
      '`{ ok, message?, latencyMs?, error? }`',
      body,
      'Neither `ok` nor `error` is present, so whether the connection opened is unknown.',
    )
  }
  const result: TestResult = { ok: hasOk ? (source.ok as boolean) : false }
  if (hasError) result.error = source.error as string
  if (typeof source.message === 'string') result.message = source.message
  if (typeof source.latencyMs === 'number') result.latencyMs = source.latencyMs
  if (typeof source.durationMs === 'number') result.durationMs = source.durationMs
  if (typeof source.code === 'string') result.code = source.code
  if (typeof source.tableCount === 'number') result.tableCount = source.tableCount
  return result
}
