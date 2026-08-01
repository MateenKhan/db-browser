/**
 * SQL construction for SQLite.
 *
 * The one rule this module exists to enforce is the same one the Postgres
 * builder enforces: **identifiers are resolved and quoted, values are bound.**
 * Every function returns `{ text, values }` and there is no code path that
 * renders a user value into `text`.
 *
 * Four things differ from the Postgres builder, and none of them is cosmetic:
 *
 *  1. **Placeholders are `?`, positional by order of appearance** — not `$n`.
 *     So `Binder` must append values in exactly the order the fragments are
 *     concatenated, which is why the keyset predicate binds through the same
 *     binder rather than pre-computing its own list.
 *  2. **No `::text` cast.** SQLite spells it `CAST(x AS TEXT)`, and `ILIKE`
 *     does not exist at all: `LIKE` is already case-insensitive for ASCII.
 *  3. **No `= ANY (array)`.** SQLite has no array type, so `IN` is expanded to
 *     one placeholder per value — still bound, never interpolated.
 *  4. **`length()` replaces `octet_length()`** for the blob-size projection.
 *     On a BLOB, SQLite's `length()` returns bytes; on TEXT it returns
 *     *characters*, which is why it is only ever applied to a column
 *     introspection reported as binary.
 */

import {
  DbBrowserError,
  keysetPredicate,
  quoteIdent,
  resolveColumn,
} from '@jugaaadi/db-browser/core'
import type { ColumnMeta, Filter, PagePlan, PkValues, Row, TableRef } from '@jugaaadi/db-browser/core'
import { ROWID_ALIASES } from './introspect.js'

export interface BuiltQuery {
  text: string
  values: unknown[]
}

/**
 * Allocates `?` placeholders. Unlike the Postgres `$n` binder, position is
 * implicit — the nth `?` in the finished statement takes the nth value — so
 * `values` must be appended in the same order the SQL is assembled.
 */
export class Binder {
  readonly values: unknown[] = []
  bind = (value: unknown): string => {
    this.values.push(value)
    return '?'
  }
}

/**
 * `"schema"."table"`. SQLite's "schema" is a database name (`main`, `temp`, or
 * an `ATTACH` alias); qualifying is still correct and keeps a table called
 * `main` from being ambiguous.
 */
export function quoteQualified(ref: TableRef): string {
  return `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`
}

const COMPARISON: Record<string, string> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
}

/** Escape LIKE metacharacters so a user substring stays literal. */
function likeLiteral(value: unknown): string {
  return String(value ?? '').replace(/([\\%_])/g, '\\$1')
}

/**
 * Resolve a column, accepting the implicit rowid aliases even though they are
 * not in `table_info`. Without this, a filter or sort on the synthetic rowid
 * key would be rejected as an unknown column.
 */
function resolveOrRowid(columns: readonly ColumnMeta[], name: string): string {
  if ((ROWID_ALIASES as readonly string[]).includes(name.toLowerCase())) {
    const shadowed = columns.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.ordinal > 0)
    if (!shadowed) return name.toLowerCase()
  }
  return resolveColumn(columns, name).name
}

export function buildFilter(
  filter: Filter,
  columns: readonly ColumnMeta[],
  binder: Binder,
): string {
  const q = quoteIdent(resolveOrRowid(columns, filter.column))
  switch (filter.op) {
    case 'isNull':
      return `${q} IS NULL`
    case 'isNotNull':
      return `${q} IS NOT NULL`
    // `CAST(… AS TEXT)` because SQLite is dynamically typed: a column with
    // INTEGER affinity can hold a string and vice versa, so "contains" has to
    // be asked of the value's text form, not the column's declared type.
    case 'contains':
      return `CAST(${q} AS TEXT) LIKE ${binder.bind(`%${likeLiteral(filter.value)}%`)} ESCAPE '\\'`
    case 'startsWith':
      return `CAST(${q} AS TEXT) LIKE ${binder.bind(`${likeLiteral(filter.value)}%`)} ESCAPE '\\'`
    case 'endsWith':
      return `CAST(${q} AS TEXT) LIKE ${binder.bind(`%${likeLiteral(filter.value)}`)} ESCAPE '\\'`
    case 'in': {
      const list = filter.values ?? []
      // `IN ()` is a syntax error in SQLite, and an empty set matches nothing.
      if (!list.length) return '0'
      return `${q} IN (${list.map((v) => binder.bind(v)).join(', ')})`
    }
    default: {
      const op = COMPARISON[filter.op]
      if (!op) throw new DbBrowserError('BAD_FILTER', `Unsupported filter operator: ${filter.op}`)
      if (filter.value === null) return filter.op === 'eq' ? `${q} IS NULL` : `${q} IS NOT NULL`
      return `${q} ${op} ${binder.bind(filter.value)}`
    }
  }
}

export interface SelectBuildInput {
  table: TableRef
  columns: readonly ColumnMeta[]
  plan: PagePlan
  filters?: readonly Filter[]
  projection?: readonly string[]
  probeExtraRow?: boolean
}

/**
 * Binary and vector columns are projected as `length(col)` — never as bytes.
 *
 * For the embedding store this is not an optimisation, it is the difference
 * between a working page and a hang: 100 rows × 768 float32s is 300 KB of
 * base64 per page for a value that renders as `768 dims · 3.0 KB`. The size is
 * all the grid ever needs; the bytes are fetched one cell at a time, on
 * request, through `fetchBinary`.
 */
export function projectionFor(columns: readonly ColumnMeta[], only?: readonly string[]): string {
  const wanted = only?.length ? only.map((n) => resolveColumn(columns, n)) : columns
  return wanted
    .map((c) => {
      const q = quoteIdent(c.name)
      if (c.isBinary) return `length(${q}) AS ${q}`
      // The implicit rowid is `ordinal: 0` and is not a real column, so it is
      // named bare rather than being looked up — SQLite resolves the alias.
      return q
    })
    .join(', ')
}

export function buildSelect(input: SelectBuildInput): BuiltQuery {
  const binder = new Binder()
  const where: string[] = []

  for (const f of input.filters ?? []) {
    where.push(buildFilter(f, input.columns, binder))
  }
  if (input.plan.keyset?.terms.length) {
    where.push(
      keysetPredicate(
        input.plan.keyset.terms,
        (name) => quoteIdent(resolveOrRowid(input.columns, name)),
        binder.bind,
      ),
    )
  }

  const orderBy = input.plan.orderBy
    .map(
      (t) =>
        `${quoteIdent(resolveOrRowid(input.columns, t.column))} ${t.direction === 'desc' ? 'DESC' : 'ASC'}`,
    )
    .join(', ')

  const limit = input.plan.limit + (input.probeExtraRow === false ? 0 : 1)

  let text = `SELECT ${projectionFor(input.columns, input.projection)} FROM ${quoteQualified(input.table)}`
  if (where.length) text += ` WHERE ${where.join(' AND ')}`
  if (orderBy) text += ` ORDER BY ${orderBy}`
  text += ` LIMIT ${binder.bind(limit)}`
  if (input.plan.strategy === 'offset' && input.plan.offset > 0) {
    text += ` OFFSET ${binder.bind(input.plan.offset)}`
  }
  return { text, values: binder.values }
}

/** `WHERE` over every key column. Throws when any key value is absent. */
export function buildPkPredicate(
  pk: PkValues,
  primaryKey: readonly string[],
  columns: readonly ColumnMeta[],
  binder: Binder,
): string {
  if (!primaryKey.length) {
    throw new DbBrowserError(
      'NO_PRIMARY_KEY',
      'This table has no primary key and no usable rowid, so a single row cannot be addressed. Editing is disabled.',
    )
  }
  const parts: string[] = []
  for (const name of primaryKey) {
    const resolved = resolveOrRowid(columns, name)
    if (!(resolved in pk) && !(name in pk)) {
      throw new DbBrowserError(
        'INCOMPLETE_PRIMARY_KEY',
        `Missing primary-key value for "${name}" — refusing to run a partially-keyed statement`,
      )
    }
    const value = (pk as Row)[resolved] ?? (pk as Row)[name]
    if (value === null || value === undefined) {
      throw new DbBrowserError(
        'INCOMPLETE_PRIMARY_KEY',
        `Primary-key value for "${name}" is null — refusing to run a partially-keyed statement`,
      )
    }
    parts.push(`${quoteIdent(resolved)} = ${binder.bind(value)}`)
  }
  return parts.join(' AND ')
}

export interface WriteBuildInput {
  table: TableRef
  columns: readonly ColumnMeta[]
  primaryKey: readonly string[]
}

export function buildUpdate(input: WriteBuildInput & { pk: PkValues; patch: Row }): BuiltQuery {
  const binder = new Binder()
  const sets: string[] = []
  // SET fragments are built first so their values are bound before the WHERE's
  // — with `?` placeholders the order of `values` *is* the mapping.
  for (const [name, value] of Object.entries(input.patch)) {
    const column = resolveColumn(input.columns, name)
    if (column.readOnly) {
      throw new DbBrowserError(
        'READ_ONLY_COLUMN',
        `Column "${column.name}" cannot be written`,
      )
    }
    sets.push(`${quoteIdent(column.name)} = ${binder.bind(value)}`)
  }
  if (!sets.length) throw new DbBrowserError('EMPTY_PATCH', 'No columns to update')
  const where = buildPkPredicate(input.pk, input.primaryKey, input.columns, binder)
  return {
    text: `UPDATE ${quoteQualified(input.table)} SET ${sets.join(', ')} WHERE ${where}`,
    values: binder.values,
  }
}

export function buildInsert(input: WriteBuildInput & { row: Row }): BuiltQuery {
  const binder = new Binder()
  const names: string[] = []
  const placeholders: string[] = []
  for (const [name, value] of Object.entries(input.row)) {
    const column = resolveColumn(input.columns, name)
    if (column.readOnly) continue
    names.push(quoteIdent(column.name))
    placeholders.push(binder.bind(value))
  }
  const text = names.length
    ? `INSERT INTO ${quoteQualified(input.table)} (${names.join(', ')}) VALUES (${placeholders.join(', ')})`
    : `INSERT INTO ${quoteQualified(input.table)} DEFAULT VALUES`
  return { text, values: binder.values }
}

export function buildDelete(input: WriteBuildInput & { pk: PkValues }): BuiltQuery {
  const binder = new Binder()
  const where = buildPkPredicate(input.pk, input.primaryKey, input.columns, binder)
  return {
    text: `DELETE FROM ${quoteQualified(input.table)} WHERE ${where}`,
    values: binder.values,
  }
}

/**
 * Read one blob cell. SQLite has no `encode(…, 'base64')`, so the raw bytes come
 * back as a `Uint8Array` and are base64-encoded in Node — which is fine because
 * this path is explicitly one cell, on demand, never a page.
 */
export function buildBinaryFetch(
  input: WriteBuildInput & { pk: PkValues; column: string },
): BuiltQuery {
  const binder = new Binder()
  const column = resolveColumn(input.columns, input.column)
  if (!column.isBinary) {
    throw new DbBrowserError('NOT_BINARY', `Column "${column.name}" is not a binary column`)
  }
  const where = buildPkPredicate(input.pk, input.primaryKey, input.columns, binder)
  return {
    text:
      `SELECT ${quoteIdent(column.name)} AS bytes, length(${quoteIdent(column.name)}) AS size ` +
      `FROM ${quoteQualified(input.table)} WHERE ${where}`,
    values: binder.values,
  }
}

/**
 * Wrap a user `SELECT` so the row cap is enforced **by SQLite**, not by
 * throwing rows away after Node has already materialised them.
 */
export function wrapWithLimit(sql: string, limit: number): string {
  // The one place a number is interpolated rather than bound: a `LIMIT ?`
  // inside a wrapper would shift the user's own placeholders. It is therefore
  // proven to be a positive integer first.
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n < 1) {
    throw new DbBrowserError('BAD_LIMIT', `Row limit must be a positive integer, got ${String(limit)}`)
  }
  return `SELECT * FROM (${sql}) AS _dbb_capped LIMIT ${n}`
}
