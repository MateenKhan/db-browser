/**
 * Descriptor validity.
 *
 * A descriptor is *data*, which means nothing type-checks its contents beyond
 * their shapes: a typo in a type-map key, a missing `secret: true` on a
 * password field, or a connection form with two fields called `port` all
 * compile perfectly and fail at runtime, or — worse — silently. These tests
 * are the schema the type system cannot express.
 *
 * The most important one is `does not import a driver`: it is what makes
 * `GET /api/connectors` work on a machine with nothing installed, and it is
 * the kind of property that gets broken by an innocent-looking `import type`.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NORMALIZED_TYPES, asDialect, SQL_DIALECTS } from '@jugaaadi/db-browser/core'
import { CONNECTOR_DESCRIPTORS, getDescriptor } from '../src/descriptors/index.js'
import { hasDialect, dialectFor } from '../src/dialects/index.js'
import { SUPPORTED_ENGINES } from '../src/registry.js'
import { ENGINE_IDS } from '../src/types.js'

const DESCRIPTOR_DIR = fileURLToPath(new URL('../src/descriptors/', import.meta.url))

describe('the catalogue', () => {
  it('describes every engine id, exactly once', () => {
    const ids = CONNECTOR_DESCRIPTORS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...ENGINE_IDS].sort())
  })

  it('lists at least the six engines the brief named', () => {
    for (const id of ['postgres', 'mysql', 'mariadb', 'sqlite', 'mssql', 'duckdb']) {
      expect(getDescriptor(id), id).toBeDefined()
    }
  })

  it('has a dialect for every engine on the shared base', () => {
    for (const id of SUPPORTED_ENGINES) {
      // SQLite is the documented exception: it is supported, but by
      // `@jugaaadi/db-browser-sqlite`'s in-process adapter rather than by the
      // shared, async, pooled base. See `openConnection.ts` for why.
      if (id === 'sqlite') {
        expect(hasDialect(id)).toBe(false)
        continue
      }
      expect(hasDialect(id), id).toBe(true)
      expect(() => dialectFor(id), id).not.toThrow()
    }
  })

  it('says specifically when an engine is described but not implemented', () => {
    // "Installing mssql would not give you a SQL Server browser" needs a
    // different message from "mssql is not a database engine", because the two
    // need different UI — an explanation versus a 404.
    for (const d of CONNECTOR_DESCRIPTORS) {
      if (SUPPORTED_ENGINES.includes(d.id)) continue
      expect(() => dialectFor(d.id), d.id).toThrow(/no adapter in this build/i)
    }
    expect(() => dialectFor('not-a-database')).toThrow(/not a database engine/i)
  })
})

describe('every descriptor', () => {
  it.each(CONNECTOR_DESCRIPTORS.map((d) => [d.id, d] as const))(
    '%s is internally consistent',
    (_id, d) => {
      expect(d.label.trim()).toBeTruthy()
      expect(d.description.trim()).toBeTruthy()
      expect(d.driverRange.trim()).toBeTruthy()
      // The dialect must be one the formatter and editor actually know, or the
      // console silently falls back to generic SQL.
      expect(SQL_DIALECTS).toContain(d.dialect)
      expect(asDialect(d.dialect)).toBe(d.dialect)
      // A null driverPackage means a built-in. Only SQLite is one; anything
      // else with a null package would have no install path at all.
      if (d.driverPackage === null) expect(d.id).toBe('sqlite')
    },
  )

  it.each(CONNECTOR_DESCRIPTORS.map((d) => [d.id, d] as const))(
    '%s has a usable connection form',
    (_id, d) => {
      expect(d.connectionFields.length).toBeGreaterThan(0)
      const keys = d.connectionFields.map((f) => f.key)
      expect(new Set(keys).size, `duplicate field keys in ${d.id}`).toBe(keys.length)
      for (const f of d.connectionFields) {
        expect(f.label.trim(), `${d.id}.${f.key}`).toBeTruthy()
        if (f.kind === 'select') {
          expect(f.options?.length, `${d.id}.${f.key} is a select with no options`).toBeGreaterThan(
            0,
          )
        }
        // A default must be assignable to the field it defaults.
        if (f.kind === 'number' && f.default !== undefined) {
          expect(typeof f.default, `${d.id}.${f.key}`).toBe('number')
        }
        if (f.kind === 'boolean' && f.default !== undefined) {
          expect(typeof f.default, `${d.id}.${f.key}`).toBe('boolean')
        }
      }
      // Every connection is read-only unless told otherwise — no exceptions.
      const readOnly = d.connectionFields.find((f) => f.key === 'readOnly')
      expect(readOnly, `${d.id} has no readOnly field`).toBeDefined()
      expect(readOnly?.default, `${d.id} does not default to read-only`).toBe(true)
    },
  )

  it.each(CONNECTOR_DESCRIPTORS.map((d) => [d.id, d] as const))(
    '%s marks every credential field secret',
    (_id, d) => {
      // The bug this prevents: a password field without `secret: true` is
      // returned verbatim by `GET /api/connections`. There is no allowlist of
      // field names anywhere else — this flag is the whole mechanism.
      for (const f of d.connectionFields) {
        const looksSecret = /password|secret|token|passphrase|apikey|api_key/i.test(f.key)
        if (looksSecret) expect(f.secret, `${d.id}.${f.key}`).toBe(true)
        if (f.kind === 'password') expect(f.secret, `${d.id}.${f.key}`).toBe(true)
      }
    },
  )

  it.each(CONNECTOR_DESCRIPTORS.map((d) => [d.id, d] as const))(
    '%s has a type map whose values are all in the vocabulary',
    (_id, d) => {
      const entries = Object.entries(d.typeMap)
      expect(entries.length, `${d.id} has an empty type map`).toBeGreaterThan(5)
      for (const [key, value] of entries) {
        // Keys are looked up lower-cased and de-parameterised, so an
        // upper-case or parameterised key is simply dead.
        expect(key, `${d.id} type-map key "${key}" is not lower-case`).toBe(key.toLowerCase())
        expect(key, `${d.id} type-map key "${key}" carries parameters`).not.toMatch(/[()[\]]/)
        expect(NORMALIZED_TYPES, `${d.id}.${key} -> ${value}`).toContain(value)
      }
    },
  )
})

describe('a descriptor never imports its driver', () => {
  /**
   * The property that makes the registry listable with nothing installed. A
   * static scan rather than a runtime probe, because the failure it catches
   * is a top-level `import` that a bundler follows — which would break the
   * listing on a machine that has never installed a driver, i.e. exactly the
   * machine that needs the listing most.
   */
  const driverPackages = ['pg', 'mysql2', 'mssql', 'oracledb', '@duckdb/node-api', 'better-sqlite3']

  it.each(readdirSync(DESCRIPTOR_DIR).filter((f) => f.endsWith('.ts')))(
    'descriptors/%s imports no driver',
    (file) => {
      const source = readFileSync(join(DESCRIPTOR_DIR, file), 'utf8')
      const imports = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1],
      )
      for (const specifier of imports) {
        expect(driverPackages, `${file} imports ${specifier}`).not.toContain(specifier)
        expect(specifier, `${file} imports a node builtin driver`).not.toMatch(/^node:sqlite$/)
      }
    },
  )

  it('can list every connector without a driver on disk', async () => {
    // The end-to-end version of the same property: importing the registry and
    // enumerating it must not touch a driver. `mysql2` is genuinely absent in
    // this repo, so this is a real assertion rather than a mocked one.
    const { connectorStatuses } = await import('../src/registry.js')
    const statuses = connectorStatuses()
    expect(statuses.length).toBe(CONNECTOR_DESCRIPTORS.length)
    const mysql = statuses.find((s) => s.descriptor.id === 'mysql')
    expect(mysql).toBeDefined()
    expect(mysql?.descriptor.driverPackage).toBe('mysql2')
  })
})
