/**
 * The Postgres `DataSource`.
 *
 * ## What this file is now
 *
 * A **thin adapter over the shared, metadata-driven base**. Everything that
 * used to live here — the transaction wrapper, the introspection cache, the
 * pagination call, the CRUD, the guard call, the binary decoration — moved to
 * `@jugaaadi/db-browser-connectors`'s `createSqlDataSource`, parameterised by
 * the Postgres `ConnectorDescriptor` (data) and the Postgres `Dialect`
 * (quoting, `$n` placeholders, `LIMIT/OFFSET`, the catalog queries). MySQL now
 * runs through the same base with a different descriptor and dialect, which is
 * the point: **adding an engine is a descriptor, not a code change here.**
 *
 * What is left is what is genuinely Postgres-specific about *this entry
 * point*: it takes an existing `pg.Pool` the caller already owns, rather than
 * building one from a connection descriptor.
 *
 * ## What did not change
 *
 * The security posture is identical, because it is the same code — it just
 * lives in one place now instead of two:
 *
 *  1. **Read-only by default**, enforced by `BEGIN … READ ONLY` on a *pinned*
 *     client, so the flag and the statements are guaranteed to be one session.
 *  2. **No string-concatenated values, ever** — the shared builder binds every
 *     value and quotes every resolved identifier.
 *  3. **Every statement is capped and timed out.**
 *  4. **Multi-statement execution is off** unless explicitly enabled.
 *  5. **Credentials never leave this process** and are never logged or
 *     returned; `capabilities().label` is a display name, not a DSN.
 */

import type { Pool, PoolClient } from 'pg'
import {
  createSqlDataSource,
  createPostgresDialect,
  postgresDescriptor,
} from '@jugaaadi/db-browser-connectors'
import type { SqlConnection } from '@jugaaadi/db-browser-connectors'
import type { DataSource, LimitPolicy } from '@jugaaadi/db-browser/core'

export interface PgDataSourceOptions {
  pool: Pool
  /** Display label. **Never** a connection string. */
  label?: string
  /** Default `true`. Writes are refused at every level while it is on. */
  readOnly?: boolean
  /** Allow DDL when not read-only. Default `false`. */
  allowDdl?: boolean
  /** Allow `;`-chained statements. Default `false`. */
  allowMultipleStatements?: boolean
  limits?: Partial<LimitPolicy>
  /** Per-statement timeout in ms. Default 15000. */
  statementTimeoutMs?: number
  /** Restrict browsing to these schemas. Default: everything non-system. */
  schemas?: string[]
  /** Cache introspection for this long. Default 5000 ms. */
  introspectionTtlMs?: number
  /** Stable id used to namespace client-side state. */
  id?: string
}

export interface PgDataSource extends DataSource {
  /** Drop cached introspection — call after a schema change. */
  invalidate(): void
}

/**
 * Wrap a caller-owned `pg.Pool` as an `SqlConnection`.
 *
 * `transaction` pins a client for the whole unit of work. This is not an
 * optimisation: `BEGIN READ ONLY` is a *session* statement, so sending it down
 * one pooled socket and the `SELECT` down another would leave the read-only
 * guarantee silently unenforced — the exact failure that makes people distrust
 * a read-only console.
 *
 * The pool is **not** closed by `close()`. The caller created it and may be
 * using it for other things; a library that ends someone else's pool because
 * one data source was discarded is a library that causes an outage.
 */
function connectionFor(pool: Pool, statementTimeoutMs: number): SqlConnection {
  const applyTimeouts = async (client: PoolClient): Promise<void> => {
    // `set_config(..., true)` is the parameterised form of `SET LOCAL` —
    // `SET` itself does not accept placeholders, so this is the only way to
    // set a timeout from a value without concatenating it into SQL.
    await client.query('SELECT set_config($1, $2, true)', [
      'statement_timeout',
      String(statementTimeoutMs),
    ])
    await client.query('SELECT set_config($1, $2, true)', [
      'idle_in_transaction_session_timeout',
      String(Math.max(statementTimeoutMs, 5_000)),
    ])
  }

  return {
    driver: 'pg',
    async exec(sql, params) {
      const res = await pool.query(sql, params ? [...params] : [])
      return {
        rows: res.rows as Array<Record<string, unknown>>,
        fields: res.fields?.map((f) => ({ name: f.name })),
        rowCount: res.rowCount ?? null,
        command: res.command ?? null,
      }
    },
    async transaction(fn) {
      const client = await pool.connect()
      let opened = false
      try {
        return await fn(async (sql, params) => {
          // The timeouts are `SET LOCAL`, so they must land *inside* the
          // transaction — which means after the first statement (the `BEGIN`)
          // rather than before it.
          const res = await client.query(sql, params ? [...params] : [])
          if (!opened) {
            opened = true
            if (/^\s*BEGIN/i.test(sql)) await applyTimeouts(client)
          }
          return {
            rows: res.rows as Array<Record<string, unknown>>,
            fields: res.fields?.map((f) => ({ name: f.name })),
            rowCount: res.rowCount ?? null,
            command: res.command ?? null,
          }
        })
      } finally {
        client.release()
      }
    },
    async close() {
      // Deliberately a no-op. See the doc comment above.
    },
  }
}

export function createPgDataSource(options: PgDataSourceOptions): PgDataSource {
  const source = createSqlDataSource({
    dialect: createPostgresDialect('postgres', postgresDescriptor),
    connection: connectionFor(options.pool, options.statementTimeoutMs ?? 15_000),
    label: options.label ?? 'postgres',
    readOnly: options.readOnly ?? true,
    allowDdl: options.allowDdl ?? false,
    allowMultipleStatements: options.allowMultipleStatements ?? false,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.schemas ? { schemas: options.schemas } : {}),
    ...(options.introspectionTtlMs === undefined
      ? {}
      : { introspectionTtlMs: options.introspectionTtlMs }),
    id: options.id ?? `pg:${options.label ?? 'default'}`,
  })
  return source
}
