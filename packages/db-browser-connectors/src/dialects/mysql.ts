/**
 * The MySQL / MariaDB `Dialect`.
 *
 * **This file is the proof.** It was written after the `Dialect` interface and
 * the shared `SqlDataSource` were finished, and adding MySQL to this browser
 * required exactly three things: `descriptors/mysql.ts` (data), this file
 * (quoting, pagination, three catalog queries) and `engines/mysql.ts` (a
 * driver binding). **Nothing in `@jugaaadi/db-browser` changed.** If a future
 * engine needs a fourth kind of file, the abstraction has a hole.
 *
 * ## What is genuinely different from Postgres, and why each mattered
 *
 *  - **Backticks, not double quotes.** MySQL treats `"x"` as a string literal
 *    unless `ANSI_QUOTES` is in `sql_mode`, which this process does not
 *    control. A double-quoted column name would therefore become a constant —
 *    silently, with no error — and every row would render the same value.
 *  - **`?`, not `$n`.** So the binder is positional and the value array's
 *    *order* is the mapping. `SET` fragments must be bound before the `WHERE`.
 *  - **A "schema" is a database.** `information_schema.table_schema` holds the
 *    database name, so `qualify()` emits `` `db`.`table` `` and the descriptor
 *    declares `capabilities.schemas: false` so the sidebar does not group by a
 *    level with one member.
 *  - **`tinyint(1)` is the only boolean.** `information_schema.data_type`
 *    reports `tinyint` for both a boolean and a 0–255 counter; only
 *    `column_type` distinguishes them. Reading `column_type` is what stops a
 *    status column rendering as `true`/`false`.
 *  - **`table_rows` is an estimate that is 0 for InnoDB views** and wildly
 *    approximate otherwise, which is fine — it is labelled an estimate — but
 *    `NULL` must become `-1` ("never measured") rather than `0` ("empty").
 *  - **`LIKE` is already case-insensitive** under the default `*_ci`
 *    collations, so there is no `ILIKE` and adding one would be an error.
 *
 * **No import of `mysql2` appears in this file.** Introspection is issued
 * through the `Exec` it is handed.
 */

import { categoryForType, finalizeColumn } from '@jugaaadi/db-browser/core'
import type { ColumnMeta, TableKind, TableMeta, TableRef } from '@jugaaadi/db-browser/core'
import { mysqlDescriptor } from '../descriptors/mysql.js'
import type { ConnectorDescriptor, EngineId } from '../types.js'
import {
  createPositionalBinder,
  limitOffsetClause,
  normalizeDriverError,
  quoteBacktick,
  wrapWithLimitSql,
} from './shared.js'
import type { Dialect, Exec, ListTablesOptions, PaginationClauseInput } from './types.js'

/**
 * Databases MySQL maintains for itself. Excluded from the table list for the
 * same reason `pg_catalog` is: they are the engine's own bookkeeping, and
 * listing 80 `performance_schema` tables buries the user's own.
 *
 * `sys` is included in the exclusion even though it is technically a normal
 * schema of views — it exists solely to present `performance_schema`.
 */
const SYSTEM_SCHEMAS = ['information_schema', 'performance_schema', 'mysql', 'sys']

const KIND_BY_TABLE_TYPE: Record<string, TableKind> = {
  'BASE TABLE': 'table',
  VIEW: 'view',
  'SYSTEM VIEW': 'view',
}

/**
 * `table_schema` is bound as a parameter, and the `NOT IN` list is expanded
 * into placeholders rather than interpolated — the same rule as everywhere
 * else, applied to a query nobody types.
 */
const LIST_TABLES_SQL = `
  SELECT t.table_schema  AS \`schema\`,
         t.table_name    AS \`name\`,
         t.table_type    AS \`table_type\`,
         t.table_rows    AS \`row_count_estimate\`,
         t.table_comment AS \`comment\`
    FROM information_schema.tables t
   WHERE t.table_schema NOT IN (?, ?, ?, ?)
   ORDER BY t.table_schema, t.table_name
`

const COLUMNS_SQL = `
  SELECT c.ordinal_position           AS ordinal,
         c.column_name                AS name,
         c.data_type                  AS data_type,
         c.column_type                AS column_type,
         c.is_nullable                AS is_nullable,
         c.column_default             AS default_value,
         c.column_key                 AS column_key,
         c.extra                      AS extra,
         c.column_comment             AS comment
    FROM information_schema.columns c
   WHERE c.table_schema = ? AND c.table_name = ?
   ORDER BY c.ordinal_position
`

/**
 * Primary key from `statistics` rather than from `column_key`, because
 * `column_key` says *that* a column is part of the PK but not its **position**
 * — and a composite key addressed in the wrong order is a `WHERE` that matches
 * a different row.
 */
const PK_SQL = `
  SELECT s.column_name AS name, s.seq_in_index AS position
    FROM information_schema.statistics s
   WHERE s.table_schema = ? AND s.table_name = ? AND s.index_name = 'PRIMARY'
   ORDER BY s.seq_in_index
`

const FK_SQL = `
  SELECT k.column_name            AS \`column\`,
         k.referenced_table_schema AS f_schema,
         k.referenced_table_name   AS f_table,
         k.referenced_column_name  AS f_column,
         k.constraint_name         AS constraint_name
    FROM information_schema.key_column_usage k
   WHERE k.table_schema = ? AND k.table_name = ?
     AND k.referenced_table_name IS NOT NULL
`

/**
 * Pull the labels out of `column_type` for an `enum`/`set` column.
 *
 * `information_schema` gives them only in that string —
 * `enum('draft','sent','paid')` — so they are parsed rather than queried. The
 * split respects MySQL's `''` doubling inside a label, which is the one thing
 * a naive `split(',')` gets wrong (`enum('a,b')` is one label, not two).
 */
export function parseEnumLabels(columnType: string): string[] | null {
  const m = /^(enum|set)\s*\((.*)\)\s*$/i.exec(String(columnType ?? '').trim())
  if (!m) return null
  const body = m[2]
  const out: string[] = []
  let current = ''
  let inQuote = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inQuote) {
      if (ch === "'" && body[i + 1] === "'") {
        current += "'"
        i++
      } else if (ch === "'") {
        inQuote = false
      } else if (ch === '\\' && i + 1 < body.length) {
        current += body[i + 1]
        i++
      } else {
        current += ch
      }
      continue
    }
    if (ch === "'") {
      inQuote = true
      continue
    }
    if (ch === ',') {
      out.push(current)
      current = ''
    }
  }
  out.push(current)
  return out
}

/**
 * `tinyint(1)` — and only `tinyint(1)` — is MySQL's boolean.
 *
 * `BOOLEAN`, `BOOL` and `TINYINT(1)` are the same declaration, and
 * `information_schema.data_type` reports `tinyint` for all three *and* for a
 * `TINYINT(4)` counter. `column_type` is the only place they differ, which is
 * why it is read.
 *
 * The match is **exact**. `tinyint(1) unsigned` is not the boolean alias — the
 * `1` there is a display width on an unsigned counter, and rendering it as
 * true/false would lose every value above 1.
 */
export function isMysqlBoolean(dataType: string, columnType: string): boolean {
  return (
    String(dataType).toLowerCase() === 'tinyint' &&
    /^tinyint\(1\)$/i.test(String(columnType ?? '').trim())
  )
}

/** `NULL`/absent means "never measured", which is -1, not 0. */
function rowEstimate(value: unknown): number {
  if (value === null || value === undefined) return -1
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : -1
}

export function createMysqlDialect(
  id: EngineId = 'mysql',
  descriptor: ConnectorDescriptor = mysqlDescriptor,
): Dialect {
  const quote = (name: string) => quoteBacktick(name, 64)

  return {
    id,
    descriptor,
    sqlDialect: id === 'mariadb' ? 'mariadb' : 'mysql',
    requiresOrderByForOffset: false,

    createBinder: createPositionalBinder,
    quoteIdent: quote,
    qualify: (ref: TableRef) =>
      ref.schema ? `${quote(ref.schema)}.${quote(ref.name)}` : quote(ref.name),

    // MySQL spells the cast `CHAR`, not `TEXT` — `CAST(x AS TEXT)` is a syntax
    // error there, which is exactly the kind of thing that makes a "generic"
    // SQL builder produce statements no engine accepts.
    castToText: (expr: string) => `CAST(${expr} AS CHAR)`,

    // No `ILIKE`: MySQL's `LIKE` is case-insensitive under the default
    // `utf8mb4_0900_ai_ci` / `latin1_swedish_ci` collations. Adding an `ILIKE`
    // would be a syntax error; adding a `LOWER()` on both sides would defeat
    // any index on the column.
    likePredicate: (expr, placeholder) => `${expr} LIKE ${placeholder} ESCAPE '\\\\'`,

    // No array type, so `IN` is expanded to one placeholder per value — still
    // bound, never interpolated. `IN ()` is a syntax error and an empty set
    // matches nothing, hence the literal `0`.
    inPredicate: (expr, values, binder) =>
      values.length ? `${expr} IN (${values.map((v) => binder.bind(v)).join(', ')})` : '0',

    // `LENGTH()` is bytes; `CHAR_LENGTH()` is characters. A blob wants bytes.
    byteLengthExpr: (expr) => `LENGTH(${expr})`,
    base64Expr: (expr) => `TO_BASE64(${expr})`,

    paginationClause: (input: PaginationClauseInput) => limitOffsetClause(input),
    wrapWithLimit: (sql, limit) => wrapWithLimitSql(sql, limit, 'LIMIT'),

    // MySQL's equivalent of `BEGIN READ ONLY`. Like Postgres's, the server
    // itself then refuses a write the guard let through.
    beginReadOnly: ['START TRANSACTION READ ONLY'],
    beginWrite: ['START TRANSACTION'],
    commit: 'COMMIT',
    rollback: 'ROLLBACK',

    async defaultSchema(exec: Exec): Promise<string> {
      const res = await exec('SELECT DATABASE() AS s')
      return String(res.rows[0]?.s ?? '')
    },

    async listTables(exec: Exec, options: ListTablesOptions = {}): Promise<TableMeta[]> {
      const res = await exec(LIST_TABLES_SQL, SYSTEM_SCHEMAS)
      const allowed = options.schemas?.length ? new Set(options.schemas) : null
      return res.rows
        .filter((r) => !allowed || allowed.has(String(r.schema)))
        .map((r) => ({
          schema: String(r.schema),
          name: String(r.name),
          kind: KIND_BY_TABLE_TYPE[String(r.table_type)] ?? 'table',
          rowCountEstimate: rowEstimate(r.row_count_estimate),
          comment: (r.comment as string | null) || null,
        }))
    },

    async describeColumns(exec: Exec, table: TableRef): Promise<ColumnMeta[]> {
      const args = [table.schema, table.name]
      const [cols, pks, fks] = await Promise.all([
        exec(COLUMNS_SQL, args),
        exec(PK_SQL, args),
        exec(FK_SQL, args),
      ])

      const pkByName = new Map<string, number>()
      for (const r of pks.rows) pkByName.set(String(r.name), Number(r.position))

      const fkByName = new Map<
        string,
        { schema: string; table: string; column: string; constraint: string }
      >()
      for (const r of fks.rows) {
        fkByName.set(String(r.column), {
          schema: String(r.f_schema ?? table.schema),
          table: String(r.f_table),
          column: String(r.f_column),
          constraint: String(r.constraint_name),
        })
      }

      return cols.rows.map((r) => {
        const dataType = String(r.data_type ?? '').toLowerCase()
        const columnType = String(r.column_type ?? '')
        const enumValues = parseEnumLabels(columnType)
        const boolean = isMysqlBoolean(dataType, columnType)

        // `extra` carries `auto_increment`, `DEFAULT_GENERATED`,
        // `VIRTUAL GENERATED` and `STORED GENERATED`. Only the *generated*
        // ones are unwritable — `auto_increment` is writable, and refusing it
        // would make inserting an explicit id impossible.
        const extra = String(r.extra ?? '').toUpperCase()
        const generated = extra.includes('GENERATED') && !extra.includes('DEFAULT_GENERATED')

        const category = boolean
          ? ('boolean' as const)
          : categoryForType(dataType, columnType, enumValues)

        return finalizeColumn(
          {
            name: String(r.name),
            // `column_type` is the human form (`varchar(255)`, `enum(…)`);
            // `data_type` is the base name and the type-map key. Both are
            // kept, which is exactly the `dataType`/`dbType` split.
            dataType: columnType || dataType,
            udtName: dataType,
            dbType: dataType,
            category,
            nullable: String(r.is_nullable).toUpperCase() === 'YES',
            isPrimaryKey: pkByName.has(String(r.name)),
            primaryKeyPosition: pkByName.get(String(r.name)) ?? null,
            foreignKey: fkByName.get(String(r.name)) ?? null,
            defaultValue: (r.default_value as string | null) ?? null,
            ordinal: Number(r.ordinal),
            enumValues,
            isBinary: category === 'binary',
            comment: (r.comment as string | null) || null,
            readOnly: generated,
            // See the header: `tinyint` maps to `integer` in the type map on
            // purpose, and only `column_type` can override it here.
            ...(boolean ? { normalizedType: 'boolean' as const } : {}),
            ...(enumValues && dataType === 'enum' ? { normalizedType: 'enum' as const } : {}),
          },
          descriptor.typeMap,
        )
      })
    },

    toError: (e: unknown) => normalizeDriverError(e, 'MYSQL'),
  }
}
