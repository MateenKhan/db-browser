/**
 * The reference Postgres `DataSource`.
 *
 * Security posture, in order of importance:
 *
 *  1. **Read-only by default.** `readOnly: true` unless the caller opts out.
 *     Every statement runs inside `BEGIN … READ ONLY`, so even a statement the
 *     regex guard somehow let through is refused by Postgres itself
 *     (`ERROR: cannot execute UPDATE in a read-only transaction`). The guard
 *     is the first gate; the transaction is the one that cannot be talked out
 *     of.
 *  2. **No string-concatenated values, ever.** All CRUD goes through
 *     `sqlBuilder`, which binds values and quotes resolved identifiers.
 *  3. **Every statement is capped and timed out.** `statement_timeout` and
 *     `idle_in_transaction_session_timeout` are set per transaction, and rows
 *     are limited server-side.
 *  4. **Multi-statement execution is off** unless explicitly enabled, because
 *     `;` chaining is the classic path from a read-only console to `DROP`.
 *  5. **Credentials never leave this process**, and are never logged or
 *     returned. `capabilities().label` is a display name, not a DSN.
 */

import type { Pool, PoolClient } from 'pg'
import {
  DbBrowserError,
  assertSqlAllowed,
  buildTableSchema,
  clampLimit,
  cursorFromRow,
  isWrappableSelect,
  planPage,
  resolveTable,
  stripTrailingSemicolon,
} from '@jugaaadi/db-browser/core'
import type {
  BinaryCellData,
  DataSource,
  DataSourceCapabilities,
  LimitPolicy,
  Page,
  PkValues,
  QueryResult,
  Row,
  RunQueryOptions,
  SelectQuery,
  TableMeta,
  TableRef,
  TableSchema,
} from '@jugaaadi/db-browser/core'
import { describeColumns, listTables } from './introspect.js'
import { categoryForOid, udtNameForOid } from './typeOids.js'
import {
  buildBinaryFetch,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  wrapWithLimit,
} from './sqlBuilder.js'

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

interface Cached<T> {
  at: number
  value: T
}

export interface PgDataSource extends DataSource {
  /** Drop cached introspection — call after a schema change. */
  invalidate(): void
}

export function createPgDataSource(options: PgDataSourceOptions): PgDataSource {
  const {
    pool,
    readOnly = true,
    allowDdl = false,
    allowMultipleStatements = false,
    statementTimeoutMs = 15_000,
    introspectionTtlMs = 5_000,
  } = options

  const policy: LimitPolicy = {
    defaultLimit: options.limits?.defaultLimit ?? 100,
    maxLimit: options.limits?.maxLimit ?? 1000,
  }

  let tableCache: Cached<TableMeta[]> | null = null
  const schemaCache = new Map<string, Cached<TableSchema>>()

  const fresh = <T>(c: Cached<T> | null | undefined): c is Cached<T> =>
    !!c && Date.now() - c.at < introspectionTtlMs

  /**
   * Run `fn` on a dedicated client inside a transaction with the timeouts and
   * the read-only flag applied. `set_config(..., true)` is the parameterised
   * form of `SET LOCAL` — `SET` itself does not accept placeholders.
   */
  async function inTransaction<T>(
    write: boolean,
    fn: (client: PoolClient) => Promise<T>,
    timeoutMs = statementTimeoutMs,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query(write ? 'BEGIN' : 'BEGIN READ ONLY')
      await client.query('SELECT set_config($1, $2, true)', ['statement_timeout', String(timeoutMs)])
      await client.query('SELECT set_config($1, $2, true)', [
        'idle_in_transaction_session_timeout',
        String(Math.max(timeoutMs, 5_000)),
      ])
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (e) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* the connection is already broken; the pool will discard it */
      }
      throw toDbError(e)
    } finally {
      client.release()
    }
  }

  /**
   * Normalise a driver error. Postgres error fields are safe to surface (they
   * describe the statement, not the connection); the raw error object is not,
   * because it carries the client config.
   */
  function toDbError(e: unknown): Error {
    if (e instanceof DbBrowserError) return e
    const err = e as { code?: string; message?: string; detail?: string; hint?: string }
    if (err && typeof err.message === 'string' && err.code) {
      return new DbBrowserError(
        `PG_${err.code}`,
        err.message,
        [err.detail, err.hint].filter(Boolean).join(' — ') || undefined,
      )
    }
    if (e instanceof Error) return new DbBrowserError('DB_ERROR', e.message)
    return new DbBrowserError('DB_ERROR', 'Database operation failed')
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
    const value = await inTransaction(false, (c) => listTables(c, options.schemas))
    tableCache = { at: Date.now(), value }
    return value
  }

  async function schemaOf(ref: TableRef): Promise<TableSchema> {
    const known = resolveTable(await tables(), ref)
    const key = `${known.schema}.${known.name}`
    const cached = schemaCache.get(key)
    if (fresh(cached)) return cached.value
    const columns = await inTransaction(false, (c) =>
      describeColumns(c, { schema: known.schema, name: known.name }),
    )
    const value = buildTableSchema(
      { schema: known.schema, name: known.name },
      known.kind,
      columns,
    )
    schemaCache.set(key, { at: Date.now(), value })
    return value
  }

  /** Replace projected `octet_length(col)` numbers with a binary placeholder. */
  function decorateBinary(rows: Row[], schema: TableSchema): Row[] {
    const binaryColumns = schema.columns.filter((c) => c.isBinary)
    if (!binaryColumns.length) return rows
    return rows.map((row) => {
      const out: Row = { ...row }
      for (const c of binaryColumns) {
        const bytes = out[c.name]
        out[c.name] =
          bytes === null || bytes === undefined
            ? null
            : { __dbbBinary: true as const, bytes: Number(bytes), contentType: null }
      }
      return out
    })
  }

  const capabilities = (): DataSourceCapabilities => ({
    writes: !readOnly,
    keyset: true,
    binaryFetch: true,
    label: options.label ?? 'postgres',
  })

  return {
    id: options.id ?? `pg:${options.label ?? 'default'}`,
    capabilities,
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
        keysetAllowed: schema.updatable || schema.primaryKey.length > 0,
      })
      const built = buildSelect({
        table: schema.table,
        columns: schema.columns,
        plan,
        filters: query.filters,
        projection: query.columns,
      })
      const started = Date.now()
      const res = await inTransaction(false, (c) => c.query(built.text, built.values))
      const hasMore = res.rows.length > plan.limit
      const rows = decorateBinary(res.rows.slice(0, plan.limit) as Row[], schema)
      const last = rows[rows.length - 1]
      return {
        rows,
        columns: schema.columns,
        limit: plan.limit,
        strategy: plan.strategy,
        hasMore,
        nextCursor:
          plan.strategy === 'keyset' && last && hasMore ? cursorFromRow(last, plan.orderBy) : null,
        offset: plan.strategy === 'offset' ? plan.offset : undefined,
        totalEstimate:
          (await tables()).find(
            (t) => t.schema === schema.table.schema && t.name === schema.table.name,
          )?.rowCountEstimate ?? null,
        durationMs: Date.now() - started,
      }
    },

    async insert(table: TableRef, row: Row): Promise<Row> {
      assertWritable('INSERT')
      const schema = await schemaOf(table)
      const built = buildInsert({
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        row,
      })
      const res = await inTransaction(true, (c) => c.query(built.text, built.values))
      return (res.rows[0] ?? {}) as Row
    },

    async update(table: TableRef, pk: PkValues, patch: Row): Promise<Row> {
      assertWritable('UPDATE')
      const schema = await schemaOf(table)
      if (!schema.updatable) {
        throw new DbBrowserError('NOT_UPDATABLE', schema.notUpdatableReason ?? 'Table is not updatable')
      }
      const built = buildUpdate({
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        pk,
        patch,
      })
      const res = await inTransaction(true, (c) => c.query(built.text, built.values))
      if (res.rowCount === 0) {
        throw new DbBrowserError(
          'ROW_NOT_FOUND',
          'No row matched that primary key — it may have been deleted by someone else',
        )
      }
      if ((res.rowCount ?? 0) > 1) {
        // Cannot happen with a real PK; treated as a bug rather than ignored.
        throw new DbBrowserError('AMBIGUOUS_KEY', 'Primary key matched more than one row')
      }
      return (res.rows[0] ?? {}) as Row
    },

    async delete(table: TableRef, pk: PkValues): Promise<void> {
      assertWritable('DELETE')
      const schema = await schemaOf(table)
      if (!schema.updatable) {
        throw new DbBrowserError('NOT_UPDATABLE', schema.notUpdatableReason ?? 'Table is not updatable')
      }
      const built = buildDelete({
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        pk,
      })
      const res = await inTransaction(true, (c) => c.query(built.text, built.values))
      if (res.rowCount === 0) {
        throw new DbBrowserError('ROW_NOT_FOUND', 'No row matched that primary key')
      }
    },

    async runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
      const mode = readOnly || !opts.allowWrite ? 'read-only' : 'read-write'
      const analysis = assertSqlAllowed(sql, {
        mode,
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
          ? wrapWithLimit(stripTrailingSemicolon(single.sql), limit + 1)
          : analysis.statements.map((s) => stripTrailingSemicolon(s.sql)).join('; ')

      const started = Date.now()
      const res = await inTransaction(
        write,
        (c) => c.query({ text, rowMode: 'array' }),
        opts.timeoutMs ?? statementTimeoutMs,
      )

      const fields = res.fields ?? []
      const columns = fields.map((f) => ({
        name: f.name,
        dataType: udtNameForOid(f.dataTypeID) ?? `oid:${f.dataTypeID}`,
        category: categoryForOid(f.dataTypeID),
      }))
      const truncated = res.rows.length > limit
      const rowsArray = (res.rows as unknown[][]).slice(0, limit)
      const rows: Row[] = rowsArray.map((values) => {
        const row: Row = {}
        fields.forEach((f, i) => {
          // Duplicate column labels are legal in SQL; keep both.
          const key = row[f.name] === undefined ? f.name : `${f.name}_${i}`
          row[key] = values[i]
        })
        return row
      })

      return {
        columns,
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
      const built = buildBinaryFetch({
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        pk,
        column,
      })
      const res = await inTransaction(false, (c) => c.query(built.text, built.values))
      const row = res.rows[0] as { base64: string | null; bytes: number | null } | undefined
      if (!row) throw new DbBrowserError('ROW_NOT_FOUND', 'No row matched that primary key')
      return {
        __dbbBinary: true,
        bytes: row.bytes ?? null,
        base64: row.base64 ?? '',
        contentType: null,
      }
    },
  }
}
