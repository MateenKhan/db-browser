/**
 * Schema helpers shared by adapters and the UI: mapping a SQL type to a render
 * category, and deciding whether a table's rows can be safely written back.
 */

import type { ColumnMeta, TableKind, TableSchema, ValueCategory } from './types.js'

const NUMERIC = new Set([
  'int2', 'int4', 'int8', 'smallint', 'integer', 'bigint', 'decimal', 'numeric',
  'real', 'float4', 'float8', 'double precision', 'money', 'oid',
])
const STRINGY = new Set(['text', 'varchar', 'bpchar', 'char', 'character varying', 'name', 'citext'])
const BOOLEANS = new Set(['bool', 'boolean'])
const DATES = new Set(['date'])
const TIMES = new Set(['time', 'timetz', 'time without time zone', 'time with time zone'])
const TIMESTAMPS = new Set([
  'timestamp', 'timestamptz', 'timestamp without time zone', 'timestamp with time zone',
])
const JSONS = new Set(['json', 'jsonb'])
const UUIDS = new Set(['uuid'])
const BINARY = new Set(['bytea', 'oid_blob', 'blob'])
const INTERVALS = new Set(['interval'])

/**
 * Bucket a column type. `udtName` is preferred (`_text` for `text[]`, the enum
 * type name for an enum); `dataType` is the human form and is used as a
 * fallback and to spot `ARRAY`/`USER-DEFINED`.
 */
export function categoryForType(
  udtName: string | undefined,
  dataType?: string,
  enumValues?: readonly string[] | null,
): ValueCategory {
  const udt = (udtName ?? '').toLowerCase()
  const dt = (dataType ?? '').toLowerCase()
  if (enumValues && enumValues.length) return 'enum'
  if (udt.startsWith('_') || dt === 'array') return 'array'
  if (NUMERIC.has(udt) || NUMERIC.has(dt)) return 'number'
  if (BOOLEANS.has(udt) || BOOLEANS.has(dt)) return 'boolean'
  if (TIMESTAMPS.has(udt) || TIMESTAMPS.has(dt)) return 'timestamp'
  if (DATES.has(udt) || DATES.has(dt)) return 'date'
  if (TIMES.has(udt) || TIMES.has(dt)) return 'time'
  if (INTERVALS.has(udt) || INTERVALS.has(dt)) return 'interval'
  if (JSONS.has(udt) || JSONS.has(dt)) return 'json'
  if (UUIDS.has(udt) || UUIDS.has(dt)) return 'uuid'
  if (BINARY.has(udt) || BINARY.has(dt)) return 'binary'
  if (STRINGY.has(udt) || dt.startsWith('character')) return 'string'
  return 'other'
}

/** Primary-key column names in key order. */
export function primaryKeyOf(columns: readonly ColumnMeta[]): string[] {
  return columns
    .filter((c) => c.isPrimaryKey)
    .slice()
    .sort((a, b) => (a.primaryKeyPosition ?? 0) - (b.primaryKeyPosition ?? 0))
    .map((c) => c.name)
}

export interface UpdatabilityInput {
  kind: TableKind
  columns: readonly ColumnMeta[]
}

export interface Updatability {
  updatable: boolean
  primaryKey: string[]
  reason: string | null
}

/**
 * A row can only be updated when there is a key that identifies exactly one
 * row. Without one the only `WHERE` available is "every column equals its old
 * value", which:
 *
 *  - matches *every* duplicate row, not the one you edited;
 *  - cannot express NULLs without `IS NOT DISTINCT FROM`; and
 *  - silently updates 0 rows when another session changed the row first.
 *
 * So PK-less tables and views are surfaced as **read-only with a reason**
 * rather than written to on a guess.
 */
export function describeUpdatability(input: UpdatabilityInput): Updatability {
  const primaryKey = primaryKeyOf(input.columns)
  if (input.kind === 'view' || input.kind === 'matview') {
    return {
      updatable: false,
      primaryKey,
      reason:
        input.kind === 'matview'
          ? 'Materialized views cannot be written to — refresh the view instead.'
          : 'This is a view. Editing is disabled because a view has no guaranteed row identity.',
    }
  }
  if (input.kind === 'foreign') {
    return { updatable: false, primaryKey, reason: 'Foreign tables are opened read-only.' }
  }
  if (!primaryKey.length) {
    return {
      updatable: false,
      primaryKey,
      reason:
        'This table has no primary key, so a row cannot be addressed unambiguously. ' +
        'Editing is disabled rather than issuing a WHERE across every column, which ' +
        'would match duplicate rows.',
    }
  }
  return { updatable: true, primaryKey, reason: null }
}

/** Build a `TableSchema` from raw columns. */
export function buildTableSchema(
  table: { schema: string; name: string },
  kind: TableKind,
  columns: ColumnMeta[],
): TableSchema {
  const u = describeUpdatability({ kind, columns })
  return {
    table: { schema: table.schema, name: table.name },
    columns,
    primaryKey: u.primaryKey,
    updatable: u.updatable,
    notUpdatableReason: u.reason,
  }
}

/** Stable per-row identity string, used as a React key and edit key. */
export function rowKeyOf(row: Record<string, unknown>, primaryKey: readonly string[]): string | null {
  if (!primaryKey.length) return null
  const parts: unknown[] = []
  for (const col of primaryKey) {
    const v = row[col]
    if (v === undefined) return null
    parts.push(v === null ? null : String(v))
  }
  return JSON.stringify(parts)
}
