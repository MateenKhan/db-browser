/**
 * The parts of a `Dialect` that are the same for most engines.
 *
 * Extracted so a new dialect states its differences. Everything here is a
 * default a dialect may override, never something a dialect may *skip* — the
 * interface stays total, so a missing method is a compile error rather than a
 * runtime `undefined is not a function` on the one code path nobody exercised.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'
import type { Binder, PaginationClauseInput } from './types.js'

/** `?` placeholders, positional by order of appearance. MySQL, SQLite, DuckDB. */
export function createPositionalBinder(): Binder {
  const values: unknown[] = []
  return {
    values,
    bind(value: unknown) {
      values.push(value)
      return '?'
    },
  }
}

/** `$n` placeholders. Postgres and everything that speaks its protocol. */
export function createNumberedBinder(): Binder {
  const values: unknown[] = []
  return {
    values,
    bind(value: unknown) {
      return `$${values.push(value)}`
    },
  }
}

/** `@pN` placeholders. SQL Server. */
export function createNamedBinder(prefix = '@p'): Binder {
  const values: unknown[] = []
  return {
    values,
    bind(value: unknown) {
      return `${prefix}${values.push(value) - 1}`
    },
  }
}

/**
 * Reject an identifier that cannot be safely quoted by *any* scheme.
 *
 * The two rejections are not style. A control character — a NUL above all —
 * truncates the statement at the protocol level on several drivers, so a name
 * containing one is not a name, it is a probe. An over-long identifier is the
 * same story: no engine here accepts one, so the only thing that produces it
 * is something that is not a real column.
 *
 * The check is written as a character-code loop rather than as a regex on
 * purpose. A control-character character class is exactly the kind of literal
 * that gets mangled by an editor or a transform, and a silently-broken one is
 * a security hole no test would notice. Character codes cannot be mangled.
 */
function assertQuotableIdentifier(name: string, maxLength: number): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new DbBrowserError('INVALID_IDENTIFIER', 'Identifier must be a non-empty string')
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new DbBrowserError('INVALID_IDENTIFIER', 'Identifier contains a control character')
    }
  }
  if (name.length > maxLength) {
    throw new DbBrowserError(
      'INVALID_IDENTIFIER',
      `Identifier is longer than ${maxLength} characters`,
    )
  }
}

/**
 * Double-quote quoting with `"` doubled — the SQL standard, and what Postgres,
 * SQLite, DuckDB and Oracle use.
 */
export function quoteDoubleQuoted(name: string, maxLength = 63): string {
  assertQuotableIdentifier(name, maxLength)
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Backtick quoting with the backtick doubled. MySQL and MariaDB.
 *
 * MySQL *also* accepts double quotes as identifier quoting, but only when
 * `ANSI_QUOTES` is in the session's `sql_mode` — and by default it is not, so
 * a double-quoted name is a string *literal* there. Using backticks rather
 * than setting `ANSI_QUOTES` keeps this correct on a server whose mode this
 * process does not control.
 */
export function quoteBacktick(name: string, maxLength = 64): string {
  assertQuotableIdentifier(name, maxLength)
  return `\`${name.replace(/`/g, '``')}\``
}

/** Bracket quoting with `]` doubled. SQL Server. */
export function quoteBracket(name: string, maxLength = 128): string {
  assertQuotableIdentifier(name, maxLength)
  return `[${name.replace(/]/g, ']]')}]`
}

/** `LIMIT n OFFSET m` — Postgres, MySQL, SQLite, DuckDB. */
export function limitOffsetClause(input: PaginationClauseInput): string {
  let text = ` LIMIT ${input.binder.bind(input.limit)}`
  if (input.offset > 0) text += ` OFFSET ${input.binder.bind(input.offset)}`
  return text
}

/**
 * `OFFSET m ROWS FETCH NEXT n ROWS ONLY` — SQL Server 2012+, Oracle 12c+.
 *
 * Both engines require an `ORDER BY` in front of it. The builder always emits
 * one for these dialects (see `requiresOrderByForOffset`), but the clause
 * itself refuses rather than producing SQL the server would reject with a
 * message about a keyword rather than about pagination.
 */
export function fetchFirstClause(input: PaginationClauseInput): string {
  if (!input.hasOrderBy) {
    throw new DbBrowserError(
      'PAGINATION_NEEDS_ORDER',
      'This engine requires an ORDER BY before OFFSET/FETCH. The pagination planner ' +
        'always supplies one; reaching this means a caller built a statement by hand.',
    )
  }
  return (
    ` OFFSET ${input.binder.bind(input.offset)} ROWS` +
    ` FETCH NEXT ${input.binder.bind(input.limit)} ROWS ONLY`
  )
}

/**
 * Wrap a user `SELECT` so the row cap is enforced **by the server**, not by
 * discarding rows Node has already materialised.
 *
 * The one place a number is interpolated rather than bound — a `LIMIT ?`
 * inside a wrapper would shift the user's own placeholders — so it is proven
 * to be a positive integer first. `LIMIT NaN`, or worse a string, must never
 * reach a server.
 */
export function wrapWithLimitSql(
  sql: string,
  limit: number,
  style: 'LIMIT' | 'TOP' = 'LIMIT',
): string {
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n < 1) {
    throw new DbBrowserError(
      'BAD_LIMIT',
      `Row limit must be a positive integer, got ${String(limit)}`,
    )
  }
  return style === 'LIMIT'
    ? `SELECT * FROM (${sql}) AS _dbb_capped LIMIT ${n}`
    : `SELECT TOP ${n} * FROM (${sql}) AS _dbb_capped`
}

/** Escape the LIKE metacharacters in a user substring so it stays literal. */
export function likeLiteral(value: unknown): string {
  return String(value ?? '').replace(/([\\%_])/g, '\\$1')
}

/**
 * Normalise a driver error into something safe to surface.
 *
 * The rule every dialect follows: **the server's message about the statement
 * is safe; the driver's error object is not.** A `pg` error carries the pool's
 * client config (password included), a SQLite error carries the absolute file
 * path, and a `mysql2` error carries the connection config. So the message is
 * taken, optionally scrubbed, and the object is dropped.
 */
export function normalizeDriverError(
  e: unknown,
  prefix: string,
  scrub?: (message: string) => string,
): Error {
  if (e instanceof DbBrowserError) return e
  const err = e as {
    code?: string
    message?: string
    detail?: string
    hint?: string
    sqlMessage?: string
  }
  const raw =
    (typeof err?.sqlMessage === 'string' && err.sqlMessage) ||
    (typeof err?.message === 'string' && err.message) ||
    'Database operation failed'
  const message = scrub ? scrub(raw) : raw
  const detail = [err?.detail, err?.hint].filter(Boolean).join(' — ') || undefined
  return new DbBrowserError(err?.code ? `${prefix}_${err.code}` : 'DB_ERROR', message, detail)
}
