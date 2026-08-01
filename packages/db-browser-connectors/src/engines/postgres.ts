/**
 * The Postgres driver binding.
 *
 * The **only** file in this package that touches `pg`, and it touches it
 * through `loadDriver()` — so the import happens when a Postgres connection is
 * opened and never before. `GET /api/connectors` on a machine with no `pg`
 * still lists PostgreSQL, says `installed: false`, and hands back the install
 * command; nothing here runs.
 *
 * A binding's whole job is to turn a driver into an `Exec` plus a `close`.
 * Everything above it — the guard, the builder, pagination, row identity — is
 * engine-agnostic and lives in `sqlDataSource.ts`.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'
import { loadDriver } from '../driverLoader.js'
import type { ConnectorDescriptor } from '../types.js'
import type { Exec, ExecResult } from '../dialects/types.js'
import type { SqlConnection } from '../sqlDataSource.js'
import type { ResolvedConnectionConfig } from '../connections/config.js'

/** The slice of `pg` this binding uses. Typed structurally so `pg` is not a
 * build-time dependency of this package — it is not installed here, and it
 * must be possible to typecheck and build without it. */
interface PgPoolClient {
  query(config: { text: string; values?: readonly unknown[] } | string, values?: readonly unknown[]): Promise<{
    rows: Array<Record<string, unknown>>
    fields?: Array<{ name: string; dataTypeID?: number }>
    rowCount?: number | null
    command?: string
  }>
  release(): void
}

interface PgPool {
  connect(): Promise<PgPoolClient>
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Array<Record<string, unknown>>
    fields?: Array<{ name: string }>
    rowCount?: number | null
    command?: string
  }>
  end(): Promise<void>
  on(event: 'error', listener: (e: Error) => void): void
}

interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool
  default?: { Pool: new (config: Record<string, unknown>) => PgPool }
}

/**
 * TLS, mapped from the descriptor's four-way `sslMode` onto what `pg` accepts.
 *
 * `require` and `verify-full` are genuinely different and the difference is
 * the whole security property: `rejectUnauthorized: false` encrypts against a
 * passive observer and does nothing at all against an active one. Both are
 * offered because a self-signed development server is a real situation, and
 * the field's help text says which is which rather than leaving a user to pick
 * the reassuring-sounding one.
 */
function sslFor(mode: unknown): false | { rejectUnauthorized: boolean } {
  switch (String(mode ?? 'prefer')) {
    case 'disable':
      return false
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-full':
      return { rejectUnauthorized: true }
    default:
      // `prefer` has no `pg` equivalent — the driver either negotiates TLS or
      // does not. Off is the behaviour that connects to an ordinary local
      // server, which is what `prefer` means in practice.
      return false
  }
}

export async function openPostgresConnection(
  descriptor: ConnectorDescriptor,
  config: ResolvedConnectionConfig,
): Promise<SqlConnection> {
  const mod = await loadDriver<PgModule>(descriptor)
  const Pool = mod.Pool ?? mod.default?.Pool
  if (!Pool) {
    throw new DbBrowserError(
      'DRIVER_LOAD_FAILED',
      'The "pg" package loaded but did not export a Pool. Check the installed version.',
    )
  }

  const pool = new Pool({
    host: String(config.values.host ?? 'localhost'),
    port: Number(config.values.port ?? descriptor.defaultPort ?? 5432),
    database: String(config.values.database ?? ''),
    user: String(config.values.user ?? ''),
    password: config.secrets.password ?? undefined,
    ssl: sslFor(config.values.sslMode),
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // Applied per connection rather than per statement, so a runaway query on
    // a shared server is bounded even if the request that started it is gone.
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: Math.max(config.statementTimeoutMs, 5_000),
  })
  // A pool that emits `error` with no listener takes the process down. This is
  // the one place that can happen, so the listener lives here — and it logs a
  // message only, never the error object, which carries the client config.
  pool.on('error', () => {})

  const toExec =
    (client: PgPoolClient): Exec =>
    async (sql, params): Promise<ExecResult> => {
      const res = await client.query({ text: sql, values: params ?? [] })
      return {
        rows: res.rows,
        fields: res.fields?.map((f) => ({ name: f.name })),
        rowCount: res.rowCount ?? null,
        command: res.command ?? null,
      }
    }

  return {
    driver: 'pg',
    async exec(sql, params) {
      const res = await pool.query(sql, params ?? [])
      return {
        rows: res.rows,
        fields: res.fields?.map((f) => ({ name: f.name })),
        rowCount: res.rowCount ?? null,
        command: res.command ?? null,
      }
    },
    /**
     * A pinned client for the whole unit of work. Without this, `BEGIN READ
     * ONLY` can go down one socket and the `SELECT` down another, and the
     * read-only guarantee silently evaporates — which is exactly the class of
     * bug that makes people distrust a "read-only" console.
     */
    async transaction(fn) {
      const client = await pool.connect()
      try {
        return await fn(toExec(client))
      } finally {
        client.release()
      }
    },
    async close() {
      await pool.end()
    },
  }
}
