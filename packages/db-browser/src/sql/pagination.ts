/**
 * Pagination planning — shared by every adapter so the rules are identical
 * wherever rows come from.
 *
 * Two strategies:
 *
 *  - **Keyset** (`WHERE (a, b) > ($1, $2) ORDER BY a, b LIMIT n`). Constant
 *    cost at any depth, and stable while rows are being inserted. Requires a
 *    *total* ordering, which is why the primary key is appended to whatever the
 *    user sorted by.
 *  - **Offset** (`OFFSET n LIMIT m`). The fallback for PK-less tables, views,
 *    and orderings over nullable columns. Correct, but the server still walks
 *    the skipped rows, so deep pages get slower.
 *
 * Nullable ordering columns force the fallback deliberately: `(a, b) > (…)`
 * with a NULL in the tuple is NULL, i.e. false, and the page silently loses
 * rows. A page that quietly drops rows is worse than a slow one.
 */

import { DbBrowserError } from '../types.js'
import type { ColumnMeta, Cursor, PageStrategy, SortDirection, SortSpec } from '../types.js'

export interface LimitPolicy {
  /** Applied when the caller asks for nothing. */
  defaultLimit: number
  /** Hard ceiling; a caller can never exceed it. */
  maxLimit: number
}

export const DEFAULT_LIMIT_POLICY: LimitPolicy = { defaultLimit: 100, maxLimit: 1000 }

/** Never let an unbounded or absurd limit reach the database. */
export function clampLimit(requested: unknown, policy: LimitPolicy = DEFAULT_LIMIT_POLICY): number {
  const n = typeof requested === 'number' ? requested : Number(requested)
  if (!Number.isFinite(n) || n <= 0) return policy.defaultLimit
  return Math.min(Math.floor(n), policy.maxLimit)
}

export interface OrderByTerm {
  column: string
  direction: SortDirection
}

export interface PagePlan {
  strategy: PageStrategy
  orderBy: OrderByTerm[]
  /** Only for `offset`. */
  offset: number
  limit: number
  /** Present for keyset when a cursor was supplied. */
  keyset?: {
    /** Ordering columns, in ORDER BY order, matched to the cursor values. */
    terms: Array<{ column: string; direction: SortDirection; value: unknown }>
  }
  /** Why keyset was not used, for the UI to show. */
  fallbackReason?: string
}

export interface PlanPageInput {
  columns: readonly ColumnMeta[]
  primaryKey: readonly string[]
  sort?: readonly SortSpec[]
  cursor?: Cursor | null
  offset?: number
  limit?: number
  policy?: LimitPolicy
  /** Set false for views/PK-less tables even if a "PK" was guessed. */
  keysetAllowed?: boolean
}

/**
 * Decide how to fetch the next page. Pure — no SQL, no I/O — so it is fully
 * unit-testable and every adapter can share it.
 */
export function planPage(input: PlanPageInput): PagePlan {
  const policy = input.policy ?? DEFAULT_LIMIT_POLICY
  const limit = clampLimit(input.limit, policy)
  const offset = Math.max(0, Math.floor(Number(input.offset ?? 0) || 0))
  const byName = new Map(input.columns.map((c) => [c.name, c]))

  const requestedSort: OrderByTerm[] = (input.sort ?? [])
    .filter((s) => byName.has(s.column))
    .map((s) => ({ column: s.column, direction: s.direction === 'desc' ? 'desc' : 'asc' }))

  const pk = input.primaryKey.filter((name) => byName.has(name))

  // Complete the ordering with the primary key so it is total.
  const orderBy: OrderByTerm[] = [...requestedSort]
  for (const name of pk) {
    if (!orderBy.some((t) => t.column === name)) {
      orderBy.push({ column: name, direction: requestedSort[0]?.direction ?? 'asc' })
    }
  }

  const offsetPlan = (reason: string): PagePlan => ({
    strategy: 'offset',
    orderBy: orderBy.length ? orderBy : requestedSort,
    offset,
    limit,
    fallbackReason: reason,
  })

  if (input.keysetAllowed === false) return offsetPlan('keyset disabled for this source')
  if (!pk.length) return offsetPlan('table has no primary key — using OFFSET pagination')

  const nullable = orderBy.find((t) => byName.get(t.column)?.nullable)
  if (nullable) {
    return offsetPlan(
      `ordering column "${nullable.column}" is nullable — using OFFSET pagination so no rows are skipped`,
    )
  }

  const plan: PagePlan = { strategy: 'keyset', orderBy, offset: 0, limit }

  const cursor = input.cursor
  if (cursor && cursor.values?.length) {
    if (cursor.values.length !== orderBy.length) {
      throw new DbBrowserError(
        'STALE_CURSOR',
        'The cursor does not match the current sort. Reload the first page.',
      )
    }
    plan.keyset = {
      terms: orderBy.map((t, i) => {
        const cv = cursor.values[i]
        if (!cv || cv.column !== t.column) {
          throw new DbBrowserError(
            'STALE_CURSOR',
            'The cursor does not match the current sort. Reload the first page.',
          )
        }
        // "before" walks backwards, so every comparison flips.
        const direction: SortDirection =
          cursor.direction === 'before' ? (t.direction === 'asc' ? 'desc' : 'asc') : t.direction
        return { column: t.column, direction, value: cv.value }
      }),
    }
  }
  return plan
}

/**
 * Lexicographic keyset predicate, expanded rather than using row-comparison
 * (`(a,b) > (x,y)`), because row comparison requires every term to share a
 * direction. Emits, for `a ASC, b DESC`:
 *
 * ```sql
 * (a > $1) OR (a = $1 AND b < $2)
 * ```
 *
 * `bind` allocates a placeholder for a value and returns its text (`$1`), so
 * the caller keeps ownership of parameter numbering. **No value is ever
 * rendered into the returned SQL.**
 */
export function keysetPredicate(
  terms: ReadonlyArray<{ column: string; direction: SortDirection; value: unknown }>,
  quote: (column: string) => string,
  bind: (value: unknown) => string,
): string {
  if (!terms.length) return ''
  const placeholders = terms.map((t) => bind(t.value))
  const clauses: string[] = []
  for (let i = 0; i < terms.length; i++) {
    const eq = terms
      .slice(0, i)
      .map((t, j) => `${quote(t.column)} = ${placeholders[j]}`)
    const op = terms[i].direction === 'desc' ? '<' : '>'
    eq.push(`${quote(terms[i].column)} ${op} ${placeholders[i]}`)
    clauses.push(`(${eq.join(' AND ')})`)
  }
  return `(${clauses.join(' OR ')})`
}

/** Build the cursor that would fetch the page after `row`. */
export function cursorFromRow(
  row: Record<string, unknown>,
  orderBy: readonly OrderByTerm[],
  direction: 'after' | 'before' = 'after',
): Cursor {
  return {
    direction,
    values: orderBy.map((t) => ({ column: t.column, value: row[t.column] })),
  }
}
