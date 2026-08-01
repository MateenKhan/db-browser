/**
 * The engine-agnostic SQL builder.
 *
 * One builder, parameterised by a `Dialect`. Before this there were two —
 * `db-browser-pg/sqlBuilder.ts` and `db-browser-sqlite/sqlBuilder.ts` — which
 * were 80% the same file with three real differences (`$n` vs `?`, `::text` vs
 * `CAST`, `= ANY` vs `IN`) and, inevitably, one accidental one: the Postgres
 * builder emitted `RETURNING` and the SQLite one did not, so `update()`
 * returned the new row on one engine and re-read it on the other.
 *
 * The rule this module exists to enforce is unchanged and absolute:
 * **identifiers are resolved and quoted, values are bound.** Every function
 * returns `{ text, values }`, and there is no code path that renders a user
 * value into `text`. The one interpolated number — the row cap inside
 * `wrapWithLimit` — is proven to be a positive integer first, and lives in
 * `dialects/shared.ts` where that proof is next to it.
 */

import {
  DbBrowserError,
  keysetPredicate,
  resolveColumn,
} from '@jugaaadi/db-browser/core'
import type {
  ColumnMeta,
  Filter,
  PagePlan,
  PkValues,
  Row,
  TableRef,
} from '@jugaaadi/db-browser/core'
import { likeLiteral } from './dialects/shared.js'
import type { Binder, Dialect } from './dialects/types.js'

export interface BuiltQuery {
  text: string
  values: unknown[]
}

const COMPARISON: Record<string, string> = {
  eq: '=',
  neq: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
}

/**
 * Names an engine maintains but never reports as a column, which are still
 * legal to select and filter on.
 *
 * Only SQLite has any (`rowid` and its aliases), and only SQLite's descriptor
 * declares `capabilities.implicitRowId`. The resolver consults the *dialect*
 * rather than hardcoding the names so that an engine which grows one later is
 * a dialect change, not an `if (engine === 'sqlite')` here.
 */
export interface ColumnResolver {
  (columns: readonly ColumnMeta[], name: string): string
}

/** The default: a name must be one the database reported. */
export const strictResolver: ColumnResolver = (columns, name) =>
  resolveColumn(columns, name).name

export interface BuilderContext {
  dialect: Dialect
  /** Overridden for engines with an implicit row key. */
  resolveName?: ColumnResolver
}

function nameOf(ctx: BuilderContext, columns: readonly ColumnMeta[], name: string): string {
  return (ctx.resolveName ?? strictResolver)(columns, name)
}

/**
 * One filter → one predicate.
 *
 * `column` is resolved against live introspection before it is quoted; an
 * unknown column throws rather than being interpolated. The `contains`/
 * `startsWith`/`endsWith` family casts to text first because a column's
 * declared type does not constrain what a substring search means — and on a
 * dynamically-typed engine it does not constrain what is *stored* either.
 */
export function buildFilter(
  ctx: BuilderContext,
  filter: Filter,
  columns: readonly ColumnMeta[],
  binder: Binder,
): string {
  const { dialect } = ctx
  const q = dialect.quoteIdent(nameOf(ctx, columns, filter.column))
  switch (filter.op) {
    case 'isNull':
      return `${q} IS NULL`
    case 'isNotNull':
      return `${q} IS NOT NULL`
    case 'contains':
      return dialect.likePredicate(
        dialect.castToText(q),
        binder.bind(`%${likeLiteral(filter.value)}%`),
      )
    case 'startsWith':
      return dialect.likePredicate(
        dialect.castToText(q),
        binder.bind(`${likeLiteral(filter.value)}%`),
      )
    case 'endsWith':
      return dialect.likePredicate(
        dialect.castToText(q),
        binder.bind(`%${likeLiteral(filter.value)}`),
      )
    case 'in':
      return dialect.inPredicate(q, filter.values ?? [], binder)
    default: {
      const op = COMPARISON[filter.op]
      if (!op) throw new DbBrowserError('BAD_FILTER', `Unsupported filter operator: ${filter.op}`)
      // `= NULL` is never true in SQL. A user who filters "equals nothing"
      // means `IS NULL`, and silently returning zero rows instead would look
      // like an empty table.
      if (filter.value === null) return filter.op === 'eq' ? `${q} IS NULL` : `${q} IS NOT NULL`
      return `${q} ${op} ${binder.bind(filter.value)}`
    }
  }
}

/**
 * Binary and vector columns are projected as their **byte length**, never as
 * bytes.
 *
 * For an embedding store this is not an optimisation, it is the difference
 * between a working page and a hang: 100 rows x 768 float32s is 300 KB of
 * base64 per page for a value that renders as `768 dims · 3.0 KB`. The size is
 * all the grid ever needs; the bytes are fetched one cell at a time, on
 * request, through `fetchBinary`.
 */
export function projectionFor(
  ctx: BuilderContext,
  columns: readonly ColumnMeta[],
  only?: readonly string[],
): string {
  const { dialect } = ctx
  const wanted = only?.length ? only.map((n) => resolveColumn(columns, n)) : columns
  return wanted
    .map((c) => {
      const q = dialect.quoteIdent(c.name)
      return c.isBinary ? `${dialect.byteLengthExpr(q)} AS ${q}` : q
    })
    .join(', ')
}

export interface SelectBuildInput {
  table: TableRef
  columns: readonly ColumnMeta[]
  plan: PagePlan
  filters?: readonly Filter[]
  projection?: readonly string[]
  /**
   * Fetch `limit + 1` rows so "is there another page?" needs no `COUNT(*)`.
   * The extra row is dropped before it reaches the client.
   */
  probeExtraRow?: boolean
}

export function buildSelect(ctx: BuilderContext, input: SelectBuildInput): BuiltQuery {
  const { dialect } = ctx
  const binder = dialect.createBinder()
  const where: string[] = []

  for (const f of input.filters ?? []) {
    where.push(buildFilter(ctx, f, input.columns, binder))
  }
  if (input.plan.keyset?.terms.length) {
    where.push(
      keysetPredicate(
        input.plan.keyset.terms,
        (name) => dialect.quoteIdent(nameOf(ctx, input.columns, name)),
        binder.bind,
      ),
    )
  }

  const orderBy = input.plan.orderBy
    .map(
      (t) =>
        `${dialect.quoteIdent(nameOf(ctx, input.columns, t.column))} ${
          t.direction === 'desc' ? 'DESC' : 'ASC'
        }`,
    )
    .join(', ')

  const limit = input.plan.limit + (input.probeExtraRow === false ? 0 : 1)
  const offset = input.plan.strategy === 'offset' ? input.plan.offset : 0

  let text = `SELECT ${projectionFor(ctx, input.columns, input.projection)} FROM ${dialect.qualify(
    input.table,
  )}`
  if (where.length) text += ` WHERE ${where.join(' AND ')}`
  if (orderBy) text += ` ORDER BY ${orderBy}`
  text += dialect.paginationClause({ binder, limit, offset, hasOrderBy: !!orderBy })
  return { text, values: binder.values }
}

/** `WHERE` over every key column. Throws when any key value is absent. */
export function buildPkPredicate(
  ctx: BuilderContext,
  pk: PkValues,
  primaryKey: readonly string[],
  columns: readonly ColumnMeta[],
  binder: Binder,
): string {
  if (!primaryKey.length) {
    throw new DbBrowserError(
      'NO_PRIMARY_KEY',
      'This table has no usable key, so a single row cannot be addressed. Editing is disabled.',
    )
  }
  const parts: string[] = []
  for (const name of primaryKey) {
    const resolved = nameOf(ctx, columns, name)
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
    parts.push(`${ctx.dialect.quoteIdent(resolved)} = ${binder.bind(value)}`)
  }
  return parts.join(' AND ')
}

export interface WriteBuildInput {
  table: TableRef
  columns: readonly ColumnMeta[]
  primaryKey: readonly string[]
}

/**
 * `RETURNING` is emitted only where the engine has it.
 *
 * Postgres always has it; SQLite has it from 3.35; MySQL has never had it and
 * MariaDB only on `INSERT`/`DELETE`. Rather than branch at the call site, the
 * builder reports whether it emitted one and the data source re-reads the row
 * when it did not — so `update()` returns the new row on every engine, which
 * is what the pending-changes model assumes.
 */
export interface WriteQuery extends BuiltQuery {
  returnsRow: boolean
}

export function buildUpdate(
  ctx: BuilderContext,
  input: WriteBuildInput & { pk: PkValues; patch: Row; returning?: boolean },
): WriteQuery {
  const { dialect } = ctx
  const binder = dialect.createBinder()
  const sets: string[] = []
  // SET fragments are built first so their values are bound before the
  // WHERE's — with positional (`?`) placeholders the order of `values` *is*
  // the mapping, so this ordering is load-bearing, not stylistic.
  for (const [name, value] of Object.entries(input.patch)) {
    const column = resolveColumn(input.columns, name)
    if (column.readOnly) {
      throw new DbBrowserError(
        'READ_ONLY_COLUMN',
        `Column "${column.name}" is generated and cannot be written`,
      )
    }
    sets.push(`${dialect.quoteIdent(column.name)} = ${binder.bind(value)}`)
  }
  if (!sets.length) throw new DbBrowserError('EMPTY_PATCH', 'No columns to update')
  const where = buildPkPredicate(ctx, input.pk, input.primaryKey, input.columns, binder)
  const returning = input.returning !== false && supportsReturning(dialect)
  let text = `UPDATE ${dialect.qualify(input.table)} SET ${sets.join(', ')} WHERE ${where}`
  if (returning) text += ` RETURNING ${projectionFor(ctx, input.columns)}`
  return { text, values: binder.values, returnsRow: returning }
}

export function buildInsert(
  ctx: BuilderContext,
  input: WriteBuildInput & { row: Row; returning?: boolean },
): WriteQuery {
  const { dialect } = ctx
  const binder = dialect.createBinder()
  const names: string[] = []
  const placeholders: string[] = []
  for (const [name, value] of Object.entries(input.row)) {
    const column = resolveColumn(input.columns, name)
    if (column.readOnly) continue
    names.push(dialect.quoteIdent(column.name))
    placeholders.push(binder.bind(value))
  }
  const returning = input.returning !== false && supportsReturning(dialect)
  let text = names.length
    ? `INSERT INTO ${dialect.qualify(input.table)} (${names.join(', ')}) VALUES (${placeholders.join(
        ', ',
      )})`
    : `INSERT INTO ${dialect.qualify(input.table)} ${defaultValuesClause(dialect)}`
  if (returning) text += ` RETURNING ${projectionFor(ctx, input.columns)}`
  return { text, values: binder.values, returnsRow: returning }
}

export function buildDelete(
  ctx: BuilderContext,
  input: WriteBuildInput & { pk: PkValues },
): BuiltQuery {
  const binder = ctx.dialect.createBinder()
  const where = buildPkPredicate(ctx, input.pk, input.primaryKey, input.columns, binder)
  return {
    text: `DELETE FROM ${ctx.dialect.qualify(input.table)} WHERE ${where}`,
    values: binder.values,
  }
}

/**
 * Read one blob cell.
 *
 * Engines that can base64 server-side do (`encode`, `TO_BASE64`); the rest
 * return raw bytes and the driver binding encodes them in Node. Either way
 * this path is explicitly one cell, on demand — never a page.
 */
export function buildBinaryFetch(
  ctx: BuilderContext,
  input: WriteBuildInput & { pk: PkValues; column: string },
): BuiltQuery & { serverEncoded: boolean } {
  const { dialect } = ctx
  const binder = dialect.createBinder()
  const column = resolveColumn(input.columns, input.column)
  if (!column.isBinary) {
    throw new DbBrowserError('NOT_BINARY', `Column "${column.name}" is not a binary column`)
  }
  const q = dialect.quoteIdent(column.name)
  const where = buildPkPredicate(ctx, input.pk, input.primaryKey, input.columns, binder)
  const encoded = dialect.base64Expr(q)
  return {
    text:
      `SELECT ${encoded ?? q} AS ${dialect.quoteIdent('bytes')}, ` +
      `${dialect.byteLengthExpr(q)} AS ${dialect.quoteIdent('size')} ` +
      `FROM ${dialect.qualify(input.table)} WHERE ${where}`,
    values: binder.values,
    serverEncoded: encoded !== null,
  }
}

/**
 * Which engines have `RETURNING`.
 *
 * Declared as a function of the dialect rather than as a `Dialect` field
 * because it is derivable and a derivable field is a field that can go stale.
 */
function supportsReturning(dialect: Dialect): boolean {
  return (
    dialect.sqlDialect === 'postgres' ||
    dialect.sqlDialect === 'sqlite' ||
    dialect.sqlDialect === 'duckdb'
  )
}

/** `DEFAULT VALUES` — spelled `() VALUES ()` by MySQL. */
function defaultValuesClause(dialect: Dialect): string {
  return dialect.sqlDialect === 'mysql' || dialect.sqlDialect === 'mariadb'
    ? '() VALUES ()'
    : 'DEFAULT VALUES'
}
