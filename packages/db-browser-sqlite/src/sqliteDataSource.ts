/**
 * The SQLite `DataSource`.
 *
 * Security posture, in the same order of importance as the Postgres adapter's —
 * but the mechanisms are different, because SQLite is a *file* rather than a
 * server and almost none of Postgres's protections exist:
 *
 *  1. **Read-only by default, at the driver level.** `readOnly: true` is passed
 *     to the driver, so SQLite itself answers `attempt to write a readonly
 *     database` to anything the statement guard missed. This is the equivalent
 *     of Postgres's `BEGIN … READ ONLY`, and it is the layer that cannot be
 *     regexed around. The guard is the *first* gate, never the only one.
 *  2. **A SQLite-flavoured denylist.** The inherited Postgres denylist is the
 *     wrong shape here: `COPY … TO PROGRAM` and `pg_read_file()` do not exist,
 *     while `ATTACH`, `PRAGMA` writes, `VACUUM INTO` and `writefile()` do — and
 *     three of those reach *outside the database file*, which read-only mode
 *     does not stop. See `sql/guard.ts`'s `DIALECT_DENYLIST`.
 *  3. **Extension loading is off.** `allowExtension: false` at open time, and
 *     `load_extension` is denylisted. An extension is arbitrary native code.
 *  4. **No string-concatenated values, ever.** All CRUD goes through
 *     `sqlBuilder`, which binds values and quotes resolved identifiers.
 *  5. **Every statement is row-capped.** SQLite runs in-process and
 *     synchronously, so there is no `statement_timeout` to set and no
 *     connection to pin — the honest protection is the row cap, which is
 *     applied by wrapping the user's `SELECT`, plus the fact that a runaway
 *     query blocks this process rather than a shared server.
 *  6. **The file path never leaves the process.** `capabilities().label` is a
 *     basename, and driver messages have the path stripped.
 */

import {
  DbBrowserError,
  assertSqlAllowed,
  clampLimit,
  cursorFromRow,
  describeUpdatability,
  dimsForByteLength,
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
  DatabaseProfile,
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
import { categoryForSqliteType, isBinaryCategory } from './affinity.js'
import { openSqlite, toSqliteError } from './driver.js'
import type { SqliteDb } from './driver.js'
import { describeColumns, listTables, MAIN_SCHEMA, rowIdentityFor } from './introspect.js'
import type { SqliteTableMeta } from './introspect.js'
import { profileDatabase, vectorColumnsFor } from './profile.js'
import {
  buildBinaryFetch,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  wrapWithLimit,
} from './sqlBuilder.js'

export interface SqliteDataSourceOptions {
  /** Path to the `.db` file. Never sent to the browser. */
  filename: string
  /** Display label. Defaults to the file's basename — **never** the full path. */
  label?: string
  /** Default `true`. Enforced by SQLite itself, not only by the guard. */
  readOnly?: boolean
  /** Allow DDL when not read-only. Default `false`. */
  allowDdl?: boolean
  /** Allow `;`-chained statements. Default `false`. */
  allowMultipleStatements?: boolean
  limits?: Partial<LimitPolicy>
  /** Cache introspection for this long. Default 5000 ms. */
  introspectionTtlMs?: number
  /** Stable id used to namespace client-side state. */
  id?: string
}

interface Cached<T> {
  at: number
  value: T
}

export interface SqliteDataSource extends DataSource {
  /** Drop cached introspection — call after a rebuild. */
  invalidate(): void
  /** Release the file handle. */
  close(): void
  /** Which driver was selected, for diagnostics. */
  driver(): string
}

/** `/a/b/code-embeddings.db` → `code-embeddings.db`. Never the directory. */
function basenameOf(filename: string): string {
  const parts = filename.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || 'sqlite'
}

export async function createSqliteDataSource(
  options: SqliteDataSourceOptions,
): Promise<SqliteDataSource> {
  const {
    filename,
    readOnly = true,
    allowDdl = false,
    allowMultipleStatements = false,
    introspectionTtlMs = 5_000,
  } = options

  const label = options.label ?? basenameOf(filename)
  const policy: LimitPolicy = {
    defaultLimit: options.limits?.defaultLimit ?? 100,
    maxLimit: options.limits?.maxLimit ?? 1000,
  }

  const db: SqliteDb = await openSqlite({ filename, readOnly })

  let tableCache: Cached<SqliteTableMeta[]> | null = null
  let profileCache: Cached<DatabaseProfile> | null = null
  const schemaCache = new Map<string, Cached<TableSchema>>()

  const fresh = <T>(c: Cached<T> | null | undefined): c is Cached<T> =>
    !!c && Date.now() - c.at < introspectionTtlMs

  function run<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      throw toSqliteError(e, filename)
    }
  }

  function assertWritable(what: string): void {
    if (readOnly) {
      throw new DbBrowserError(
        'READ_ONLY',
        `${what} is blocked: this database is open in read-only mode`,
      )
    }
  }

  function tables(): SqliteTableMeta[] {
    if (fresh(tableCache)) return tableCache.value
    const value = run(() => listTables(db))
    tableCache = { at: Date.now(), value }
    return value
  }

  function profile(): DatabaseProfile {
    if (fresh(profileCache)) return profileCache.value
    const value = run(() => profileDatabase(db, tables()))
    profileCache = { at: Date.now(), value }
    return value
  }

  /**
   * Build the schema for one table, applying the **rowid fallback**.
   *
   * This is where SQLite diverges most from Postgres. `describeUpdatability`
   * (shared) implements the strict rule: no primary key means no safe `WHERE`,
   * so the table is read-only. That rule is right, and on SQLite it is also
   * too strict — an ordinary table always *has* a unique key (`rowid`) even
   * when nobody declared one, and PK-less tables are common here in a way they
   * are not in Postgres. So the shared rule is consulted first, and its verdict
   * is overridden **only** when `rowIdentityFor` found a real, unshadowed rowid
   * to key on. Views, `WITHOUT ROWID` tables and virtual tables never qualify,
   * and stay read-only with the shared rule's reason.
   */
  function schemaOf(ref: TableRef): TableSchema {
    const known = resolveTable(tables(), ref) as SqliteTableMeta
    const key = `${known.schema}.${known.name}`
    const cached = schemaCache.get(key)
    if (fresh(cached)) return cached.value

    const mode = profile().mode
    const columns = run(() =>
      describeColumns(db, known, vectorColumnsFor(mode, known.name)),
    )
    const identity = rowIdentityFor(known, columns.filter((c) => c.ordinal > 0))
    const strict = describeUpdatability({ kind: known.kind, columns })

    const value: TableSchema =
      identity.kind === 'implicit'
        ? {
            table: { schema: known.schema, name: known.name },
            columns,
            primaryKey: identity.primaryKey,
            updatable: true,
            notUpdatableReason: null,
            rowIdentity: 'implicit',
            identityNote: identity.note,
          }
        : {
            table: { schema: known.schema, name: known.name },
            columns,
            primaryKey: strict.primaryKey,
            updatable: strict.updatable,
            notUpdatableReason: strict.reason,
            rowIdentity: strict.primaryKey.length ? 'primary-key' : 'none',
            identityNote: null,
          }

    schemaCache.set(key, { at: Date.now(), value })
    return value
  }

  /**
   * Replace the projected `length(col)` numbers with a placeholder object.
   *
   * For a vector column the placeholder carries `dims`, derived from the byte
   * length (`bytes / 4`), so the grid can render `768 dims · 3.0 KB` — and so a
   * blob whose length is not a multiple of 4 shows as a plain size rather than
   * as a confidently wrong dimension count.
   */
  function decorateBinary(rows: Row[], schema: TableSchema): Row[] {
    const binaryColumns = new Map(
      schema.columns.filter((c) => c.isBinary).map((c) => [c.name, c]),
    )
    return rows.map((row) => {
      const out: Row = { ...row }
      for (const [name, value] of Object.entries(row)) {
        const column = binaryColumns.get(name)
        if (column) {
          // Declared binary: the projection already replaced the bytes with
          // `length(col)`, so the value here is the size.
          if (value === null || value === undefined) {
            out[name] = null
            continue
          }
          const size = Number(value)
          out[name] = {
            __dbbBinary: true as const,
            bytes: size,
            contentType: null,
            dims: column.category === 'vector' ? dimsForByteLength(size) : null,
          }
          continue
        }
        // Not declared binary — but SQLite's typing is *dynamic*, so a TEXT
        // column can still hold a blob and a typeless column very often does.
        // Those bytes were projected inline (nothing knew to ask for a length),
        // so they are converted here rather than reaching the grid as a
        // `Uint8Array` that `JSON.stringify` would render as `{"0":72,…}`.
        if (value instanceof Uint8Array) {
          out[name] = {
            __dbbBinary: true as const,
            bytes: value.byteLength,
            contentType: null,
            dims: null,
          }
        }
      }
      return out
    })
  }

  const capabilities = (): DataSourceCapabilities => ({
    writes: !readOnly,
    keyset: true,
    binaryFetch: true,
    label,
    dialect: 'sqlite',
    profile: true,
  })

  return {
    id: options.id ?? `sqlite:${label}`,
    capabilities,
    driver: () => db.driver,
    close: () => db.close(),

    invalidate() {
      tableCache = null
      profileCache = null
      schemaCache.clear()
    },

    async listTables(): Promise<TableMeta[]> {
      // The extra fields (`withoutRowid`, `ddl`) are dropped here: they are
      // introspection internals, and the wire type is `TableMeta`.
      return tables().map(({ schema, name, kind, rowCountEstimate, comment }) => ({
        schema,
        name,
        kind,
        rowCountEstimate,
        comment,
      }))
    },

    async describeTable(table: TableRef): Promise<TableSchema> {
      return schemaOf(table)
    },

    async describeDatabase(): Promise<DatabaseProfile> {
      return profile()
    },

    async select(query: SelectQuery): Promise<Page> {
      const schema = schemaOf(query.table)
      const limit = clampLimit(query.limit, policy)
      const plan = planPage({
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        sort: query.sort,
        cursor: query.cursor,
        offset: query.offset,
        limit,
        policy,
        keysetAllowed: schema.primaryKey.length > 0,
      })
      const built = buildSelect({
        table: schema.table,
        columns: schema.columns,
        plan,
        filters: query.filters,
        projection: query.columns,
      })
      const started = Date.now()
      const raw = run(() => db.prepare(built.text).all(...built.values)) as Row[]
      const hasMore = raw.length > plan.limit
      const rows = decorateBinary(raw.slice(0, plan.limit), schema)
      const last = rows[rows.length - 1]
      const meta = tables().find(
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
      const schema = schemaOf(table)
      const built = buildInsert({
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        row,
      })
      // SQLite has no `RETURNING` before 3.35 and node:sqlite's `run` does not
      // surface it uniformly, so the inserted row is read back by its rowid —
      // which `lastInsertRowid` gives us for free on any rowid table.
      const result = run(() => db.prepare(built.text).run(...built.values))
      const id = Number(result.lastInsertRowid)
      const back = run(() =>
        db
          .prepare(
            `SELECT * FROM "${schema.table.name.replace(/"/g, '""')}" WHERE rowid = ? LIMIT 1`,
          )
          .get(id),
      )
      return (back ?? {}) as Row
    },

    async update(table: TableRef, pk: PkValues, patch: Row): Promise<Row> {
      assertWritable('UPDATE')
      const schema = schemaOf(table)
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
      const result = run(() => db.prepare(built.text).run(...built.values))
      const changes = Number(result.changes)
      if (changes === 0) {
        throw new DbBrowserError(
          'ROW_NOT_FOUND',
          'No row matched that key — it may have been deleted by someone else',
        )
      }
      if (changes > 1) {
        // Cannot happen with a real PK or a rowid; treated as a bug rather
        // than ignored, because "we changed more rows than we meant to" is
        // exactly the failure this library exists to prevent.
        throw new DbBrowserError('AMBIGUOUS_KEY', 'The key matched more than one row')
      }
      // Read the row back through the same key the UPDATE used.
      const readBack = buildSelect({
        table: schema.table,
        columns: schema.columns,
        plan: { strategy: 'offset', orderBy: [], offset: 0, limit: 1 },
        filters: schema.primaryKey.map((name) => ({ column: name, op: 'eq' as const, value: pk[name] })),
        probeExtraRow: false,
      })
      const rows = run(() => db.prepare(readBack.text).all(...readBack.values)) as Row[]
      return decorateBinary(rows, schema)[0] ?? {}
    },

    async delete(table: TableRef, pk: PkValues): Promise<void> {
      assertWritable('DELETE')
      const schema = schemaOf(table)
      if (!schema.updatable) {
        throw new DbBrowserError('NOT_UPDATABLE', schema.notUpdatableReason ?? 'Table is not updatable')
      }
      const built = buildDelete({
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        pk,
      })
      const result = run(() => db.prepare(built.text).run(...built.values))
      if (Number(result.changes) === 0) {
        throw new DbBrowserError('ROW_NOT_FOUND', 'No row matched that key')
      }
    },

    async runQuery(sql: string, opts: RunQueryOptions = {}): Promise<QueryResult> {
      const mode = readOnly || !opts.allowWrite ? 'read-only' : 'read-write'
      const analysis = assertSqlAllowed(sql, {
        mode,
        // The SQLite denylist, not the Postgres one: ATTACH/PRAGMA/VACUUM INTO
        // and writefile()/readfile()/load_extension() are what matters here.
        dialect: 'sqlite',
        allowDdl: allowDdl && !readOnly,
        allowMultipleStatements: allowMultipleStatements && !!opts.allowMultipleStatements,
        confirmedUnqualified: false,
      })
      const limit = clampLimit(opts.limit, policy)
      const single = analysis.statements[0]
      const write = mode === 'read-write' && !analysis.readOnly
      if (write) assertWritable(single.command)

      const text = isWrappableSelect(single)
        ? wrapWithLimit(stripTrailingSemicolon(single.sql), limit + 1)
        : stripTrailingSemicolon(single.sql)

      const started = Date.now()
      return run(() => {
        const stmt = db.prepare(text)
        // `columns()` answers even for a zero-row result, so an empty result
        // set still renders its headers instead of collapsing to nothing.
        let names: string[] = []
        let declaredTypes: Array<string | null> = []
        try {
          names = stmt.columnNames()
          declaredTypes = stmt.columnTypes()
        } catch {
          // A statement that returns no result set at all (a write in
          // read-write mode) has no columns. Not an error.
        }

        const rows = names.length ? (stmt.all() as Row[]) : []
        if (!names.length) stmt.run()

        const truncated = rows.length > limit
        const capped = rows.slice(0, limit)

        return {
          columns: names.map((name, i) => {
            const declared = declaredTypes[i]
            return {
              name,
              // SQLite carries a declared type only when the column comes
              // straight from a table; an expression has none, and saying
              // `(expression)` is more honest than guessing from the value.
              dataType: declared ?? '(expression)',
              category: categoryForSqliteType(declared),
            }
          }),
          rows: capped.map((row) => {
            // Blobs in an ad-hoc result are still never inlined: the same
            // placeholder the grid uses everywhere else.
            const out: Row = {}
            for (const [k, v] of Object.entries(row)) {
              out[k] =
                v instanceof Uint8Array
                  ? {
                      __dbbBinary: true as const,
                      bytes: v.byteLength,
                      contentType: null,
                      dims: dimsForByteLength(v.byteLength),
                    }
                  : v
            }
            return out
          }),
          rowCount: capped.length,
          truncated,
          limit,
          durationMs: Date.now() - started,
          command: single.command,
        }
      })
    },

    async fetchBinary(table: TableRef, pk: PkValues, column: string): Promise<BinaryCellData> {
      const schema = schemaOf(table)
      const built = buildBinaryFetch({
        table: schema.table,
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        pk,
        column,
      })
      const row = run(() => db.prepare(built.text).get(...built.values)) as
        | { bytes: Uint8Array | null; size: number | null }
        | undefined
      if (!row) throw new DbBrowserError('ROW_NOT_FOUND', 'No row matched that key')
      const bytes = row.bytes ?? null
      const meta = schema.columns.find((c) => c.name === column) as ColumnMeta | undefined
      return {
        __dbbBinary: true,
        bytes: row.size ?? bytes?.byteLength ?? null,
        base64: bytes ? Buffer.from(bytes).toString('base64') : '',
        contentType: null,
        dims: meta?.category === 'vector' ? dimsForByteLength(row.size ?? bytes?.byteLength) : null,
      }
    },
  }
}

export { MAIN_SCHEMA, isBinaryCategory }
