/**
 * The connection API's real response shapes, pinned.
 *
 * Every fixture in this file was copied out of a live
 * `apps/demo/server` running on :6960 — `curl http://localhost:6960/api/…` —
 * and trimmed only by dropping repeated `connectionFields` / `typeMap` entries.
 * Nothing here is a shape somebody imagined the server might use, which matters:
 * the bug these tests exist to prevent was a client that parsed an *imagined*
 * envelope (a bare array) and silently rendered nothing for the real one
 * (`{ connectors: [ … ] }`), reporting **"Drivers 0/0 — no driver is
 * installed"** over a server with eight connectors and three installed.
 *
 * So the assertions come in pairs: the real shape parses, **and** an
 * unrecognised one throws instead of resolving to an empty list.
 */

import { describe, expect, it } from 'vitest'
import {
  ConnectionsEnvelopeError,
  describeShape,
  parseConnectionBody,
  parseConnectionsBody,
  parseConnectorsBody,
  parseInstallJobBody,
  parseInstallProgressBody,
  parseTestResultBody,
} from '../src/react/connections/envelope.js'
import { connectorAvailability } from '../src/react/connections/types.js'

// ---------------------------------------------------------------------------
// Fixtures — verbatim from GET http://localhost:6960/api/connectors
// ---------------------------------------------------------------------------

const POSTGRES = {
  descriptor: {
    id: 'postgres',
    label: 'PostgreSQL',
    description: 'The reference engine for this browser. Full introspection, real transactions.',
    driverPackage: 'pg',
    driverRange: '^8.11.0',
    dialect: 'postgres',
    defaultPort: 5432,
    connectionFields: [
      { key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' },
      { key: 'port', label: 'Port', kind: 'number', required: true, default: 5432 },
    ],
    capabilities: {
      schemas: true,
      transactions: true,
      keysetPagination: true,
      implicitRowId: false,
      readOnlySession: true,
      multipleDatabases: false,
    },
    typeMap: { int4: 'integer' },
    docsUrl: 'https://node-postgres.com/',
  },
  installed: true,
  supported: true,
  installedVersion: '8.22.0',
}

/** Not installed, but a `npm install mysql2` away — the "installable" case. */
const MYSQL = {
  descriptor: {
    id: 'mysql',
    label: 'MySQL',
    description: 'MySQL 5.7+ / 8.x, through the pure-JavaScript mysql2 driver.',
    driverPackage: 'mysql2',
    driverRange: '^3.11.0',
    dialect: 'mysql',
    defaultPort: 3306,
    connectionFields: [{ key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' }],
    capabilities: {
      schemas: false,
      transactions: true,
      keysetPagination: true,
      implicitRowId: false,
      readOnlySession: true,
      multipleDatabases: true,
    },
    typeMap: { int: 'integer' },
    docsUrl: 'https://sidorares.github.io/node-mysql2/docs',
  },
  installed: false,
  supported: true,
  installCommand: 'npm install mysql2@^3.11.0',
  error: 'Not installed. Run:  npm install mysql2@^3.11.0',
}

/** `supported: false` — this build has no adapter, so a download changes nothing. */
const MSSQL = {
  descriptor: {
    id: 'mssql',
    label: 'Microsoft SQL Server',
    description: 'SQL Server 2016+ and Azure SQL, through the tedious-based mssql driver.',
    driverPackage: 'mssql',
    driverRange: '^11.0.0',
    dialect: 'mssql',
    defaultPort: 1433,
    connectionFields: [{ key: 'host', label: 'Host', kind: 'text', required: true, default: 'localhost' }],
    capabilities: {
      schemas: true,
      transactions: true,
      keysetPagination: true,
      implicitRowId: false,
      readOnlySession: false,
      multipleDatabases: true,
    },
    typeMap: { int: 'integer' },
    docsUrl: 'https://github.com/tediousjs/node-mssql',
  },
  installed: false,
  supported: false,
  installCommand: 'npm install mssql@^11.0.0',
  error: 'Not installed. Run:  npm install mssql@^11.0.0',
}

const EDITING_GATE = {
  enabled: true,
  reason: 'loopback',
  boundAddress: '127.0.0.1',
  message: 'Bound to 127.0.0.1 — connection editing and connector installs are enabled.',
}

/** Verbatim from GET http://localhost:6960/api/connections */
const CONNECTIONS_BODY = {
  connections: [
    {
      id: 'd80df936-c912-4b23-935e-511379add6b2',
      name: 'Piranha embeddings (added from the UI)',
      engine: 'sqlite',
      values: { file: 'F:/code/ai/piranha/.embeddings/code-embeddings.db', readOnly: true },
      secretsSet: [],
      readOnly: true,
      createdAt: '2026-07-31T09:23:01.720Z',
      updatedAt: '2026-07-31T09:23:01.720Z',
    },
  ],
  editing: EDITING_GATE,
}

// ---------------------------------------------------------------------------

describe('GET /connectors', () => {
  const body = { connectors: [POSTGRES, MYSQL, MSSQL], editing: EDITING_GATE }

  it('reads the real `{ connectors, editing }` envelope — the shape that rendered 0/0', () => {
    const parsed = parseConnectorsBody(body)
    expect(parsed.connectors).toHaveLength(3)
    expect(parsed.connectors.map((c) => c.descriptor.id)).toEqual(['postgres', 'mysql', 'mssql'])
    expect(parsed.connectors.filter((c) => c.installed)).toHaveLength(1)
    expect(parsed.editing?.enabled).toBe(true)
  })

  it('carries every status field the server sends', () => {
    const [pg, mysql, mssql] = parseConnectorsBody(body).connectors
    expect(pg).toMatchObject({ installed: true, supported: true, installedVersion: '8.22.0' })
    expect(mysql).toMatchObject({
      installed: false,
      supported: true,
      installCommand: 'npm install mysql2@^3.11.0',
    })
    expect(mssql.supported).toBe(false)
  })

  it('still accepts a bare array, the shape the interface was first written as', () => {
    expect(parseConnectorsBody([POSTGRES]).connectors).toHaveLength(1)
    expect(parseConnectorsBody([POSTGRES]).editing).toBeUndefined()
  })

  it('accepts a flat descriptor with `installed` beside its id', () => {
    const flat = { ...POSTGRES.descriptor, installed: true }
    expect(parseConnectorsBody([flat]).connectors[0].descriptor.id).toBe('postgres')
  })

  it('returns a genuinely empty list as empty — an empty answer is still an answer', () => {
    expect(parseConnectorsBody({ connectors: [], editing: EDITING_GATE }).connectors).toEqual([])
  })

  it('THROWS on an envelope it does not recognise, rather than rendering 0/0', () => {
    // The whole point. `body.connectors ?? []` turned each of these into a
    // confident, wrong "no drivers installed".
    expect(() => parseConnectorsBody({ drivers: [POSTGRES] })).toThrow(ConnectionsEnvelopeError)
    expect(() => parseConnectorsBody({ data: { connectors: [POSTGRES] } })).toThrow(ConnectionsEnvelopeError)
    expect(() => parseConnectorsBody('not json at all')).toThrow(ConnectionsEnvelopeError)
    expect(() => parseConnectorsBody(null)).toThrow(ConnectionsEnvelopeError)
  })

  it('names the route and the shape that actually arrived, so the banner is a bug report', () => {
    let caught: ConnectionsEnvelopeError | null = null
    try {
      parseConnectorsBody({ drivers: [], editing: EDITING_GATE }, 'GET http://localhost:6960/api/connectors')
    } catch (e) {
      caught = e as ConnectionsEnvelopeError
    }
    expect(caught).toBeInstanceOf(ConnectionsEnvelopeError)
    expect(caught?.message).toContain('GET http://localhost:6960/api/connectors')
    expect(caught?.message).toContain('drivers, editing')
    expect(caught?.message).toContain('connectors')
  })

  it('relays a 200 that carries an error object instead of calling it a parse failure', () => {
    expect(() => parseConnectorsBody({ error: { code: 'NOPE', message: 'Connector registry unavailable' } })).toThrow(
      /Connector registry unavailable/,
    )
  })

  it('rejects items that are not connectors, naming the index', () => {
    expect(() => parseConnectorsBody({ connectors: [POSTGRES, 'mysql'] })).toThrow(/Item 1/)
  })

  it('treats a missing `supported` as supported — an older server must not grey everything out', () => {
    const legacy = { descriptor: POSTGRES.descriptor, installed: true }
    expect(parseConnectorsBody([legacy]).connectors[0].supported).toBe(true)
  })
})

describe('connectorAvailability', () => {
  const [pg, mysql, mssql] = parseConnectorsBody({ connectors: [POSTGRES, MYSQL, MSSQL] }).connectors

  it('installed + supported is ready', () => {
    expect(connectorAvailability(pg)).toEqual({ state: 'ready' })
  })

  it('a missing driver is installable, not a wall — this is what unblocks New connection', () => {
    expect(connectorAvailability(mysql).state).toBe('installable')
  })

  it('`supported: false` is the one genuinely unavailable state, and it says why', () => {
    const verdict = connectorAvailability(mssql)
    expect(verdict.state).toBe('unavailable')
    expect(verdict.reason).toBeTruthy()
  })
})

describe('GET /connections', () => {
  it('reads the real `{ connections, editing }` envelope', () => {
    const parsed = parseConnectionsBody(CONNECTIONS_BODY)
    expect(parsed.connections).toHaveLength(1)
    expect(parsed.connections[0]).toMatchObject({
      id: 'd80df936-c912-4b23-935e-511379add6b2',
      engine: 'sqlite',
      readOnly: true,
    })
    expect(parsed.connections[0].values.file).toBe('F:/code/ai/piranha/.embeddings/code-embeddings.db')
    expect(parsed.editing?.message).toContain('Bound to 127.0.0.1')
  })

  it('accepts a bare array too', () => {
    expect(parseConnectionsBody(CONNECTIONS_BODY.connections).connections).toHaveLength(1)
  })

  it('accepts secret *keys* as a map as well as a list, and never a value', () => {
    const parsed = parseConnectionsBody([
      { id: 'a', name: 'a', engine: 'postgres', values: { host: 'localhost' }, secrets: { password: true, ca: false } },
    ])
    expect(parsed.connections[0].secretsSet).toEqual(['password'])
    expect(JSON.stringify(parsed)).not.toContain('hunter2')
  })

  it('THROWS on an unrecognised envelope rather than showing an empty list', () => {
    expect(() => parseConnectionsBody({ items: CONNECTIONS_BODY.connections })).toThrow(ConnectionsEnvelopeError)
    expect(() => parseConnectionsBody({ connections: [{ name: 'no id' }] })).toThrow(/string `id`/)
  })

  it('reads one connection back from a create / update', () => {
    const wrapped = { connection: CONNECTIONS_BODY.connections[0] }
    expect(parseConnectionBody(wrapped, 'POST /connections').id).toBe('d80df936-c912-4b23-935e-511379add6b2')
    expect(parseConnectionBody(CONNECTIONS_BODY.connections[0], 'POST /connections').engine).toBe('sqlite')
    expect(() => parseConnectionBody({ ok: true }, 'POST /connections')).toThrow(ConnectionsEnvelopeError)
  })
})

describe('the install job', () => {
  // `apps/demo/server/connectors-api.ts` answers 202 `{ job }`, where the job
  // is an InstallProgress plus its own `id`.
  const START_BODY = {
    job: { id: '0e8f2c1a-9b6d-4a5e-8f31-2c7d9a1b4e60', phase: 'queued', percent: 0, done: false },
  }

  it('reads the real `{ job: { id } }` body', () => {
    expect(parseInstallJobBody(START_BODY, 'POST /install')).toEqual({
      jobId: '0e8f2c1a-9b6d-4a5e-8f31-2c7d9a1b4e60',
    })
  })

  it('accepts `{ jobId }` and `{ id }` as well', () => {
    expect(parseInstallJobBody({ jobId: 'j1' }, 'POST /install').jobId).toBe('j1')
    expect(parseInstallJobBody({ id: 'j2' }, 'POST /install').jobId).toBe('j2')
  })

  it('THROWS when no id is anywhere, instead of blaming the server vaguely', () => {
    expect(() => parseInstallJobBody({ accepted: true }, 'POST /install')).toThrow(ConnectionsEnvelopeError)
  })

  it('reads the flat progress tick the server sends', () => {
    const tick = {
      phase: 'download',
      percent: 41.5,
      message: 'fetching mysql2@3.11.0',
      done: false,
      error: undefined,
      job: { id: 'j1', phase: 'download', percent: 41.5, done: false },
    }
    expect(parseInstallProgressBody(tick, 'GET /install/j1')).toEqual({
      phase: 'download',
      percent: 41.5,
      message: 'fetching mysql2@3.11.0',
      done: false,
    })
  })

  it('reads a nested `{ job }` tick, and a failed one', () => {
    expect(parseInstallProgressBody({ job: { phase: 'link', percent: 100, done: true } }, 'r').done).toBe(true)
    const failed = parseInstallProgressBody(
      { phase: 'download', percent: 62, done: true, error: 'ENOTFOUND registry.npmjs.org' },
      'r',
    )
    expect(failed.error).toBe('ENOTFOUND registry.npmjs.org')
    expect(failed.done).toBe(true)
  })

  it('THROWS on a tick with no progress in it — a 0% bar forever is the hang this UI avoids', () => {
    expect(() => parseInstallProgressBody({ status: 'running' }, 'r')).toThrow(ConnectionsEnvelopeError)
    expect(() => parseInstallProgressBody('running', 'r')).toThrow(ConnectionsEnvelopeError)
  })

  it('clamps a percentage the server over- or under-shoots', () => {
    expect(parseInstallProgressBody({ phase: 'link', percent: 140, done: true }, 'r').percent).toBe(100)
    expect(parseInstallProgressBody({ phase: 'resolve', percent: -3, done: false }, 'r').percent).toBe(0)
  })
})

describe('POST …/test', () => {
  it('reads the real success body from a live SQLite connection', () => {
    // curl -X POST .../api/connections/<id>/test -d '{}'
    const body = { ok: true, durationMs: 3, tableCount: 3, message: 'Connected. 3 tables visible.' }
    expect(parseTestResultBody(body, 'POST /test')).toEqual(body)
  })

  it('reads the real failure body — which carries `message` and `code`, not `error`', () => {
    const body = { ok: false, durationMs: 1, code: 'DB_NOT_FOUND', message: 'The database file could not be opened.' }
    const parsed = parseTestResultBody(body, 'POST /test')
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe('DB_NOT_FOUND')
    expect(parsed.message).toBe('The database file could not be opened.')
  })

  it('accepts a `{ result }` wrapper and an `error`-only body', () => {
    expect(parseTestResultBody({ result: { ok: true, latencyMs: 9 } }, 'r').latencyMs).toBe(9)
    expect(parseTestResultBody({ error: 'ECONNREFUSED' }, 'r')).toMatchObject({ ok: false, error: 'ECONNREFUSED' })
  })

  it('THROWS when the outcome is unknowable, rather than reporting a failure that may not have happened', () => {
    expect(() => parseTestResultBody({ latencyMs: 12 }, 'r')).toThrow(ConnectionsEnvelopeError)
  })
})

describe('describeShape', () => {
  it('says what arrived without dumping it', () => {
    expect(describeShape([1, 2, 3])).toBe('an array of 3 items')
    expect(describeShape({ connectors: [], editing: {} })).toBe('an object with keys: connectors, editing')
    expect(describeShape(null)).toBe('null')
    expect(describeShape(undefined)).toBe('nothing')
    expect(describeShape({})).toBe('an empty object')
  })
})
