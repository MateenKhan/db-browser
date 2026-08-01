/**
 * The Postgres `Dialect`.
 *
 * This is the reference implementation of the strategy, and it is a *port* of
 * `@jugaaadi/db-browser-pg`'s hand-written SQL rather than a rewrite: the
 * catalog queries below are the ones that were already verified against a real
 * database, moved behind the interface so MySQL could be added next to them
 * instead of alongside them.
 *
 * CockroachDB reuses it wholesale (`dialectFor('cockroach')`), which is the
 * point of separating `EngineId` from `SqlDialect`.
 */

import { categoryForType, finalizeColumn } from '@jugaaadi/db-browser/core'
import type { ColumnMeta, TableKind, TableMeta, TableRef } from '@jugaaadi/db-browser/core'
import { postgresDescriptor } from '../descriptors/postgres.js'
import type { ConnectorDescriptor, EngineId } from '../types.js'
import {
  createNumberedBinder,
  limitOffsetClause,
  normalizeDriverError,
  quoteDoubleQuoted,
  wrapWithLimitSql,
} from './shared.js'
import type { Dialect, Exec, ListTablesOptions, PaginationClauseInput } from './types.js'

const KIND_BY_RELKIND: Record<string, TableKind> = {
  r: 'table',
  p: 'partitioned',
  v: 'view',
  m: 'matview',
  f: 'foreign',
}

const DEFAULT_EXCLUDED_SCHEMAS = ['pg_catalog', 'information_schema']

const LIST_TABLES_SQL = `
  SELECT n.nspname                       AS schema,
         c.relname                       AS name,
         c.relkind                       AS relkind,
         c.reltuples::float8             AS row_count_estimate,
         obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND n.nspname <> ALL ($1::text[])
     AND n.nspname NOT LIKE 'pg_toast%'
     AND n.nspname NOT LIKE 'pg_temp%'
     AND ($2::text[] IS NULL OR n.nspname = ANY ($2::text[]))
   ORDER BY n.nspname, c.relname
`

const COLUMNS_SQL = `
  SELECT a.attnum                                            AS ordinal,
         a.attname                                           AS name,
         format_type(a.atttypid, a.atttypmod)                AS data_type,
         t.typname                                           AS udt_name,
         NOT a.attnotnull                                    AS nullable,
         pg_get_expr(d.adbin, d.adrelid)                     AS default_value,
         (a.attidentity <> '' OR a.attgenerated <> '')       AS generated,
         col_description(a.attrelid, a.attnum)               AS comment,
         (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
            FROM pg_enum e
           WHERE e.enumtypid = t.oid)                        AS enum_values
    FROM pg_attribute a
    JOIN pg_class c      ON c.oid = a.attrelid
    JOIN pg_type t       ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.oid = $1::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY a.attnum
`

const PK_SQL = `
  SELECT a.attname AS name, k.ord AS position
    FROM pg_constraint con
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
   WHERE con.contype = 'p'
     AND con.conrelid = $1::regclass
   ORDER BY k.ord
`

const FK_SQL = `
  SELECT att.attname   AS column,
         fn.nspname    AS f_schema,
         fc.relname    AS f_table,
         fatt.attname  AS f_column,
         con.conname   AS constraint_name
    FROM pg_constraint con
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord)
    JOIN pg_attribute att  ON att.attrelid = con.conrelid  AND att.attnum = k.attnum
    JOIN pg_class fc       ON fc.oid = con.confrelid
    JOIN pg_namespace fn   ON fn.oid = fc.relnamespace
    JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = k.fattnum
   WHERE con.contype = 'f'
     AND con.conrelid = $1::regclass
`

/** Tolerate a driver that hands back `{a,b}` instead of a parsed array. */
function toStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.startsWith('{')) {
    const inner = value.slice(1, -1)
    return inner ? inner.split(',').map((s) => s.replace(/^"|"$/g, '')) : []
  }
  return null
}

export function createPostgresDialect(
  id: EngineId = 'postgres',
  descriptor: ConnectorDescriptor = postgresDescriptor,
): Dialect {
  const quote = (name: string) => quoteDoubleQuoted(name, 63)

  return {
    id,
    descriptor,
    sqlDialect: 'postgres',
    requiresOrderByForOffset: false,

    createBinder: createNumberedBinder,
    quoteIdent: quote,
    qualify: (ref: TableRef) => `${quote(ref.schema)}.${quote(ref.name)}`,
    castToText: (expr: string) => `${expr}::text`,

    // `ILIKE` is Postgres's own case-insensitive LIKE. The explicit `ESCAPE`
    // is what makes `likeLiteral`'s backslashes mean "a literal %" rather than
    // being consumed by the default escape rules.
    likePredicate: (expr, placeholder) => `${expr} ILIKE ${placeholder} ESCAPE '\\'`,

    // One parameter for the whole list, rather than N placeholders — Postgres
    // is the only engine here that can, and it keeps a 500-value `IN` from
    // producing a 500-placeholder statement.
    inPredicate: (expr, values, binder) =>
      values.length ? `${expr} = ANY (${binder.bind(values)})` : 'false',

    byteLengthExpr: (expr) => `octet_length(${expr})`,
    base64Expr: (expr) => `encode(${expr}, 'base64')`,

    paginationClause: (input: PaginationClauseInput) => limitOffsetClause(input),
    wrapWithLimit: (sql, limit) => wrapWithLimitSql(sql, limit, 'LIMIT'),

    // The layer that cannot be regexed around: Postgres itself refuses a write
    // inside a read-only transaction, whatever the guard let through.
    beginReadOnly: ['BEGIN READ ONLY'],
    beginWrite: ['BEGIN'],
    commit: 'COMMIT',
    rollback: 'ROLLBACK',

    async defaultSchema(exec: Exec): Promise<string> {
      const res = await exec('SELECT current_schema() AS s')
      return String(res.rows[0]?.s ?? 'public')
    },

    async listTables(exec: Exec, options: ListTablesOptions = {}): Promise<TableMeta[]> {
      const res = await exec(LIST_TABLES_SQL, [
        DEFAULT_EXCLUDED_SCHEMAS,
        options.schemas && options.schemas.length ? options.schemas : null,
      ])
      return res.rows.map((r) => ({
        schema: String(r.schema),
        name: String(r.name),
        kind: KIND_BY_RELKIND[String(r.relkind)] ?? 'table',
        // `reltuples` is -1 on a never-analysed relation; keep that signal
        // rather than rendering it as zero rows.
        rowCountEstimate: Math.round(Number(r.row_count_estimate ?? -1)),
        comment: (r.comment as string | null) ?? null,
      }))
    },

    async describeColumns(exec: Exec, table: TableRef): Promise<ColumnMeta[]> {
      // `regclass` takes the *quoted* name as a bound value, so the table name
      // is a parameter here rather than concatenated SQL.
      const oid = `${quote(table.schema)}.${quote(table.name)}`
      const [cols, pks, fks] = await Promise.all([
        exec(COLUMNS_SQL, [oid]),
        exec(PK_SQL, [oid]),
        exec(FK_SQL, [oid]),
      ])

      const pkByName = new Map<string, number>()
      for (const r of pks.rows) pkByName.set(String(r.name), Number(r.position))

      const fkByName = new Map<
        string,
        { schema: string; table: string; column: string; constraint: string }
      >()
      for (const r of fks.rows) {
        fkByName.set(String(r.column), {
          schema: String(r.f_schema),
          table: String(r.f_table),
          column: String(r.f_column),
          constraint: String(r.constraint_name),
        })
      }

      return cols.rows.map((r) => {
        const udtName = String(r.udt_name)
        const dataType = String(r.data_type)
        const enumValues = toStringArray(r.enum_values)
        const category = categoryForType(udtName, dataType, enumValues)
        return finalizeColumn(
          {
            name: String(r.name),
            dataType,
            udtName,
            category,
            nullable: Boolean(r.nullable),
            isPrimaryKey: pkByName.has(String(r.name)),
            primaryKeyPosition: pkByName.get(String(r.name)) ?? null,
            foreignKey: fkByName.get(String(r.name)) ?? null,
            defaultValue: (r.default_value as string | null) ?? null,
            ordinal: Number(r.ordinal),
            enumValues,
            isBinary: category === 'binary',
            comment: (r.comment as string | null) ?? null,
            readOnly: Boolean(r.generated),
            // An enum column's `typname` is the *enum type's* name, which no
            // type map can enumerate — so the normalized type is pinned here
            // from the fact that labels came back, rather than being looked up
            // and landing on `unknown`.
            ...(enumValues && enumValues.length ? { normalizedType: 'enum' as const } : {}),
          },
          descriptor.typeMap,
        )
      })
    },

    toError: (e: unknown) => normalizeDriverError(e, 'PG'),
  }
}
