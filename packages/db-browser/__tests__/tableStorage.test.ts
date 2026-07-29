import { beforeEach, describe, expect, it } from 'vitest'
import {
  installTableStorageScope,
  isTableStorageKey,
  purgeUnscopedTableKeys,
  scopedKey,
  scopeIdFor,
  TABLE_SHEET_KEY,
  TABLE_STORAGE_KEYS,
} from '../src/storage/tableStorage.js'
import type { StorageLike } from '../src/storage/tableStorage.js'

/** A minimal, inspectable `localStorage`. */
function fakeStorage(): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size
    },
    dump: () => Object.fromEntries(map),
  }
}

describe('key inventory', () => {
  it('knows every key the embedded table writes', () => {
    expect(TABLE_STORAGE_KEYS).toContain('tableFormatting')
    expect(TABLE_STORAGE_KEYS).toContain('tableSavedQueries')
    expect(TABLE_STORAGE_KEYS).toContain('tableCustomFunctions')
    expect(isTableStorageKey('tableColumnMerges')).toBe(true)
    expect(isTableStorageKey(TABLE_SHEET_KEY)).toBe(true)
    expect(isTableStorageKey('my-apps-own-key')).toBe(false)
  })

  it('builds a scope id per connection AND table', () => {
    expect(scopeIdFor('pg://platformdb', { schema: 'public', name: 'feature' })).toBe(
      'pg://platformdb|public.feature',
    )
    expect(scopeIdFor('pg://platformdb', null)).toBe('pg://platformdb|_')
    expect(scopedKey('tableFormatting', 'a|b')).toBe('dbb:a|b:tableFormatting')
  })
})

describe('namespacing', () => {
  let storage: ReturnType<typeof fakeStorage>
  let target: { localStorage: StorageLike }

  beforeEach(() => {
    storage = fakeStorage()
    target = { localStorage: storage }
  })

  it('rewrites table keys per scope and leaves other keys alone', () => {
    const scope = installTableStorageScope({
      target,
      scopeId: scopeIdFor('conn', { schema: 'public', name: 'feature' }),
    })
    target.localStorage.setItem('tableFormatting', '{"id":"red"}')
    target.localStorage.setItem('unrelated', 'keep me')

    expect(storage.dump()).toEqual({
      'dbb:conn|public.feature:tableFormatting': '{"id":"red"}',
      unrelated: 'keep me',
    })
    expect(target.localStorage.getItem('tableFormatting')).toBe('{"id":"red"}')
    expect(target.localStorage.getItem('unrelated')).toBe('keep me')
    scope.uninstall()
  })

  it('does not leak formatting from one table to another (the "id" column problem)', () => {
    const scope = installTableStorageScope({
      target,
      scopeId: scopeIdFor('conn', { schema: 'public', name: 'feature' }),
    })
    target.localStorage.setItem('tableFormatting', '{"id":"red"}')

    scope.setScope(scopeIdFor('conn', { schema: 'public', name: 'account' }))
    expect(target.localStorage.getItem('tableFormatting')).toBeNull()

    scope.setScope(scopeIdFor('conn', { schema: 'public', name: 'feature' }))
    expect(target.localStorage.getItem('tableFormatting')).toBe('{"id":"red"}')
    scope.uninstall()
  })

  it('does not leak across connections', () => {
    const scope = installTableStorageScope({
      target,
      scopeId: scopeIdFor('prod', { schema: 'public', name: 'feature' }),
    })
    target.localStorage.setItem('tableSavedQueries', '[{"sql":"select 1"}]')
    scope.setScope(scopeIdFor('staging', { schema: 'public', name: 'feature' }))
    expect(target.localStorage.getItem('tableSavedQueries')).toBeNull()
    scope.uninstall()
  })

  it('NEVER persists row data, in any mode', () => {
    const scope = installTableStorageScope({ target, scopeId: 'x' })
    target.localStorage.setItem(TABLE_SHEET_KEY, JSON.stringify({ version: 1, data: [{ a: 1 }] }))
    expect(target.localStorage.getItem(TABLE_SHEET_KEY)).toBeNull()
    expect(Object.keys(storage.dump())).toHaveLength(0)
    scope.uninstall()
  })

  it('suppress mode drops everything the table tries to persist', () => {
    const scope = installTableStorageScope({ target, scopeId: 'x', mode: 'suppress' })
    for (const key of TABLE_STORAGE_KEYS) target.localStorage.setItem(key, 'v')
    expect(Object.keys(storage.dump())).toHaveLength(0)
    for (const key of TABLE_STORAGE_KEYS) expect(target.localStorage.getItem(key)).toBeNull()
    scope.uninstall()
  })

  it('purges pre-existing unscoped keys on install — no stale state is inherited', () => {
    storage.setItem('tableFormatting', 'stale from a previous build')
    storage.setItem(TABLE_SHEET_KEY, 'stale rows from another table')
    storage.setItem('app-setting', 'mine')

    const scope = installTableStorageScope({ target, scopeId: 'x' })
    expect(storage.dump()).toEqual({ 'app-setting': 'mine' })
    scope.uninstall()
  })

  it('lists and clears only the current scope', () => {
    const scope = installTableStorageScope({ target, scopeId: 'a' })
    target.localStorage.setItem('tableFormatting', '1')
    scope.setScope('b')
    target.localStorage.setItem('tableFormatting', '2')

    expect(scope.keys()).toEqual(['dbb:b:tableFormatting'])
    scope.clearScope()
    expect(storage.dump()).toEqual({ 'dbb:a:tableFormatting': '1' })
    scope.uninstall()
  })

  it('restores the original storage on uninstall', () => {
    const scope = installTableStorageScope({ target, scopeId: 'a' })
    scope.uninstall()
    target.localStorage.setItem('tableFormatting', 'raw')
    expect(storage.dump()).toEqual({ tableFormatting: 'raw' })
  })

  it('is a no-op where localStorage does not exist (SSR)', () => {
    const scope = installTableStorageScope({ target: {} })
    expect(scope.keys()).toEqual([])
    expect(() => scope.clearScope()).not.toThrow()
  })
})

describe('purgeUnscopedTableKeys', () => {
  it('reports what it removed', () => {
    const storage = fakeStorage()
    storage.setItem('tableFormatting', 'x')
    storage.setItem('keep', 'y')
    expect(purgeUnscopedTableKeys(storage)).toEqual(['tableFormatting'])
    expect(storage.dump()).toEqual({ keep: 'y' })
  })
})
