/**
 * SQL construction for Postgres.
 *
 * The one rule this module exists to enforce: **identifiers are resolved and
 * quoted, values are bound.** Every function returns `{ text, values }` and
 * there is no code path that renders a user value into `text` — the unit tests
 * assert exactly that.
 */

import {
  DbBrowserError,
  keysetPredicate,
  quoteIdent,
  quoteQualified,
  resolveColumn,
} from '@jugaaadi/db-browser/core'
import type { ColumnMeta, Filter, PagePlan, PkValues, Row, TableRef } from '@jugaaadi/db-browser/core'

export interface BuiltQuery {
  text: string
  values: unknown[]
}

/** Allocates `$n` placeholders and owns the value array. */
export class Binder {
  readonly values: unknown[] = []
  bind = (value: unknown): string => `$${this.values.push(value)}`
}

const COMPARISON: Record<string, string> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
}

/** Escape the LIKE metacharacters in a user substring so it stays literal. */
function likeLiteral(value: unknown): string {
  return String(value ?? '').replace(/([\\%_])/g, '\\$1')
}

/**
 * One filter -> one predicate. `column` is resolved against live introspection
 * before it is quoted; an unknown column throws rather than being interpolated.
 */
export function buildFilter(
  filter: Filter,
  columns: readonly ColumnMeta[],
  binder: Binder,
): string {
  const column = resolveColumn(columns, filter.column)
  const q = quoteIdent(column.name)
  switch (filter.op) {
    case 'isNull':
      return `${q} IS NULL`
    case 'isNotNull':
      return `${q} IS NOT NULL`
    case 'contains':
      return `${q}::text ILIKE ${binder.bind(`%${likeLiteral(filter.value)}%`)} ESCAPE '\\'`
    case 'startsWith':
      return `${q}::text ILIKE ${binder.bind(`${likeLiteral(filter.value)}%`)} ESCAPE '\\'`
    case 'endsWith':
      return `${q}::text ILIKE ${binder.bind(`%${likeLiteral(filter.value)}`)} ESCAPE '\\'`
    case 'in': {
      const list = filter.values ?? []
      if (!list.length) return 'false'
      return `${q} = ANY (${binder.bind(list)})`
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
  /** Restrict the projection; omit for every column. */
  projection?: readonly string[]
  /**
   * Fetch `limit + 1` rows so "is there another page?" needs no COUNT(*).
   * The extra row is dropped before it reaches the client.
   */
  probeExtraRow?: boolean
}

/**
 * Binary columns are projected as `octet_length(col)` — never as bytes. A grid
 * that streams every BYTEA of every row is a memory bomb, and a `blob:` URL
 * built from it would not survive a reload anyway (see the README).
 */
export function projectionFor(columns: readonly ColumnMeta[], only?: readonly string[]): string {
  const wanted = only?.length ? only.map((n) => resolveColumn(columns, n)) : columns
  return wanted
    .map((c) =>
      c.isBinary
        ? `octet_length(${quoteIdent(c.name)}) AS ${quoteIdent(c.name)}`
        : quoteIdent(c.name),
    )
    .join(', ')
}

export function buildSelect(input: SelectBuildInput): BuiltQuery {
  const binder = new Binder()
  const where: string[] = []

  for (const f of input.filters ?? []) {
    where.push(buildFilter(f, input.columns, binder))
  }
  if (input.plan.keyset?.terms.length) {
    where.push(keysetPredicate(input.plan.keyset.terms, quoteIdent, binder.bind))
  }

  const orderBy = input.plan.orderBy
    .map((t) => `${quoteIdent(resolveColumn(input.columns, t.column).name)} ${t.direction === 'desc' ? 'DESC' : 'ASC'}`)
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

/** `WHERE` over every primary-key column. Throws when any key value is absent. */
export function buildPkPredicate(
  pk: PkValues,
  primaryKey: readonly string[],
  columns: readonly ColumnMeta[],
  binder: Binder,
): string {
  if (!primaryKey.length) {
    throw new DbBrowserError(
      'NO_PRIMARY_KEY',
      'This table has no primary key, so a single row cannot be addressed. Editing is disabled.',
    )
  }
  const parts: string[] = []
  for (const name of primaryKey) {
    const column = resolveColumn(columns, name)
    if (!(column.name in pk) && !(name in pk)) {
      throw new DbBrowserError(
        'INCOMPLETE_PRIMARY_KEY',
        `Missing primary-key value for "${name}" — refusing to run a partially-keyed statement`,
      )
    }
    const value = (pk as Row)[column.name] ?? (pk as Row)[name]
    if (value === null || value === undefined) {
      throw new DbBrowserError(
        'INCOMPLETE_PRIMARY_KEY',
        `Primary-key value for "${name}" is null — refusing to run a partially-keyed statement`,
      )
    }
    parts.push(`${quoteIdent(column.name)} = ${binder.bind(value)}`)
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
  for (const [name, value] of Object.entries(input.patch)) {
    const column = resolveColumn(input.columns, name)
    if (column.readOnly) {
      throw new DbBrowserError(
        'READ_ONLY_COLUMN',
        `Column "${column.name}" is generated and cannot be written`,
      )
    }
    sets.push(`${quoteIdent(column.name)} = ${binder.bind(value)}`)
  }
  if (!sets.length) throw new DbBrowserError('EMPTY_PATCH', 'No columns to update')
  const where = buildPkPredicate(input.pk, input.primaryKey, input.columns, binder)
  return {
    text: `UPDATE ${quoteQualified(input.table)} SET ${sets.join(', ')} WHERE ${where} RETURNING ${projectionFor(input.columns)}`,
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
    ? `INSERT INTO ${quoteQualified(input.table)} (${names.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${projectionFor(input.columns)}`
    : `INSERT INTO ${quoteQualified(input.table)} DEFAULT VALUES RETURNING ${projectionFor(input.columns)}`
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
      `SELECT encode(${quoteIdent(column.name)}, 'base64') AS base64, ` +
      `octet_length(${quoteIdent(column.name)}) AS bytes ` +
      `FROM ${quoteQualified(input.table)} WHERE ${where}`,
    values: binder.values,
  }
}

/**
 * Wrap a user `SELECT` so the row cap is enforced **by the server**, not by
 * throwing rows away after they have already been materialised in Node.
 */
export function wrapWithLimit(sql: string, limit: number): string {
  // The one place a number is interpolated rather than bound (`LIMIT $1`
  // inside a wrapper would shift the user's own placeholders). It is therefore
  // proven to be a positive integer first — `LIMIT NaN` or, worse, a string,
  // must never reach the server.
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n < 1) {
    throw new DbBrowserError('BAD_LIMIT', `Row limit must be a positive integer, got ${String(limit)}`)
  }
  return `SELECT * FROM (${sql}) AS _dbb_capped LIMIT ${n}`
}
