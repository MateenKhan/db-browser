/**
 * The MySQL / MariaDB driver binding.
 *
 * The **only** file in this package that touches `mysql2`, and it touches it
 * through `loadDriver()`. `GET /api/connectors` lists MySQL as `installed:
 * false` with the exact install command on a machine that has never run
 * `npm install mysql2`, and nothing here executes.
 *
 * ## Three `mysql2` details that are not obvious
 *
 *  1. **`multipleStatements` stays off.** It is a driver option, and turning
 *     it on would let a `;` past the guard at the protocol level — the guard
 *     would refuse the text, but any future code path that skipped the guard
 *     would then have a live SQL-injection amplifier. Off is not a default we
 *     inherit; it is a decision.
 *  2. **`namedPlaceholders` stays off** so `?` means exactly what the builder
 *     emitted.
 *  3. **`dateStrings: true`.** By default `mysql2` converts `DATE`/`DATETIME`
 *     into JavaScript `Date` objects *in the server's timezone as interpreted
 *     by the Node process*, which silently shifts every timestamp when the two
 *     disagree — and then `JSON.stringify` renders it in UTC, shifting it
 *     again. A database browser must show what is stored. Strings do.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'
import { loadDriver } from '../driverLoader.js'
import type { ConnectorDescriptor } from '../types.js'
import type { ExecResult } from '../dialects/types.js'
import type { SqlConnection } from '../sqlDataSource.js'
import type { ResolvedConnectionConfig } from '../connections/config.js'

/** The slice of `mysql2/promise` this binding uses, typed structurally so the
 * package is not a build-time dependency here. */
interface MysqlFieldPacket {
  name: string
  type?: number
  columnType?: number
}

interface MysqlConnection {
  execute(
    sql: string,
    values?: readonly unknown[],
  ): Promise<[unknown, MysqlFieldPacket[] | undefined]>
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, MysqlFieldPacket[] | undefined]>
  end(): Promise<void>
  release?(): void
}

interface MysqlPool {
  getConnection(): Promise<MysqlConnection>
  query(sql: string, values?: readonly unknown[]): Promise<[unknown, MysqlFieldPacket[] | undefined]>
  end(): Promise<void>
}

interface MysqlModule {
  createPool?(config: Record<string, unknown>): MysqlPool
  default?: { createPool?(config: Record<string, unknown>): MysqlPool }
  promise?(): { createPool(config: Record<string, unknown>): MysqlPool }
}

function sslFor(mode: unknown): undefined | { rejectUnauthorized: boolean } {
  switch (String(mode ?? 'disable')) {
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-full':
      return { rejectUnauthorized: true }
    default:
      return undefined
  }
}

/**
 * Turn what `mysql2` returns into an `ExecResult`.
 *
 * A `SELECT` yields `[rows[], fields[]]`; a write yields `[ResultSetHeader,
 * undefined]`. Distinguishing them by `Array.isArray` rather than by the
 * statement text is what makes `rowCount` right for a write whose text the
 * data source never parsed.
 */
function toResult(payload: unknown, fields: MysqlFieldPacket[] | undefined): ExecResult {
  if (Array.isArray(payload)) {
    return {
      rows: payload as Array<Record<string, unknown>>,
      fields: fields?.map((f) => ({ name: f.name })),
      rowCount: payload.length,
    }
  }
  const header = (payload ?? {}) as { affectedRows?: number; insertId?: number }
  return {
    rows: [],
    fields: fields?.map((f) => ({ name: f.name })),
    rowCount: header.affectedRows ?? 0,
  }
}

export async function openMysqlConnection(
  descriptor: ConnectorDescriptor,
  config: ResolvedConnectionConfig,
): Promise<SqlConnection> {
  const mod = await loadDriver<MysqlModule>(descriptor)
  // `mysql2` publishes the promise API three ways depending on how it is
  // imported. Probing all three is cheaper than pinning one and breaking on a
  // minor version that changes the interop shape.
  const createPool =
    mod.createPool ??
    mod.default?.createPool ??
    (typeof mod.promise === 'function' ? mod.promise().createPool : undefined)
  if (!createPool) {
    throw new DbBrowserError(
      'DRIVER_LOAD_FAILED',
      'The "mysql2" package loaded but did not export createPool. Check the installed version.',
    )
  }

  const pool = createPool({
    host: String(config.values.host ?? 'localhost'),
    port: Number(config.values.port ?? descriptor.defaultPort ?? 3306),
    database: String(config.values.database ?? ''),
    user: String(config.values.user ?? ''),
    password: config.secrets.password ?? undefined,
    ssl: sslFor(config.values.ssl),
    connectionLimit: 5,
    waitForConnections: true,
    // See the header. None of these three is a default worth inheriting.
    multipleStatements: false,
    namedPlaceholders: false,
    dateStrings: true,
    // `BIGINT` outside +/-2^53 is otherwise silently rounded. Strings for the
    // ones that do not fit is the same trade the SQLite adapter makes: a value
    // that renders and exports exactly, rather than a number that is wrong.
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectTimeout: 5_000,
  })

  const exec = async (
    conn: { query: MysqlConnection['query'] },
    sql: string,
    params?: readonly unknown[],
  ): Promise<ExecResult> => {
    // `query` rather than `execute`: `execute` uses the binary prepared-
    // statement protocol, which refuses a placeholder in several positions
    // this builder legitimately uses (`LIMIT ?` on older servers), and caches
    // a statement handle per text — unhelpful for one-shot browsing.
    const [payload, fields] = await conn.query(sql, params ? [...params] : undefined)
    return toResult(payload, fields)
  }

  return {
    driver: 'mysql2',
    exec: (sql, params) => exec(pool, sql, params),
    /**
     * A pinned connection for the unit of work — `START TRANSACTION READ ONLY`
     * is a *session* statement, so sending it down a pooled socket and the
     * `SELECT` down another would leave the read-only guarantee unenforced.
     */
    async transaction(fn) {
      const conn = await pool.getConnection()
      try {
        return await fn((sql, params) => exec(conn, sql, params))
      } finally {
        conn.release?.()
      }
    },
    async close() {
      await pool.end()
    },
  }
}
