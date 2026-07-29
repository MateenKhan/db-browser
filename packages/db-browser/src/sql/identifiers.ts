/**
 * Identifier handling.
 *
 * SQL has no placeholder for a table or column name, so identifiers *must* be
 * interpolated into the statement text. That is only safe when both of these
 * hold, and this module is what makes them hold:
 *
 *  1. **Resolution** — the name is matched against the live introspection
 *     result and replaced by the server's own spelling. A name the database
 *     does not report simply cannot reach a query.
 *  2. **Quoting** — the resolved name is double-quoted with `"` doubled, so
 *     even a legitimately hostile column name (`we"ird`) cannot break out.
 *
 * Values never go through here. They are always bound parameters.
 */

import { DbBrowserError } from '../types.js'
import type { ColumnMeta, TableMeta, TableRef } from '../types.js'

/** Postgres truncates identifiers at 63 bytes; anything longer is not real. */
export const MAX_IDENTIFIER_LENGTH = 63

/**
 * A name that needs no quoting at all. Used for *validating user-supplied new*
 * names (e.g. a column alias); existing names are resolved and quoted instead,
 * so they may be anything the server actually reports.
 */
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/

export function isPlainIdentifier(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_IDENTIFIER_LENGTH &&
    PLAIN_IDENTIFIER.test(name)
  )
}

/**
 * Quote an identifier for Postgres. Rejects NUL (which would truncate the
 * statement at the protocol level) and anything not a string.
 */
export function quoteIdent(name: string): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new DbBrowserError('INVALID_IDENTIFIER', 'Identifier must be a non-empty string')
  }
  if (/[\u0000-\u001f]/.test(name)) {
    throw new DbBrowserError('INVALID_IDENTIFIER', 'Identifier contains a control character')
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new DbBrowserError(
      'INVALID_IDENTIFIER',
      `Identifier is longer than ${MAX_IDENTIFIER_LENGTH} characters`,
    )
  }
  return `"${name.replace(/"/g, '""')}"`
}

/** `"schema"."table"`, both parts resolved by the caller beforehand. */
export function quoteQualified(ref: TableRef): string {
  return `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`
}

/**
 * Resolve a requested table against the introspected list, case-insensitively,
 * returning the server's own spelling. Throws when it is not a real table.
 */
export function resolveTable(tables: readonly TableMeta[], ref: TableRef): TableMeta {
  const exact = tables.find((t) => t.schema === ref.schema && t.name === ref.name)
  if (exact) return exact
  const ci = tables.find(
    (t) =>
      t.schema.toLowerCase() === String(ref.schema ?? '').toLowerCase() &&
      t.name.toLowerCase() === String(ref.name ?? '').toLowerCase(),
  )
  if (ci) return ci
  throw new DbBrowserError(
    'TABLE_NOT_FOUND',
    `Table not found: ${ref?.schema ?? '?'}.${ref?.name ?? '?'}`,
  )
}

/** Resolve a column name against a table's introspected columns. */
export function resolveColumn(columns: readonly ColumnMeta[], name: string): ColumnMeta {
  const exact = columns.find((c) => c.name === name)
  if (exact) return exact
  const ci = columns.find((c) => c.name.toLowerCase() === String(name ?? '').toLowerCase())
  if (ci) return ci
  throw new DbBrowserError('COLUMN_NOT_FOUND', `Column not found: ${String(name)}`)
}

/** Resolve many columns at once, preserving the requested order. */
export function resolveColumns(
  columns: readonly ColumnMeta[],
  names: readonly string[],
): ColumnMeta[] {
  return names.map((n) => resolveColumn(columns, n))
}

/**
 * Validate a *new* identifier supplied by the user (a name that does not exist
 * yet, so it cannot be resolved). Deliberately strict.
 */
export function assertNewIdentifier(name: string, what = 'identifier'): string {
  if (!isPlainIdentifier(name)) {
    throw new DbBrowserError(
      'INVALID_IDENTIFIER',
      `Invalid ${what}: must match [A-Za-z_][A-Za-z0-9_$]* and be at most ${MAX_IDENTIFIER_LENGTH} characters`,
    )
  }
  return name
}
