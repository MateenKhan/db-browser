/**
 * Loads `@jugaaadi/table` **after** the localStorage scope is installed.
 *
 * This ordering is not a style choice. The table reads `tableCustomFunctions`
 * from `localStorage` at module-evaluation time, and ESM hoists every static
 * import above the module body — so a plain `import { SpreadsheetTable } from
 * '@jugaaadi/table'` anywhere in this package would run that read before any
 * of our code could scope it. The dynamic `import()` inside the lazy factory
 * is what guarantees the shim is in place first.
 *
 * Consumers may still `import '@jugaaadi/table/style.css'` statically: a CSS
 * entry does not evaluate the JavaScript module.
 */

import { lazy } from 'react'
import type { ComponentType } from 'react'
import { installTableStorageScope, scopeIdFor } from '../storage/tableStorage.js'
import type { ScopeMode, TableStorageScope } from '../storage/tableStorage.js'
import type { TableRef } from '../types.js'

let scope: TableStorageScope | null = null
let pendingScopeId = 'default'
let pendingMode: ScopeMode = 'namespace'

/** Install (once) or re-point the scope. Safe to call on every render. */
export function useTableStorageScope(connectionId: string, table: TableRef | null, mode: ScopeMode = 'namespace'): void {
  const id = scopeIdFor(connectionId, table)
  pendingScopeId = id
  pendingMode = mode
  if (scope) {
    scope.setScope(id)
    scope.setMode(mode)
  }
}

/** The installed scope, for tests and for a "clear this table's view state" action. */
export function getTableStorageScope(): TableStorageScope | null {
  return scope
}

function ensureInstalled(): void {
  if (scope) return
  scope = installTableStorageScope({ scopeId: pendingScopeId, mode: pendingMode })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpreadsheetTableComponent = ComponentType<any>

export const LazySpreadsheetTable = lazy(async () => {
  ensureInstalled()
  const mod = (await import('@jugaaadi/table')) as unknown as {
    SpreadsheetTable: SpreadsheetTableComponent
  }
  return { default: mod.SpreadsheetTable }
})
