/**
 * Schema helpers shared by adapters and the UI: mapping a SQL type to a render
 * category, and deciding whether a table's rows can be safely written back.
 */

import type { ColumnMeta, TableKind, TableSchema, ValueCategory } from './types.js'
import { normalizedTypeFor } from './metadata/normalizedTypes.js'
import type { NormalizedType } from './metadata/normalizedTypes.js'

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

/**
 * The bridge in the *other* direction: a `ValueCategory` to a
 * `NormalizedType`.
 *
 * This is the safety net, not the main path. The main path is a connector
 * descriptor's `typeMap`, which knows the engine's own spellings. This one
 * exists so an adapter that predates descriptors — or a `DataSource` a
 * consumer wrote themselves — still produces a populated `normalizedType`
 * instead of leaving the field undefined for the grid to trip over.
 *
 * Two categories have no exact counterpart and are mapped deliberately:
 * `interval` becomes `'string'` (it is rendered and edited as its text form,
 * e.g. `1 day 02:00:00`, because no engine agrees on a numeric encoding), and
 * `other` becomes `'unknown'`, which is the same "display it, do not pretend
 * to understand it" contract.
 */
const CATEGORY_TO_NORMALIZED: Record<ValueCategory, NormalizedType> = {
  number: 'decimal',
  string: 'string',
  boolean: 'boolean',
  date: 'date',
  time: 'time',
  timestamp: 'timestamp',
  interval: 'string',
  json: 'json',
  uuid: 'uuid',
  array: 'array',
  enum: 'enum',
  binary: 'binary',
  vector: 'vector',
  other: 'unknown',
}

export function normalizedTypeForCategory(category: ValueCategory | undefined): NormalizedType {
  return CATEGORY_TO_NORMALIZED[category ?? 'other'] ?? 'unknown'
}

/**
 * Fill in every derived field on a column so both vocabularies always agree.
 *
 * Adapters build the engine-specific half (`name`, `dataType`, `udtName`,
 * `category`, keys, defaults) and hand it here; this fills `dbType`,
 * `normalizedType`, `isForeignKey` and `references`. Doing it in one shared
 * place is what stops the two vocabularies drifting — the alternative is four
 * adapters each remembering to set six fields, and the first one to forget
 * ships a column the grid cannot type.
 *
 * `typeMap` is the connector descriptor's. When it is absent, or when it does
 * not know this type, `category` is used as the fallback rather than jumping
 * straight to `'unknown'`: the category was computed from the same raw name by
 * engine-specific code that may well know better than a generic dictionary
 * (SQLite's affinity rules are the worked example).
 */
export function finalizeColumn(
  column: Omit<ColumnMeta, 'dbType' | 'normalizedType' | 'isForeignKey'> &
    Partial<Pick<ColumnMeta, 'dbType' | 'normalizedType' | 'isForeignKey'>>,
  typeMap?: Readonly<Record<string, NormalizedType>>,
): ColumnMeta {
  const dbType = (column.dbType ?? column.udtName ?? column.dataType ?? '').toLowerCase()
  const mapped = column.normalizedType ?? (typeMap ? normalizedTypeFor(dbType, typeMap) : 'unknown')
  const normalizedType =
    mapped === 'unknown' ? normalizedTypeForCategory(column.category) : mapped
  const fk = column.foreignKey ?? null
  return {
    ...column,
    dbType,
    normalizedType,
    isForeignKey: column.isForeignKey ?? fk !== null,
    references:
      column.references ?? (fk ? { table: fk.table, column: fk.column } : null),
  }
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
  if (input.kind === 'virtual') {
    // A virtual table's rows are produced by an extension module (FTS5,
    // R*Tree), and its shadow tables are that module's private storage. Both
    // accept writes in principle, and both can be corrupted by one, because the
    // module's invariants are not expressed as constraints the database will
    // enforce on your behalf. A declared PRIMARY KEY on a shadow table does not
    // change that, which is why this is checked *before* the key rule.
    return {
      updatable: false,
      primaryKey,
      reason:
        'This is a virtual table, or the internal storage of one. Its rows are maintained by an ' +
        'extension module, so writing to it directly can corrupt the index it backs.',
    }
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
