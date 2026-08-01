/**
 * The bridge from database metadata to `@jugaaadi/table`'s column-type
 * registry.
 *
 * ## Why the grid's own registry is reused rather than reimplemented
 *
 * `@jugaaadi/table` already ships a `ColumnTypePreset` registry: built-in
 * presets (`text`, `number`, `decimal`, `currency`, `percent`, `date`,
 * `datetime`, `file`, `image`, `mixed`, plus a `Units` group), user-defined
 * custom presets persisted in `localStorage`, and a `subscribe`/`version` pair
 * designed for `useSyncExternalStore`. Each preset already carries the
 * `TypeOptions` that drive its editor, its formatter, its alignment and its
 * filter-operator list.
 *
 * Reimplementing any of that here would produce a *second* type system that
 * has to be kept in step with the grid's by hand, and the first thing to drift
 * would be the editors — which is the entire point. So this module does one
 * small thing: it says which **existing preset id** a `NormalizedType` should
 * open with. The grid resolves that id through its own registry
 * (`getColumnTypePreset`), so a user who defines a custom unit preset and
 * points a column at it keeps it, and a preset whose options change in the
 * grid changes here for free.
 *
 * ## Why the ids are a local string union and not an import
 *
 * `@jugaaadi/table` is a **peer** dependency of this package and a React/DOM
 * library. `@jugaaadi/db-browser/core` is imported by Node adapters that have
 * no grid, no React and no DOM, so importing the grid — even for a type —
 * would make every server-side consumer resolve it. The ids are therefore
 * declared here as data. They are asserted against the shipped
 * `BUILTIN_PRESETS` by `__tests__/columnTypes.test.ts`, so a rename in the
 * grid is a failing test rather than a silently dead mapping.
 */

import type { NormalizedType } from './normalizedTypes.js'

/**
 * The built-in preset ids `@jugaaadi/table` ships, as of `BUILTIN_PRESETS`.
 * Custom presets are user-defined and therefore not enumerable here — hence
 * the `(string & {})` tail, which keeps the literals autocompleting while
 * still accepting a custom id.
 */
export type ColumnTypePresetId =
  | 'text'
  | 'number'
  | 'decimal'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'mixed'
  | 'file'
  | 'image'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * `@jugaaadi/table`'s `ColumnType`, restated structurally. See the header for
 * why this is not an import.
 */
export type TableColumnType =
  | 'text'
  | 'number'
  | 'decimal'
  | 'currency'
  | 'file'
  | 'image'
  | 'date'
  | 'datetime'
  | 'mixed'

/** The subset of `@jugaaadi/table`'s `TypeOptions` this mapping ever sets. */
export interface TableTypeOptions {
  type?: TableColumnType
  decimals?: number
  currency?: string
  locale?: string
  suffix?: string
  dateFormat?: string
  acceptedTypes?: TableColumnType[]
}

/**
 * `NormalizedType` → the preset id a column of that type opens with.
 *
 * Every choice below is a judgement about *editing*, not about display, and
 * three of them are worth stating because the obvious answer is wrong:
 *
 *  - **`boolean` → `text`, not a checkbox.** The grid has no boolean preset,
 *    and mapping it to `number` would render `true` as `1` — which is what
 *    MySQL stores but not what Postgres returns, so the same logical column
 *    would look different per engine. `text` round-trips whatever the driver
 *    handed over.
 *  - **`binary` and `vector` → `text`, not `file`.** The `file` preset opens a
 *    file *picker*, which would invite a user to upload a replacement for a
 *    cell this library deliberately never streams inline. Binary cells arrive
 *    as a `{ __dbbBinary: true }` placeholder and are fetched one at a time on
 *    request; a text preset renders that placeholder and refuses to edit it,
 *    which is the correct affordance.
 *  - **`unknown` → `text`.** The documented fallback. A type nobody has mapped
 *    still displays, still exports and still copies; it is simply not
 *    editable as anything more specific. See `normalizedTypes.ts`.
 *
 * `integer` → `number` and `decimal` → `decimal` is the one distinction the
 * grid genuinely enforces: its `number` editor truncates its operand, so
 * routing a `numeric(10,2)` through it would silently drop the cents.
 */
export const NORMALIZED_TYPE_PRESET: Readonly<Record<NormalizedType, ColumnTypePresetId>> = {
  string: 'text',
  text: 'text',
  integer: 'number',
  decimal: 'decimal',
  boolean: 'text',
  date: 'date',
  time: 'text',
  timestamp: 'datetime',
  uuid: 'text',
  json: 'text',
  binary: 'text',
  array: 'text',
  enum: 'text',
  vector: 'text',
  unknown: 'text',
}

/**
 * The `TypeOptions` to hand the grid alongside the preset id.
 *
 * These matter where the preset alone is ambiguous: `date` and `datetime`
 * carry a format, and this library's values arrive as ISO strings from every
 * engine (Postgres renders `timestamptz` as ISO, SQLite stores whatever the
 * writer put in, MySQL's driver hands back a `Date`), so the format is pinned
 * to ISO rather than left to the locale.
 */
export const NORMALIZED_TYPE_OPTIONS: Readonly<Record<NormalizedType, TableTypeOptions>> = {
  string: { type: 'text' },
  text: { type: 'text' },
  integer: { type: 'number' },
  decimal: { type: 'decimal' },
  boolean: { type: 'text' },
  date: { type: 'date', dateFormat: 'yyyy-MM-dd' },
  time: { type: 'text' },
  timestamp: { type: 'datetime', dateFormat: 'yyyy-MM-dd HH:mm:ss' },
  uuid: { type: 'text' },
  json: { type: 'text' },
  binary: { type: 'text' },
  array: { type: 'text' },
  enum: { type: 'text' },
  vector: { type: 'text' },
  unknown: { type: 'text' },
}

/** The preset id for one normalized type. Total — never throws, never null. */
export function presetIdForNormalizedType(type: NormalizedType | undefined): ColumnTypePresetId {
  return NORMALIZED_TYPE_PRESET[type ?? 'unknown'] ?? 'text'
}

/** The grid options for one normalized type. Total. */
export function typeOptionsForNormalizedType(type: NormalizedType | undefined): TableTypeOptions {
  return NORMALIZED_TYPE_OPTIONS[type ?? 'unknown'] ?? { type: 'text' }
}

/**
 * What the grid needs to build one column, derived from metadata alone.
 *
 * `editable` is folded in here rather than left to the caller because the two
 * reasons a database column is not editable — it is generated/identity, or it
 * is a blob this library never streams inline — are both facts of the
 * metadata, and forgetting either produces an editor that throws on commit.
 */
export interface ColumnPresetResolution {
  presetId: ColumnTypePresetId
  options: TableTypeOptions
  editable: boolean
  /** Why `editable` is false, for a tooltip. Null when it is true. */
  notEditableReason: string | null
}

export interface ColumnPresetInput {
  normalizedType?: NormalizedType
  /** Generated / identity / the synthetic rowid key. */
  readOnly?: boolean
  isPrimaryKey?: boolean
}

/**
 * Resolve one column to a preset, its options, and whether it can be edited.
 *
 * A primary-key column is left **editable**: changing a PK is a legitimate,
 * if rare, operation, and the pending-changes model already makes the user
 * review it before it is committed. Only a column the *database* will refuse
 * (generated, identity, an implicit rowid) is locked here, because letting a
 * user type into one produces an error at commit rather than at edit time.
 */
export function resolveColumnPreset(column: ColumnPresetInput): ColumnPresetResolution {
  const type = column.normalizedType ?? 'unknown'
  const presetId = presetIdForNormalizedType(type)
  const options = typeOptionsForNormalizedType(type)

  if (column.readOnly) {
    return {
      presetId,
      options,
      editable: false,
      notEditableReason:
        'This column is generated by the database (identity, computed, or an implicit rowid), ' +
        'so a write to it would be rejected.',
    }
  }
  if (type === 'binary' || type === 'vector') {
    return {
      presetId,
      options,
      editable: false,
      notEditableReason:
        'Binary cells are never streamed into the grid — open the cell to fetch its bytes. ' +
        'Editing them as text would corrupt the value.',
    }
  }
  return { presetId, options, editable: true, notEditableReason: null }
}
