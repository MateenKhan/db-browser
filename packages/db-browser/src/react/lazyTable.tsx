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

import { lazy, useEffect, useState } from 'react'
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

/**
 * The grid's own column-type registry, loaded through the same late door.
 *
 * `metadata/columnTypePresets.ts` decides which **preset id** a database column
 * opens with; the registry is what turns that id into the preset itself —
 * including any custom unit the *user* defined in the grid, which is precisely
 * why the id is resolved at render time instead of being frozen into a table
 * here. Reusing it also means a preset whose label or options change in
 * `@jugaaadi/table` changes in these column headers for free.
 *
 * It is loaded lazily for the same non-negotiable reason `SpreadsheetTable` is:
 * a static `import` of `@jugaaadi/table` anywhere in this package runs its
 * module body — and its `localStorage` reads — before the storage scope is
 * installed. See this file's header.
 */
export interface ColumnTypePresetLike {
  id: string
  label: string
  group: string
  builtin: boolean
}

type RegistryModule = {
  getColumnTypePreset: (id: string) => ColumnTypePresetLike | undefined
}

let registry: RegistryModule | null = null
let registryLoad: Promise<RegistryModule> | null = null

function loadRegistry(): Promise<RegistryModule> {
  if (registryLoad) return registryLoad
  registryLoad = (async () => {
    ensureInstalled()
    const mod = (await import('@jugaaadi/table')) as unknown as RegistryModule
    registry = mod
    return mod
  })()
  return registryLoad
}

/**
 * Resolve preset ids through the grid's registry.
 *
 * Returns a synchronous lookup function. Before the grid module has loaded it
 * answers `undefined` for everything, and the caller falls back to the raw id —
 * a column header must never wait on a dynamic import to render its name.
 */
export function useColumnTypePresets(): (id: string) => ColumnTypePresetLike | undefined {
  const [, setLoaded] = useState(registry !== null)
  useEffect(() => {
    let cancelled = false
    void loadRegistry()
      .then(() => {
        if (!cancelled) setLoaded(true)
      })
      .catch(() => {
        /* the grid itself will surface the failure; headers keep the raw id */
      })
    return () => {
      cancelled = true
    }
  }, [])
  return (id: string) => registry?.getColumnTypePreset?.(id)
}
