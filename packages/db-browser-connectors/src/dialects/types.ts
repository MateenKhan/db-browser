/**
 * The `Dialect` strategy — the *code* half of an engine, next to the
 * descriptor's *data* half.
 *
 * ## What belongs here, and the test for it
 *
 * A method belongs on `Dialect` when two engines answer it differently and the
 * difference cannot be expressed as data. Placeholders are the clearest
 * example: Postgres numbers them (`$1`), MySQL and SQLite do not (`?`), and
 * SQL Server names them (`@p1`). No table of strings expresses that, because
 * the numbering is stateful — so it is a `Binder` factory, not a constant.
 *
 * A method does **not** belong here when it is the same everywhere. The row
 * cap, the keyset predicate, the identifier-resolution rule, the guard, the
 * pending-changes model and the pagination *planner* are all shared, live in
 * `@jugaaadi/db-browser/core`, and no dialect can override them. That is
 * deliberate: those are the safety properties, and a per-engine override is
 * how a safety property quietly stops holding for one engine.
 *
 * ## The shape of the bet
 *
 * The claim this file makes is that **adding an engine is a descriptor, a
 * dialect and a driver binding — with zero changes to core.** MySQL was
 * implemented after the interface was written, as the test of that claim. It
 * needed exactly those three files.
 */

import type {
  ColumnMeta,
  SqlDialect,
  TableMeta,
  TableRef,
} from '@jugaaadi/db-browser/core'
import type { ConnectorDescriptor, EngineId } from '../types.js'

/**
 * Allocates placeholders and owns the value array.
 *
 * Every builder threads exactly one of these through the whole statement, so
 * the values array and the placeholder text can never disagree — which is the
 * bug positional (`?`) placeholders exist to cause. Nothing else in this
 * package is allowed to put a user value into SQL text.
 */
export interface Binder {
  readonly values: unknown[]
  bind(value: unknown): string
}

/** A prepared row set, as the generic layer needs it. */
export interface ExecResult {
  rows: Array<Record<string, unknown>>
  /** Result columns in order, when the driver reports them. */
  fields?: Array<{ name: string; dataType?: string | null }>
  /** Rows affected by a write, when the driver reports it. */
  rowCount?: number | null
  /** `SELECT`, `INSERT`, … when the driver reports it. */
  command?: string | null
}

/** Run one statement. The only thing a dialect is handed to talk to a server. */
export type Exec = (sql: string, params?: readonly unknown[]) => Promise<ExecResult>

export interface ListTablesOptions {
  /** Restrict to these schemas / databases. Empty means "everything sensible". */
  schemas?: readonly string[]
}

/**
 * The pagination clause, because the two shapes in the wild are not variations
 * of each other.
 *
 * Postgres/MySQL/SQLite/DuckDB: `LIMIT n OFFSET m`.
 * SQL Server/Oracle: `OFFSET m ROWS FETCH NEXT n ROWS ONLY`, and it is only
 * legal **after an `ORDER BY`** — which is why `requiresOrderByForOffset` is a
 * declared property rather than something the builder guesses.
 */
export interface PaginationClauseInput {
  binder: Binder
  limit: number
  offset: number
  /** True when the statement already emitted an ORDER BY. */
  hasOrderBy: boolean
}

export interface Dialect {
  readonly id: EngineId
  readonly descriptor: ConnectorDescriptor
  /** The grammar for the formatter and the editor. */
  readonly sqlDialect: SqlDialect

  /** A fresh placeholder allocator for one statement. */
  createBinder(): Binder

  /** Quote one identifier. Must reject control characters — see core. */
  quoteIdent(name: string): string

  /**
   * `"schema"."table"`, or just `"table"` where the engine's "schema" is the
   * connected database and qualifying would be wrong.
   */
  qualify(ref: TableRef): string

  /** `x::text` / `CAST(x AS TEXT)` / `CAST(x AS CHAR)`. */
  castToText(expr: string): string

  /**
   * A case-insensitive `contains`-style predicate over `expr`.
   *
   * Returned whole rather than assembled from parts because the engines
   * differ in more than the operator name: Postgres has `ILIKE`, MySQL's
   * `LIKE` is already case-insensitive under its default collation, and SQLite
   * needs an explicit `ESCAPE` clause that MySQL spells differently.
   */
  likePredicate(expr: string, placeholder: string): string

  /** `IN (?, ?, ?)` vs Postgres's single-parameter `= ANY ($1)`. */
  inPredicate(expr: string, values: readonly unknown[], binder: Binder): string

  /** Byte length of a blob column, for the never-inline projection. */
  byteLengthExpr(expr: string): string

  /** Base64 of a blob, when the engine can do it server-side; else null. */
  base64Expr(expr: string): string | null

  paginationClause(input: PaginationClauseInput): string

  /** True when `OFFSET … ROWS` needs an `ORDER BY` to be legal. */
  readonly requiresOrderByForOffset: boolean

  /** Wrap a user statement so the row cap is enforced by the server. */
  wrapWithLimit(sql: string, limit: number): string

  /**
   * Statements that put the session in read-only mode, in order. Empty when
   * the engine has no such switch (`capabilities.readOnlySession: false`),
   * in which case the guard and a read-only login are the enforcement.
   */
  readonly beginReadOnly: readonly string[]
  readonly beginWrite: readonly string[]
  readonly commit: string
  readonly rollback: string

  /** The schema a bare table name resolves to, once connected. */
  defaultSchema(exec: Exec): Promise<string>

  listTables(exec: Exec, options?: ListTablesOptions): Promise<TableMeta[]>

  describeColumns(exec: Exec, table: TableRef): Promise<ColumnMeta[]>

  /** Normalise a driver error into something safe to show. */
  toError(e: unknown): Error
}
