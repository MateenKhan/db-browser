/**
 * Engine id → `Dialect`.
 *
 * The one lookup in the package, and it is deliberately a `switch` over a
 * closed union rather than a mutable registry: a registry would let a
 * half-installed plugin answer for an engine, and the failure mode of *that*
 * is a connection that opens against the wrong grammar.
 *
 * An engine listed in `SUPPORTED_ENGINES` (`registry.ts`) must have an entry
 * here. `__tests__/descriptors.test.ts` asserts both directions, so adding one
 * without the other is a failing test rather than a runtime `undefined`.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'
import { cockroachDescriptor, postgresDescriptor } from '../descriptors/postgres.js'
import { mariadbDescriptor, mysqlDescriptor } from '../descriptors/mysql.js'
import { requireDescriptor } from '../registry.js'
import type { EngineId } from '../types.js'
import { createPostgresDialect } from './postgres.js'
import { createMysqlDialect } from './mysql.js'
import type { Dialect } from './types.js'

/**
 * Build the dialect for one engine.
 *
 * SQLite is deliberately absent: it is served by `@jugaaadi/db-browser-sqlite`,
 * whose adapter is in-process and synchronous and carries behaviour this
 * generic base does not model (the `rowid` fallback, SQLite's five-rule
 * affinity algorithm, BigInt narrowing, and embedding-store / code-graph
 * detection). It implements the same `DataSource` contract and shares the same
 * guard, pagination planner, identifier rules and pending-changes model — it
 * is a different *implementation*, not a different contract. `openConnection`
 * routes to it, so a caller never sees the difference.
 */
export function dialectFor(id: EngineId | string): Dialect {
  switch (id) {
    case 'postgres':
      return createPostgresDialect('postgres', postgresDescriptor)
    case 'cockroach':
      return createPostgresDialect('cockroach', cockroachDescriptor)
    case 'mysql':
      return createMysqlDialect('mysql', mysqlDescriptor)
    case 'mariadb':
      return createMysqlDialect('mariadb', mariadbDescriptor)
    default: {
      // `requireDescriptor` distinguishes "not an engine" from "an engine with
      // no adapter yet", and the two need different messages.
      const descriptor = requireDescriptor(String(id))
      throw new DbBrowserError(
        'ENGINE_NOT_SUPPORTED',
        `${descriptor.label} is described by this registry but has no adapter in this build yet.`,
      )
    }
  }
}

/** True when `dialectFor` will answer without throwing. */
export function hasDialect(id: string): boolean {
  return id === 'postgres' || id === 'cockroach' || id === 'mysql' || id === 'mariadb'
}

export { createPostgresDialect } from './postgres.js'
export { createMysqlDialect, isMysqlBoolean, parseEnumLabels } from './mysql.js'
export * from './shared.js'
export type { Binder, Dialect, Exec, ExecResult, ListTablesOptions } from './types.js'
