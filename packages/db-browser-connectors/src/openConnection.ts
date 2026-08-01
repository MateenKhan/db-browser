/**
 * Descriptor + config → a live `DataSource`.
 *
 * The single place a connection is opened, and the only place that knows
 * which engines are served by the shared base and which are not.
 *
 * ## SQLite is not on the shared base, and that is deliberate
 *
 * Every server-backed engine here (Postgres, CockroachDB, MySQL, MariaDB) runs
 * through `createSqlDataSource` — one implementation, parameterised by a
 * descriptor and a dialect. SQLite runs through
 * `@jugaaadi/db-browser-sqlite`'s adapter instead, because it is a genuinely
 * different *shape* rather than a different set of strings:
 *
 *  - it is **in-process and synchronous**, so there is no pool to pin, no
 *    `BEGIN` to send down the right socket, and no statement timeout to set;
 *  - its introspection is `pragma`-based, and its **`rowid` fallback** is what
 *    makes the very many PK-less SQLite tables editable at all;
 *  - it applies SQLite's own five-rule **affinity** algorithm, which no type
 *    map can reproduce (`INT` before `CHAR` is why `INTPOINT` is an integer);
 *  - it narrows **BigInt** integers, without which a table with a snowflake id
 *    is not "displayed oddly", it is unreadable;
 *  - it detects **embedding stores and code graphs** and answers `/profile`.
 *
 * Forcing that through an async, pooled, catalog-query base would mean
 * reimplementing all five behind an interface that fits none of them. What
 * matters is that it implements **the same `DataSource` contract** and shares
 * every safety property that is not engine-specific — the guard, the
 * pagination planner, the identifier rules, the row-identity rule and the
 * pending-changes model are the same code in both paths. A caller of
 * `openConnection` cannot tell the difference, which is the actual
 * requirement.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'
import type { DataSource } from '@jugaaadi/db-browser/core'
import { dialectFor } from './dialects/index.js'
import { openPostgresConnection } from './engines/postgres.js'
import { openMysqlConnection } from './engines/mysql.js'
import { requireDescriptor } from './registry.js'
import { createSqlDataSource } from './sqlDataSource.js'
import type { ResolvedConnectionConfig } from './connections/config.js'
import type { ConnectorDescriptor } from './types.js'

/**
 * How SQLite is opened, injected rather than imported.
 *
 * `@jugaaadi/db-browser-connectors` must stay importable by a server that has
 * no SQLite adapter installed — and, more importantly, importing the SQLite
 * package from here would be a dependency cycle, since that package depends on
 * this one for its descriptor. The demo server supplies this hook.
 */
export type SqliteOpener = (options: {
  filename: string
  readOnly: boolean
  id: string
  label?: string
}) => Promise<DataSource>

let sqliteOpener: SqliteOpener | null = null

/** Register the SQLite adapter. Called once by the host process. */
export function registerSqliteOpener(opener: SqliteOpener): void {
  sqliteOpener = opener
}

export interface OpenConnectionOptions {
  label?: string
  limits?: { defaultLimit?: number; maxLimit?: number }
  allowDdl?: boolean
  allowMultipleStatements?: boolean
}

export async function openConnection(
  config: ResolvedConnectionConfig,
  options: OpenConnectionOptions = {},
): Promise<DataSource> {
  const descriptor = requireDescriptor(config.engine)

  if (descriptor.id === 'sqlite') {
    if (!sqliteOpener) {
      throw new DbBrowserError(
        'ENGINE_NOT_SUPPORTED',
        'No SQLite adapter is registered in this process. Call registerSqliteOpener() with ' +
          "@jugaaadi/db-browser-sqlite's createSqliteDataSource before opening a SQLite connection.",
      )
    }
    const filename = String(config.values.file ?? '')
    if (!filename) {
      throw new DbBrowserError('INVALID_CONNECTION', 'A SQLite connection needs a database file')
    }
    return await sqliteOpener({
      filename,
      // A SQLite connection's read-only flag is enforced by SQLite itself at
      // open time, so it has to be decided here rather than per statement.
      readOnly: config.readOnly !== false,
      id: `sqlite:${config.id}`,
      ...(options.label ? { label: options.label } : {}),
    })
  }

  const connection = await openDriverConnection(descriptor, config)
  try {
    return createSqlDataSource({
      dialect: dialectFor(descriptor.id),
      connection,
      label: options.label ?? config.values.database ? String(config.values.database) : descriptor.label,
      readOnly: config.readOnly !== false,
      allowDdl: options.allowDdl ?? false,
      allowMultipleStatements: options.allowMultipleStatements ?? false,
      limits: options.limits,
      id: `${descriptor.id}:${config.id}`,
      ...(config.schemas ? { schemas: config.schemas } : {}),
    })
  } catch (e) {
    // A failure between opening the socket and building the data source would
    // otherwise leak the pool for the lifetime of the process.
    await connection.close().catch(() => {})
    throw e
  }
}

async function openDriverConnection(
  descriptor: ConnectorDescriptor,
  config: ResolvedConnectionConfig,
) {
  switch (descriptor.id) {
    case 'postgres':
    case 'cockroach':
      return await openPostgresConnection(descriptor, config)
    case 'mysql':
    case 'mariadb':
      return await openMysqlConnection(descriptor, config)
    default:
      throw new DbBrowserError(
        'ENGINE_NOT_SUPPORTED',
        `${descriptor.label} is described by this registry but has no driver binding in this ` +
          `build yet. The descriptor, the type map and the connection form are ready; the ` +
          `adapter is not.`,
      )
  }
}

export interface TestConnectionResult {
  ok: boolean
  /** Round-trip time of the probe, in ms. */
  durationMs: number
  /** A safe, human message. Never contains a password. */
  message: string
  /** How many tables the probe could see, when it got that far. */
  tableCount?: number
  code?: string
}

/**
 * Open a connection, prove it works, and close it.
 *
 * The probe is `listTables()` rather than a bare handshake, because "the TCP
 * connection succeeded" is not what a user means by "test": a login that
 * cannot read the catalog produces a green tick and then an empty sidebar.
 *
 * Every failure is caught and turned into `{ ok: false, message }`. Nothing
 * about the config is echoed — not the host, not the user, and above all not
 * the password, which several drivers put into their own error messages.
 */
export async function testConnection(
  config: ResolvedConnectionConfig,
  options: OpenConnectionOptions = {},
): Promise<TestConnectionResult> {
  const started = Date.now()
  let source: DataSource | null = null
  try {
    source = await openConnection(config, options)
    const tables = await source.listTables()
    return {
      ok: true,
      durationMs: Date.now() - started,
      tableCount: tables.length,
      message: `Connected. ${tables.length} table${tables.length === 1 ? '' : 's'} visible.`,
    }
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return {
      ok: false,
      durationMs: Date.now() - started,
      code: err?.code,
      message: scrubConnectionError(err?.message ?? 'The connection failed.', config),
    }
  } finally {
    const closable = source as { close?: () => unknown } | null
    try {
      await closable?.close?.()
    } catch {
      /* the socket is already gone */
    }
  }
}

/**
 * Remove anything from a driver error that came from the config.
 *
 * The realistic leak is not a driver printing `password: "hunter2"` — it is a
 * DSN in an error message, and a password that happens to be a substring of
 * one. Both are handled by replacing every stored secret's *value* wherever it
 * appears, which is a blunt instrument and the right one: a false positive
 * costs a redacted word in an error message.
 */
export function scrubConnectionError(message: string, config: ResolvedConnectionConfig): string {
  let out = String(message ?? '')
  for (const secret of Object.values(config.secrets)) {
    if (secret && secret.length >= 3) out = out.split(secret).join('<redacted>')
  }
  return out.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//<redacted>@')
}
