/**
 * Live schema introspection.
 *
 * Everything the console knows about a database comes from here, and *only*
 * from here: table and column names used to build SQL are resolved against
 * these results, so a name the server never reported can never reach a
 * statement. See `@jugaaadi/db-browser/core`'s `identifiers.ts` for the other
 * half of that rule.
 */

import type { PoolClient } from 'pg'
import { categoryForType, finalizeColumn, quoteIdent } from '@jugaaadi/db-browser/core'
import { POSTGRES_TYPE_MAP } from '@jugaaadi/db-browser-connectors'
import type { ColumnMeta, TableKind, TableMeta, TableRef } from '@jugaaadi/db-browser/core'

const KIND_BY_RELKIND: Record<string, TableKind> = {
  r: 'table',
  p: 'partitioned',
  v: 'view',
  m: 'matview',
  f: 'foreign',
}

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

const DEFAULT_EXCLUDED_SCHEMAS = ['pg_catalog', 'information_schema']

export async function listTables(
  client: PoolClient,
  includeSchemas?: readonly string[] | null,
): Promise<TableMeta[]> {
  const res = await client.query(LIST_TABLES_SQL, [
    DEFAULT_EXCLUDED_SCHEMAS,
    includeSchemas && includeSchemas.length ? includeSchemas : null,
  ])
  return res.rows.map((r: Record<string, unknown>) => ({
    schema: String(r.schema),
    name: String(r.name),
    kind: KIND_BY_RELKIND[String(r.relkind)] ?? 'table',
    // reltuples is -1 on a never-analysed relation; keep that signal.
    rowCountEstimate: Math.round(Number(r.row_count_estimate ?? -1)),
    comment: (r.comment as string | null) ?? null,
  }))
}

const COLUMNS_SQL = `
  SELECT a.attnum                                            AS ordinal,
         a.attname                                           AS name,
         format_type(a.atttypid, a.atttypmod)                AS data_type,
         t.typname                                           AS udt_name,
         t.typtype                                           AS typtype,
         NOT a.attnotnull                                    AS nullable,
         pg_get_expr(d.adbin, d.adrelid)                     AS default_value,
         (a.attidentity <> '' OR a.attgenerated <> '')       AS generated,
         col_description(a.attrelid, a.attnum)               AS comment,
         -- ::text is load-bearing: array_agg over enumlabel (type name) comes
         -- back as an unparsed literal through node-pg; text[] parses.
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

/**
 * `regclass` takes the *quoted* name as a bound value, so the table name is
 * still a parameter here — not string-concatenated SQL.
 */
export function regclassLiteral(table: TableRef): string {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
}

/** Tolerate a driver that hands back `{a,b}` instead of a parsed array. */
function toStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.startsWith('{')) {
    const inner = value.slice(1, -1)
    return inner ? inner.split(',').map((s) => s.replace(/^"|"$/g, '')) : []
  }
  return null
}

export async function describeColumns(client: PoolClient, table: TableRef): Promise<ColumnMeta[]> {
  const oid = regclassLiteral(table)
  const [cols, pks, fks] = await Promise.all([
    client.query(COLUMNS_SQL, [oid]),
    client.query(PK_SQL, [oid]),
    client.query(FK_SQL, [oid]),
  ])

  const pkByName = new Map<string, number>()
  for (const r of pks.rows as Array<Record<string, unknown>>) {
    pkByName.set(String(r.name), Number(r.position))
  }
  const fkByName = new Map<string, { schema: string; table: string; column: string; constraint: string }>()
  for (const r of fks.rows as Array<Record<string, unknown>>) {
    fkByName.set(String(r.column), {
      schema: String(r.f_schema),
      table: String(r.f_table),
      column: String(r.f_column),
      constraint: String(r.constraint_name),
    })
  }

  return (cols.rows as Array<Record<string, unknown>>).map((r) => {
    const udtName = String(r.udt_name)
    const dataType = String(r.data_type)
    const enumValues = toStringArray(r.enum_values)
    const category = categoryForType(udtName, dataType, enumValues)
    // `finalizeColumn` fills the metadata-driven half (`dbType`,
    // `normalizedType`, `isForeignKey`, `references`) from the descriptor's
    // type map, so both vocabularies always agree. See core's `schema.ts`.
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
        // An enum's `typname` is the enum *type's* name, which no type map can
        // enumerate — so it is pinned from the fact that labels came back.
        ...(enumValues && enumValues.length ? { normalizedType: 'enum' as const } : {}),
      },
      POSTGRES_TYPE_MAP,
    )
  })
}
