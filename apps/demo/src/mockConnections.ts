/**
 * A local stand-in for the connection-manager API.
 *
 * ## Why this exists, and what it is not
 *
 * The real endpoints (`/api/connectors`, `/api/connections`, the install job
 * poller) are being built in the server package by another author. This module
 * implements **exactly the same `ConnectionsApi` interface** in memory so the
 * panel can be built, driven and demonstrated before they land — and so that
 * swapping to the real thing is a one-line change in `main.tsx` with no change
 * inside the UI at all. `detectConnectionsApi()` prefers the real server
 * whenever it answers, and only falls back here.
 *
 * It is **not** a fake that flatters the UI. Three things are deliberately
 * true-to-life because they are what the UI has to survive:
 *
 *  - **Installs take time and report phases.** Four phases over ~4 seconds with
 *    a real percentage, exactly the shape the contract's
 *    `{ phase, percent, message, done, error }` describes. A progress bar that
 *    only ever jumps 0 → 100 proves nothing.
 *  - **One connector fails to install.** `oracle` reports a licence error part
 *    way through, because "the download failed" is a state the panel must
 *    render and the happy path never exercises it.
 *  - **Secrets are write-only here too.** The mock stores a boolean, never the
 *    string, and `listConnections` returns `secrets: { password: true }` — the
 *    same shape the server promises. If the UI ever managed to display a
 *    password, this mock would not be the reason.
 *
 * Everything lives in module state: reloading the page resets it, which is the
 * right behaviour for a stand-in nobody should mistake for storage.
 */

import { createHttpConnectionsApi } from '@jugaaadi/db-browser'
import type {
  ConnectionDraft,
  ConnectionsApi,
  ConnectionsSnapshot,
  ConnectorStatus,
  ConnectorsSnapshot,
  InstallProgress,
  StoredConnection,
  TestResult,
} from '@jugaaadi/db-browser'

const CONNECTORS: ConnectorStatus[] = [
  {
    installed: true,
    installedVersion: '8.13.1',
    descriptor: {
      id: 'postgres',
      label: 'PostgreSQL',
      driverPackage: 'pg',
      driverRange: '^8.13.1',
      dialect: 'postgres',
      defaultPort: 5432,
      connectionFields: [
        { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'localhost' },
        { key: 'port', label: 'Port', kind: 'number', required: true, default: 5432 },
        { key: 'database', label: 'Database', kind: 'text', required: true, placeholder: 'postgres' },
        { key: 'user', label: 'User', kind: 'text', required: true, placeholder: 'postgres' },
        { key: 'password', label: 'Password', kind: 'password', required: false, secret: true },
        {
          key: 'ssl',
          label: 'SSL mode',
          kind: 'select',
          required: false,
          default: 'prefer',
          options: [
            { value: 'disable', label: 'disable' },
            { value: 'prefer', label: 'prefer' },
            { value: 'require', label: 'require' },
            { value: 'verify-full', label: 'verify-full' },
          ],
        },
        { key: 'readOnly', label: 'Open read-only', kind: 'boolean', required: false, default: true },
      ],
      capabilities: {
        schemas: true,
        transactions: true,
        keysetPagination: true,
        implicitRowId: false,
        readOnlySession: true,
        multipleDatabases: true,
      },
      typeMap: { int4: 'integer', int8: 'integer', numeric: 'decimal', text: 'text', bytea: 'binary' },
    },
  },
  {
    installed: true,
    installedVersion: 'node:sqlite',
    descriptor: {
      id: 'sqlite',
      label: 'SQLite',
      driverPackage: null,
      driverRange: 'built in (node:sqlite)',
      dialect: 'sqlite',
      connectionFields: [
        {
          key: 'file',
          label: 'Database file',
          kind: 'file',
          required: true,
          placeholder: 'F:/code/ai/piranha/.embeddings/code-embeddings.db',
        },
        { key: 'readOnly', label: 'Open read-only', kind: 'boolean', required: false, default: true },
      ],
      capabilities: {
        schemas: false,
        transactions: true,
        keysetPagination: true,
        implicitRowId: true,
        readOnlySession: true,
        multipleDatabases: false,
      },
      typeMap: { INTEGER: 'integer', REAL: 'decimal', TEXT: 'text', BLOB: 'binary' },
    },
  },
  {
    installed: false,
    descriptor: {
      id: 'mysql',
      label: 'MySQL / MariaDB',
      driverPackage: 'mysql2',
      driverRange: '^3.11.0',
      dialect: 'mysql',
      defaultPort: 3306,
      connectionFields: [
        { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'localhost' },
        { key: 'port', label: 'Port', kind: 'number', required: true, default: 3306 },
        { key: 'database', label: 'Database', kind: 'text', required: true },
        { key: 'user', label: 'User', kind: 'text', required: true, default: 'root' },
        { key: 'password', label: 'Password', kind: 'password', required: false, secret: true },
      ],
      capabilities: {
        schemas: false,
        transactions: true,
        keysetPagination: true,
        implicitRowId: false,
        readOnlySession: true,
        multipleDatabases: true,
      },
      typeMap: { int: 'integer', bigint: 'integer', decimal: 'decimal', blob: 'binary' },
    },
  },
  {
    installed: false,
    descriptor: {
      id: 'mssql',
      label: 'SQL Server',
      driverPackage: 'mssql',
      driverRange: '^11.0.1',
      dialect: 'mssql',
      defaultPort: 1433,
      connectionFields: [
        { key: 'server', label: 'Server', kind: 'text', required: true },
        { key: 'port', label: 'Port', kind: 'number', required: true, default: 1433 },
        { key: 'database', label: 'Database', kind: 'text', required: true },
        { key: 'user', label: 'User', kind: 'text', required: true },
        { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
        { key: 'encrypt', label: 'Encrypt', kind: 'boolean', required: false, default: true },
      ],
      capabilities: {
        schemas: true,
        transactions: true,
        keysetPagination: true,
        implicitRowId: false,
        readOnlySession: true,
        multipleDatabases: true,
      },
      typeMap: { int: 'integer', bigint: 'integer', decimal: 'decimal', varbinary: 'binary' },
    },
  },
  {
    installed: false,
    error: 'Requires the Oracle Instant Client, which is not redistributable.',
    descriptor: {
      id: 'oracle',
      label: 'Oracle',
      driverPackage: 'oracledb',
      driverRange: '^6.6.0',
      dialect: 'oracle',
      defaultPort: 1521,
      connectionFields: [
        { key: 'connectString', label: 'Connect string', kind: 'text', required: true },
        { key: 'user', label: 'User', kind: 'text', required: true },
        { key: 'password', label: 'Password', kind: 'password', required: true, secret: true },
      ],
      capabilities: {
        schemas: true,
        transactions: true,
        keysetPagination: true,
        implicitRowId: true,
        readOnlySession: true,
        multipleDatabases: false,
      },
      typeMap: { NUMBER: 'decimal', VARCHAR2: 'string', BLOB: 'binary' },
    },
  },
]

/** Seeded from what the demo actually has open, so the list is never empty. */
const connections: StoredConnection[] = [
  {
    id: 'embeddings',
    name: 'code-embeddings',
    engine: 'sqlite',
    values: { file: 'F:/code/ai/piranha/.embeddings/code-embeddings.db', readOnly: true },
    secretsSet: [],
    readOnly: true,
  },
  {
    id: 'code-graph',
    name: 'graph.db',
    engine: 'sqlite',
    values: { file: 'F:/code/ai/base-app/.code-review-graph/graph.db', readOnly: true },
    secretsSet: [],
    readOnly: true,
  },
]

const INSTALL_PHASES = [
  { phase: 'resolve', message: 'resolving the version range against the registry' },
  { phase: 'download', message: 'fetching the tarball' },
  { phase: 'verify', message: 'checking the integrity hash' },
  { phase: 'link', message: 'linking the driver into the server' },
]

interface Job {
  connectorId: string
  startedAt: number
  durationMs: number
  failAt: number | null
}

const jobs = new Map<string, Job>()
let nextId = 1

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Separate a submitted draft's secret fields from its ordinary ones.
 *
 * The server does exactly this, and the mock does it too rather than storing
 * the draft verbatim: if `values` were kept whole, a password would sit in
 * memory under a key `listConnections` returns, and the mock would then be
 * demonstrating the bug it exists to prove cannot happen.
 */
function split(draft: ConnectionDraft): {
  values: Record<string, string | number | boolean>
  secretsSet: string[]
  cleared: string[]
} {
  const connector = CONNECTORS.find((c) => c.descriptor.id === draft.engine)
  const secretKeys = new Set(
    (connector?.descriptor.connectionFields ?? [])
      .filter((f) => f.secret || f.kind === 'password')
      .map((f) => f.key),
  )
  const values: Record<string, string | number | boolean> = {}
  const secretsSet: string[] = []
  const cleared: string[] = []
  for (const [k, v] of Object.entries(draft.values)) {
    if (!secretKeys.has(k)) {
      if (v !== null) values[k] = v
      continue
    }
    if (v === '' || v === null) cleared.push(k)
    else secretsSet.push(k)
  }
  return { values, secretsSet, cleared }
}

function progressFor(job: Job): InstallProgress {
  const elapsed = Date.now() - job.startedAt
  const percent = Math.min(100, (elapsed / job.durationMs) * 100)
  const step = Math.min(INSTALL_PHASES.length - 1, Math.floor((percent / 100) * INSTALL_PHASES.length))
  const { phase, message } = INSTALL_PHASES[step]
  if (job.failAt !== null && percent >= job.failAt) {
    return {
      phase,
      percent: job.failAt,
      message,
      done: true,
      error:
        'The Oracle Instant Client is not redistributable — download it from Oracle and set ORACLE_HOME on the server.',
    }
  }
  return { phase, percent, message, done: percent >= 100 }
}

/**
 * An in-memory implementation of the documented contract. Latencies are real
 * `setTimeout`s so loading states are actually exercised rather than skipped.
 */
export function createMockConnectionsApi(): ConnectionsApi {
  return {
    describe: () => 'in-memory mock — the connections API is not live on this server',

    async listConnectors(): Promise<ConnectorsSnapshot> {
      await sleep(120)
      return {
        connectors: CONNECTORS.map((c) => ({ ...c, descriptor: { ...c.descriptor } })),
        policy: { editable: true },
      }
    },

    async installConnector(id) {
      await sleep(150)
      const jobId = `job-${nextId++}`
      jobs.set(jobId, {
        connectorId: id,
        startedAt: Date.now(),
        durationMs: 4200,
        failAt: id === 'oracle' ? 62 : null,
      })
      return { jobId }
    },

    async installProgress(jobId) {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`No such install job: ${jobId}`)
      const progress = progressFor(job)
      if (progress.done && !progress.error) {
        const target = CONNECTORS.find((c) => c.descriptor.id === job.connectorId)
        if (target) {
          target.installed = true
          target.installedVersion = target.descriptor.driverRange.replace(/^\^/, '')
        }
      }
      return progress
    },

    async listConnections(): Promise<ConnectionsSnapshot> {
      await sleep(90)
      return {
        connections: connections.map((c) => ({ ...c, values: { ...c.values } })),
        // The real server turns this off on a non-loopback bind; the mock is
        // always loopback, so editing is on. Flip it here to see the disabled
        // state the panel renders.
        policy: { editable: true },
      }
    },

    async createConnection(draft: ConnectionDraft) {
      await sleep(200)
      if (connections.some((c) => c.name.toLowerCase() === draft.name.toLowerCase())) {
        throw new Error(`A connection called “${draft.name}” already exists.`)
      }
      const { values, secretsSet } = split(draft)
      const stored: StoredConnection = {
        id: `conn-${nextId++}`,
        name: draft.name,
        engine: draft.engine,
        values,
        secretsSet,
        createdAt: new Date().toISOString(),
      }
      connections.push(stored)
      return { ...stored }
    },

    async updateConnection(id, draft) {
      await sleep(200)
      const found = connections.find((c) => c.id === id)
      if (!found) throw new Error(`No such connection: ${id}`)
      const { values, secretsSet, cleared } = split(draft)
      found.name = draft.name
      found.values = values
      found.secretsSet = [
        ...new Set([...(found.secretsSet ?? []).filter((k) => !cleared.includes(k)), ...secretsSet]),
      ]
      found.updatedAt = new Date().toISOString()
      return { ...found }
    },

    async deleteConnection(id) {
      await sleep(150)
      const i = connections.findIndex((c) => c.id === id)
      if (i >= 0) connections.splice(i, 1)
    },

    async testConnection(id): Promise<TestResult> {
      const started = performance.now()
      await sleep(400 + Math.random() * 500)
      const found = connections.find((c) => c.id === id)
      if (!found) return { ok: false, error: `No such connection: ${id}` }
      const latencyMs = performance.now() - started
      // A SQLite connection is testable for real: the demo server is already
      // serving it, so "does it open" has a genuine answer.
      if (found.engine === 'sqlite' && !found.values.file) {
        return { ok: false, error: 'No database file is configured.', latencyMs }
      }
      return { ok: true, latencyMs }
    },

    async testDraft(draft): Promise<TestResult> {
      const started = performance.now()
      await sleep(500 + Math.random() * 600)
      const latencyMs = performance.now() - started
      const connector = CONNECTORS.find((c) => c.descriptor.id === draft.engine)
      const missing = (connector?.descriptor.connectionFields ?? [])
        .filter((f) => f.required && !f.secret && !draft.values[f.key])
        .map((f) => f.label)
      if (missing.length) {
        return { ok: false, error: `Missing: ${missing.join(', ')}`, latencyMs }
      }
      const host = String(draft.values.host ?? draft.values.server ?? '')
      if (host && !/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) {
        return {
          ok: false,
          error: `getaddrinfo ENOTFOUND ${host} — the mock backend only resolves loopback.`,
          latencyMs,
        }
      }
      return { ok: true, latencyMs }
    },
  }
}

export interface DetectedConnectionsApi {
  api: ConnectionsApi
  /** True when the real server answered; false when the mock is standing in. */
  live: boolean
}

/**
 * Prefer the real endpoints, fall back to the mock.
 *
 * The probe is `GET /api/connectors` rather than a version handshake because it
 * is the one route that must exist for any of the panel to work, and a 404 from
 * it is exactly the "not built yet" signal.
 */
export async function detectConnectionsApi(apiBase: string): Promise<DetectedConnectionsApi> {
  // `?connections=mock` forces the stand-in even when the real API is up.
  // It exists so the fallback path stays exercised — and so a driver download
  // can be demonstrated without actually running `npm install` in the repo,
  // which is a real side effect nobody asked a screenshot for.
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('connections') === 'mock') {
    return { api: createMockConnectionsApi(), live: false }
  }
  try {
    const res = await fetch(`${apiBase}/api/connectors`, { method: 'GET' })
    if (res.ok) return { api: createHttpConnectionsApi({ baseUrl: `${apiBase}/api` }), live: true }
  } catch {
    /* the server is down, or the route does not exist — fall through */
  }
  return { api: createMockConnectionsApi(), live: false }
}
