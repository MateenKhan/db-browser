/**
 * Containment for `@jugaaadi/table`'s `localStorage` persistence.
 *
 * ## Why this exists
 *
 * The table is a *spreadsheet*, so persisting the user's sheet across reloads
 * is the right default for it. For a **database browser** it is actively
 * wrong: rows are a snapshot of a live server, and a snapshot that resurrects
 * itself after a reload looks exactly like current data while being anything
 * but.
 *
 * Two separate problems, handled separately:
 *
 * ### 1. Row data
 * Verified against `@jugaaadi/table@0.0.1`'s bundle: the exported
 * `SpreadsheetTable` renders the internal app with `standalone: false`, and
 * both the read (`loadCustomSheet`) and the debounced write of the sheet key
 * `tt.customSheet.v1` are gated on that flag. **In library mode the table does
 * not persist rows at all.** We do not rely on that alone — `purgeSheetKey()`
 * deletes the key defensively, and the grid is re-keyed per table+page so its
 * state cannot outlive a navigation.
 *
 * ### 2. Everything else
 * These seven keys are *not* gated and are keyed by **column id**:
 *
 * `tableFormatting`, `tableColumnMerges`, `tableColumnTypeOverrides`,
 * `tableCustomColumnTypes`, `tableCustomFunctions`, `tableFormatProfiles`,
 * `tableSavedQueries`.
 *
 * Two different tables both having an `id` or `name` column is the normal
 * case, so formatting painted on one table's `id` would reappear on every
 * other table's `id`, in every database. Scoping rewrites those keys to
 * `dbb:<connection>/<schema>.<table>:<key>` so state follows the table it was
 * made on, and never crosses a connection.
 *
 * ## Ordering requirement
 * `@jugaaadi/table` reads `tableCustomFunctions` **at module-evaluation time**.
 * ESM hoists imports, so a static `import '@jugaaadi/table'` anywhere in the
 * graph runs before any of our code. `installTableStorageScope()` must
 * therefore run *before* the table module is imported — which is why
 * `DbBrowser` loads the table with a dynamic `import()` behind `React.lazy`.
 */

/** Every key `@jugaaadi/table@0.0.1` writes, verified against its bundle. */
export const TABLE_STORAGE_KEYS = [
  'tableFormatting',
  'tableColumnMerges',
  'tableColumnTypeOverrides',
  'tableCustomColumnTypes',
  'tableCustomFunctions',
  'tableFormatProfiles',
  'tableSavedQueries',
] as const

/** The key that holds actual **row data**. Never allowed to persist here. */
export const TABLE_SHEET_KEY = 'tt.customSheet.v1'

export type ScopeMode =
  | 'namespace'
  /** Reads return null and writes are dropped — nothing survives a reload. */
  | 'suppress'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  clear?(): void
  key?(index: number): string | null
  readonly length?: number
}

export interface InstallOptions {
  /** Object carrying `localStorage`; defaults to `globalThis`. */
  target?: { localStorage?: StorageLike } | undefined
  mode?: ScopeMode
  prefix?: string
  /** Current scope id, e.g. `pg://platformdb|public.feature`. */
  scopeId?: string
}

export interface TableStorageScope {
  setScope(scopeId: string): void
  getScope(): string
  setMode(mode: ScopeMode): void
  /** Keys currently held under this scope. */
  keys(): string[]
  /** Remove everything stored for the current scope. */
  clearScope(): void
  uninstall(): void
}

const KEY_SET = new Set<string>([...TABLE_STORAGE_KEYS, TABLE_SHEET_KEY])

/** The rewritten key a table key maps to under `scopeId`. Pure — testable. */
export function scopedKey(key: string, scopeId: string, prefix = 'dbb'): string {
  return `${prefix}:${scopeId}:${key}`
}

/** True when `key` is one the embedded table owns. */
export function isTableStorageKey(key: string): boolean {
  return KEY_SET.has(key)
}

/**
 * Delete the table's *unscoped* keys — anything a previous build (or another
 * app on the same origin) left behind, which would otherwise be picked up as
 * this connection's state.
 */
export function purgeUnscopedTableKeys(storage: StorageLike | undefined = getDefaultStorage()): string[] {
  if (!storage) return []
  const removed: string[] = []
  for (const key of KEY_SET) {
    if (storage.getItem(key) !== null) {
      storage.removeItem(key)
      removed.push(key)
    }
  }
  return removed
}

function getDefaultStorage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage
  } catch {
    return undefined
  }
}

/**
 * Install the scoping shim over `target.localStorage`.
 *
 * Only the table's own keys are touched; every other key on the origin passes
 * through untouched, so the host application's storage is unaffected.
 */
export function installTableStorageScope(options: InstallOptions = {}): TableStorageScope {
  const target = (options.target ?? (globalThis as { localStorage?: StorageLike })) as {
    localStorage?: StorageLike
  }
  const real = target.localStorage
  const prefix = options.prefix ?? 'dbb'
  let scopeId = options.scopeId ?? 'default'
  let mode: ScopeMode = options.mode ?? 'namespace'

  if (!real) {
    // SSR / non-browser: nothing to scope.
    return {
      setScope: (id) => {
        scopeId = id
      },
      getScope: () => scopeId,
      setMode: (m) => {
        mode = m
      },
      keys: () => [],
      clearScope: () => {},
      uninstall: () => {},
    }
  }

  // Anything left unscoped is not ours and must not be inherited.
  purgeUnscopedTableKeys(real)

  const map = (key: string): string | null => {
    if (!isTableStorageKey(key)) return key
    // Row data never persists, in any mode.
    if (key === TABLE_SHEET_KEY) return null
    if (mode === 'suppress') return null
    return scopedKey(key, scopeId, prefix)
  }

  const shim = new Proxy(real as StorageLike & Record<string, unknown>, {
    get(t, prop, receiver) {
      if (prop === 'getItem') {
        return (key: string) => {
          const mapped = map(String(key))
          return mapped === null ? null : t.getItem(mapped)
        }
      }
      if (prop === 'setItem') {
        return (key: string, value: string) => {
          const mapped = map(String(key))
          if (mapped === null) return
          t.setItem(mapped, value)
        }
      }
      if (prop === 'removeItem') {
        return (key: string) => {
          const mapped = map(String(key))
          if (mapped === null) return
          t.removeItem(mapped)
        }
      }
      const value = Reflect.get(t as object, prop, receiver)
      return typeof value === 'function' ? value.bind(t) : value
    },
  }) as unknown as StorageLike

  let installed = true
  try {
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      get: () => (installed ? shim : real),
    })
  } catch {
    installed = false
  }

  const scopePrefix = () => `${prefix}:${scopeId}:`

  const listKeys = (): string[] => {
    const out: string[] = []
    const len = typeof real.length === 'number' ? real.length : 0
    for (let i = 0; i < len; i++) {
      const k = real.key?.(i)
      if (k && k.startsWith(scopePrefix())) out.push(k)
    }
    return out
  }

  return {
    setScope(id: string) {
      scopeId = id || 'default'
    },
    getScope: () => scopeId,
    setMode(m: ScopeMode) {
      mode = m
    },
    keys: listKeys,
    clearScope() {
      for (const k of listKeys()) real.removeItem(k)
    },
    uninstall() {
      installed = false
      try {
        Object.defineProperty(target, 'localStorage', {
          configurable: true,
          value: real,
          writable: true,
        })
      } catch {
        /* leave the getter in place; it returns `real` once uninstalled */
      }
    },
  }
}

/** Build the scope id for a connection + table. */
export function scopeIdFor(connectionId: string, table?: { schema: string; name: string } | null): string {
  return table ? `${connectionId}|${table.schema}.${table.name}` : `${connectionId}|_`
}
