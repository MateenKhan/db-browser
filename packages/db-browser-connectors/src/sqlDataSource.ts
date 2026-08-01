/**
 * The shared `SqlDataSource`.
 *
 * One implementation of `DataSource`, parameterised by a `ConnectorDescriptor`
 * (data) and a `Dialect` (the small strategy). It is what every server-backed
 * engine is; adding an engine adds a descriptor, a dialect and a driver
 * binding, and touches nothing here.
 *
 * ## Everything that is *not* per-engine, and is enforced here
 *
 * These are the safety properties, and no dialect can override any of them.
 * They were verified once, against real databases, and this is the single
 * place they live:
 *
 *  1. **Read-only by default.** `readOnly: true` unless the caller opts out.
 *     Where the engine has a session-level switch (`BEGIN READ ONLY`,
 *     `START TRANSACTION READ ONLY`) it is used too, so the *server* refuses a
 *     write the regex guard somehow let through. The guard is the first gate;
 *     the session is the one that cannot be talked out of. Where an engine has
 *     no such switch its descriptor says `readOnlySession: false` rather than
 *     pretending.
 *  2. **The statement guard runs before anything reaches a server**, with the
 *     engine's own denylist, and multi-statement execution is off unless
 *     explicitly enabled.
 *  3. **Every page is capped and every ad-hoc `SELECT` is wrapped**, so the
 *     cap is enforced by the server rather than by discarding rows Node has
 *     already materialised.
 *  4. **Row identity is never guessed.** A table with no key is read-only with
 *     a reason, not written to with a `WHERE` across every column.
 *  5. **Credentials never leave this process.** `capabilities().label` is a
 *     display name; driver errors are normalised so the config object — which
 *     carries the password — is dropped.
 */

import {
  DbBrowserError,
  assertSqlAllowed,
  buildTableSchema,
  clampLimit,
  cursorFromRow,
  describeUpdatability,
  isWrappableSelect,
  planPage,
  resolveTable,
  stripTrailingSemicolon,
} from '@jugaaadi/db-browser/core'
import type {
  BinaryCellData,
  ColumnMeta,
  DataSource,
  DataSourceCapabilities,
  LimitPolicy,
  Page,
  PkValues,
  QueryResult,
  Row,
  RowIdentityKind,
  RunQueryOptions,
  SelectQuery,
  TableMeta,
  TableRef,
  TableSchema,
} from '@jugaaadi/db-browser/core'
import type { Dialect, Exec } from './dialects/types.js'
import type { ColumnResolver } from './sqlBuilder.js'
import {
  buildBinaryFetch,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from './sqlBuilder.js'

/**
 * A live connection, reduced to what the data source uses.
 *
 * Deliberately tiny: one `exec`, one `close`, and an optional `transaction`
 * that a driver with a pool can implement by pinning a client. A binding that
 * cannot pin one still works — `transaction` falls back to running the
 * statements on the shared connection, which is correct for a single-connection
 * driver and is why it is optional rather than required.
 */
export interface SqlConnection {
  exec: Exec
  close(): Promise<void>
  /**
   * Run `fn` with a connection pinned for the duration, so `BEGIN` and the
   * statements after it are guaranteed to be the same session. Without this a
   * pooled driver can send `BEGIN READ ONLY` down one socket and the `SELECT`
   * down another, and the read-only guarantee silently evaporates.
   */
  transaction?<T>(fn: (exec: Exec) => Promise<T>): Promise<T>
  /** Free-form driver identity, for diagnostics. Never a connection string. */
  driver?: string
}

export interface SqlDataSourceOptions {
  dialect: Dialect
  connection: SqlConnection
  /** Display label. **Never** a connection string. */
  label?: string
  /** Default `true`. Writes are refused at every level while it is on. */
  readOnly?: boolean
  /** Allow DDL when not read-only. Default `false`. */
  allowDdl?: boolean
  /** Allow `;`-chained statements. Default `false`. */
  allowMultipleStatements?: boolean
  limits?: Partial<LimitPolicy>
  /** Restrict browsing to these schemas. Default: everything non-system. */
  schemas?: string[]
  /** Cache introspection for this long. Default 5000 ms. */
  introspectionTtlMs?: number
  /** Stable id used to namespace client-side state. */
  id?: string
  /**
   * Per-engine row identity, for an engine with an implicit key. Only SQLite
   * has one; the hook exists so that fact lives in the SQLite dialect rather
   * than as an `if` here.
   */
  resolveRowIdentity?: (
    table: TableMeta,
    columns: readonly ColumnMeta[],
  ) => { primaryKey: string[]; kind: RowIdentityKind; note: string | null } | null
  /** Accept the implicit key's name even though introspection never reports it. */
  resolveColumnName?: ColumnResolver
}

export interface SqlDataSourceHandle extends DataSource {
  /** Drop cached introspection — call after a schema change. */
  invalidate(): void
  close(): Promise<void>
  /** Which driver is in use, for diagnostics. */
  driver(): string
}

interface Cached<T> {
  at: number
  value: T
}

export function createSqlDataSource(options: SqlDataSourceOptions): SqlDataSourceHandle {
  const {
    dialect,
    connection,
    readOnly = true,
    allowDdl = false,
    allowMultipleStatements = false,
    introspectionTtlMs = 5_000,
  } = options

  const descriptor = dialect.descriptor
  const label = options.label ?? descriptor.label
  const policy: LimitPolicy = {
    defaultLimit: options.limits?.defaultLimit ?? 100,
    maxLimit: options.limits?.maxLimit ?? 1000,
  }
  const ctx = { dialect, resolveName: options.resolveColumnName }

  let tableCache: Cached<TableMeta[]> | null = null
  const schemaCache = new Map<string, Cached<TableSchema>>()

  const fresh = <T>(c: Cached<T> | null | undefined): c is Cached<T> =>
    !!c && Date.now() - c.at < introspectionTtlMs

  /**
   * Run `fn` inside a transaction with the session's read-only flag applied.
   *
   * When the engine has no read-only session switch the transaction is still
   * opened — so a multi-statement unit is still atomic — but the descriptor
   * has already told the caller that the guard is the only enforcement there.
   */
  async function inTransaction<T>(write: boolean, fn: (exec: Exec) => Promise<T>): Promise<T> {
    const run = async (exec: Exec): Promise<T> => {
      const opening = write ? dialect.beginWrite : dialect.beginReadOnly
      if (!opening.length) return await fn(exec)
      for (const statement of opening) await exec(statement)
      try {
        const result = await fn(exec)
        await exec(dialect.commit)
        return result
      } catch (e) {
        try {
          await exec(dialect.rollback)
        } catch {
          /* the connection is already broken; the pool will discard it */
        }
        throw dialect.toError(e)
      }
    }

    try {
      return connection.transaction ? await connection.transaction(run) : await run(connection.exec)
    } catch (e) {
      throw dialect.toError(e)
    }
  }

  function assertWritable(what: string): void {
    if (readOnly) {
      throw new DbBrowserError(
        'READ_ONLY',
        `${what} is blocked: this connection is open in read-only mode`,
      )
    }
  }

  async function tables(): Promise<TableMeta[]> {
    if (fresh(tableCache)) return tableCache.value
    const value = await inTransaction(false, (exec) =>
      dialect.listTables(exec, { schemas: options.schemas }),
    )
    tableCache = { at: Date.now(), value }
    return value
  }

  /**
   * Build the schema for one table.
   *
   * `describeUpdatability` (shared) implements the strict rule: no primary key
   * means no safe `WHERE`, so the table is read-only. That rule is right
   * everywhere, and on one engine it is also too strict — SQLite's ordinary
   * tables always have a `rowid` even when nobody declared a key. So the
   * shared rule is consulted first and overridden **only** when the dialect's
   * own resolver found a real implicit key. Views and key-less tables on every
   * other engine keep the strict verdict and its reason.
   */
  async function schemaOf(ref: TableRef): Promise<TableSchema> {
    const known = resolveTable(await tables(), ref)
    const key = `${known.schema}.${known.name}`
    const cached = schemaCache.get(key)
    if (fresh(cached)) return cached.value

    const columns = await inTransaction(false, (exec) =>
      dialect.describeColumns(exec, { schema: known.schema, name: known.name }),
    )

    const identity = options.resolveRowIdentity?.(known, columns) ?? null
    const value: TableSchema =
      identity && identity.kind === 'implicit'
        ? {
            table: { schema: known.schema, name: known.name },
            columns,
            primaryKey: identity.primaryKey,
            updatable: true,
            notUpdatableReason: null,
            rowIdentity: 'implicit',
            identityNote: identity.note,
          }
        : (() => {
            const strict = buildTableSchema(
              { schema: known.schema, name: known.name },
              known.kind,
              columns,
            )
            return {
              ...strict,
              rowIdentity: (strict.primaryKey.length
                ? 'primary-key'
                : 'none') as RowIdentityKind,
              identityNote: null,
            }
          })()

    schemaCache.set(key, { at: Date.now(), value })
    return value
  }

  /**
   * Replace the projected byte-length numbers with a binary placeholder.
   *
   * The projection already asked for `length(col)` rather than the bytes, so
   * the value here is a size. Any *actual* byte array that still turns up —
   * which happens on dynamically-typed engines, where a TEXT column can hold
   * a blob — is converted at row level, because a `Uint8Array` that reaches
   * `JSON.stringify` renders as `{"0":72,"1":105}`.
   */
  function decorateBinary(rows: Row[], schema: TableSchema): Row[] {
    const binaryColumns = new Map(schema.columns.filter((c) => c.isBinary).map((c) => [c.name, c]))
    return rows.map((row) => {
      const out: Row = { ...row }
      for (const [name, value] of Object.entries(row)) {
        const column = binaryColumns.get(name)
        if (column) {
          out[name] =
            value === null || value === undefined
              ? null
              : { __dbbBinary: true as const, bytes: Number(value), contentType: null }
          continue
        }
        if (value instanceof Uint8Array) {
          out[name] = {
            __dbbBinary: true as const,
            bytes: value.byteLength,
            contentType: null,
          }
        }
      }
      return out
    })
  }

  const capabilities = (): DataSourceCapabilities => ({
    writes: !readOnly,
    keyset: descriptor.capabilities.keysetPagination,
    binaryFetch: true,
    label,
    dialect: dialect.sqlDialect,
    profile: false,
  })

  return {
    id: options.id ?? `${descriptor.id}:${label}`,
    capabilities,
    driver: () => connection.driver ?? descriptor.driverPackage ?? descriptor.id,
    close: () => connection.close(),

    invalidate() {
      tableCache = null
      schemaCache.clear()
    },

    listTables: tables,
    describeTable: schemaOf,

    async select(query: SelectQuery): Promise<Page> {
      const schema = await schemaOf(query.table)
      const limit = clampLimit(query.limit, policy)
      const plan = planPage({
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        sort: query.sort,
        cursor: query.cursor,
        offset: query.offset,
        limit,
        policy,
        keysetAllowed:
          descriptor.capabilities.keysetPagination && schema.primaryKey.length > 0,
      })
      const built = buildSelect(ctx, {
        table: schema.table,
        columns: schema.columns,
        plan,
        filters: query.filters,
        projection: query.columns,
      })
      const started = Date.now()
      const res = await inTransaction(false, (exec) => exec(built.text, built.values))
      const hasMore = res.rows.length > plan.limit
      const rows = decorateBinary(res.rows.slice(0, plan.limit) as Row[], schema)
      const last = rows[rows.length - 1]
      const meta = (await tables()).find(
        (t) => t.schema === schema.table.schema && t.name === schema.table.name,
      )
      return {
        rows,
        columns: schema.columns,
        limit: plan.limit,
        strategy: plan.strategy,
        hasMore,
        nextCursor:
          plan.strategy === 'keyset' && last && hasMore ? cursorFromRow(last, plan.orderBy) : null,
        offset: plan.strategy === 'offset' ? plan.offset : undefined,
        totalEstimate: meta?.rowCountEstimate ?? null,
        durationMs: Date.now() - started,
      }
    },

    async insert(table: TableRef, row: Row): Promise<Row> {
      assertWritable('INSERT')
      const schema = await schemaOf(table)
      const built = buildInsert(ctx, {
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        row,
      })
      const res = await inTransaction(true, (exec) => exec(built.text, built.values))
      if (built.returnsRow) return (res.rows[0] ?? {}) as Row
      // No `RETURNING` on this engine. Read the row back through the key the
      // caller supplied, so the grid still receives server-computed defaults.
      const keyed = schema.primaryKey.every((name) => row[name] !== undefined)
      if (!keyed) return row
      return await readBackRow(schema, Object.fromEntries(
        schema.primaryKey.map((name) => [name, row[name]]),
      ))
    },

    async update(table: TableRef, pk: PkValues, patch: Row): Promise<Row> {
      assertWritable('UPDATE')
      const schema = await schemaOf(table)
      if (!schema.updatable) {
        throw new DbBrowserError(
          'NOT_UPDATABLE',
          schema.notUpdatableReason ?? 'Table is not updatable',
        )
      }
      const built = buildUpdate(ctx, {
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        pk,
        patch,
      })
      const res = await inTransaction(true, (exec) => exec(built.text, built.values))
      const affected = built.returnsRow ? res.rows.length : (res.rowCount ?? 0)
      if (affected === 0) {
        throw new DbBrowserError(
          'ROW_NOT_FOUND',
          'No row matched that key — it may have been deleted by someone else',
        )
      }
      if (affected > 1) {
        // Cannot happen with a real key; treated as a bug rather than ignored,
        // because "we changed more rows than we meant to" is exactly the
        // failure this library exists to prevent.
        throw new DbBrowserError('AMBIGUOUS_KEY', 'The key matched more than one row')
      }
      if (built.returnsRow) return (res.rows[0] ?? {}) as Row
      return await readBackRow(schema, pk)
    },

    async delete(table: TableRef, pk: PkValues): Promise<void> {
      assertWritable('DELETE')
      const schema = await schemaOf(table)
      if (!schema.updatable) {
        throw new DbBrowserError(
          'NOT_UPDATABLE',
          schema.notUpdatableReason ?? 'Table is not updatable',
        )
      }
      const built = buildDelete(ctx, {
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        pk,
      })
      const res = await inTransaction(true, (exec) => exec(built.text, built.values))
      if ((res.rowCount ?? 0) === 0) {
        throw new DbBrowserError('ROW_NOT_FOUND', 'No row matched that key')
      }
    },

    async runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
      const mode = readOnly || !opts.allowWrite ? 'read-only' : 'read-write'
      const analysis = assertSqlAllowed(sql, {
        mode,
        // The engine's own denylist, not a shared guess. Postgres's
        // `pg_read_file` and DuckDB's `read_csv` are different problems.
        dialect: dialect.sqlDialect,
        allowDdl: allowDdl && !readOnly,
        allowMultipleStatements: allowMultipleStatements && !!opts.allowMultipleStatements,
        confirmedUnqualified: false,
      })
      const limit = clampLimit(opts.limit, policy)
      const single = analysis.statements[0]
      const write = mode === 'read-write' && !analysis.readOnly
      if (write) assertWritable(single.command)

      const text =
        analysis.statements.length === 1 && isWrappableSelect(single)
          ? dialect.wrapWithLimit(stripTrailingSemicolon(single.sql), limit + 1)
          : analysis.statements.map((s) => stripTrailingSemicolon(s.sql)).join('; ')

      const started = Date.now()
      const res = await inTransaction(write, (exec) => exec(text))

      const fields =
        res.fields ??
        Object.keys(res.rows[0] ?? {}).map((name) => ({ name, dataType: null as string | null }))
      const truncated = res.rows.length > limit
      const rows = res.rows.slice(0, limit).map((row) => {
        const out: Row = {}
        for (const [k, v] of Object.entries(row)) {
          out[k] =
            v instanceof Uint8Array
              ? { __dbbBinary: true as const, bytes: v.byteLength, contentType: null }
              : v
        }
        return out
      })

      return {
        columns: fields.map((f) => ({
          name: f.name,
          dataType: f.dataType ?? '(expression)',
        })),
        rows,
        rowCount: rows.length,
        truncated,
        limit,
        durationMs: Date.now() - started,
        command: res.command ?? single.command,
      }
    },

    async fetchBinary(table: TableRef, pk: PkValues, column: string): Promise<BinaryCellData> {
      const schema = await schemaOf(table)
      const built = buildBinaryFetch(ctx, {
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        pk,
        column,
      })
      const res = await inTransaction(false, (exec) => exec(built.text, built.values))
      const row = res.rows[0] as { bytes: unknown; size: unknown } | undefined
      if (!row) throw new DbBrowserError('ROW_NOT_FOUND', 'No row matched that key')
      const base64 = built.serverEncoded
        ? String(row.bytes ?? '')
        : row.bytes instanceof Uint8Array
          ? Buffer.from(row.bytes).toString('base64')
          : ''
      return {
        __dbbBinary: true,
        bytes: row.size === null || row.size === undefined ? null : Number(row.size),
        base64,
        contentType: null,
      }
    },
  }

  /**
   * Re-read one row by its key. Used where the engine has no `RETURNING`.
   *
   * Goes through `buildSelect` rather than a hand-written statement so the
   * blob projection, the identifier resolution and the binder are the same
   * ones the page used — a second, simpler statement here is exactly how the
   * two would drift.
   */
  async function readBackRow(schema: TableSchema, pk: PkValues): Promise<Row> {
    const built = buildSelect(ctx, {
      table: schema.table,
      columns: schema.columns,
      plan: { strategy: 'offset', orderBy: [], offset: 0, limit: 1 },
      filters: schema.primaryKey.map((name) => ({
        column: name,
        op: 'eq' as const,
        value: pk[name],
      })),
      probeExtraRow: false,
    })
    const res = await inTransaction(false, (exec) => exec(built.text, built.values))
    return decorateBinary(res.rows as Row[], schema)[0] ?? {}
  }
}

/** Re-exported so a caller can build the strict verdict without the source. */
export { describeUpdatability }
