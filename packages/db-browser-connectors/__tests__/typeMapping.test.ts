/**
 * Type normalisation, and the mapping onto `@jugaaadi/table`'s presets.
 *
 * The property that matters most here is the **fallback**: an unknown type
 * must become `'unknown'` and render as text, never throw. A database browser
 * that white-screens because someone installed PostGIS is not a browser.
 */

import { describe, expect, it } from 'vitest'
import {
  NORMALIZED_TYPES,
  NORMALIZED_TYPE_PRESET,
  asNormalizedType,
  isBinaryNormalizedType,
  normalizeDbType,
  normalizedTypeFor,
  presetIdForNormalizedType,
  resolveColumnPreset,
  typeOptionsForNormalizedType,
} from '@jugaaadi/db-browser/core'
import {
  DUCKDB_TYPE_MAP,
  MSSQL_TYPE_MAP,
  MYSQL_TYPE_MAP,
  ORACLE_TYPE_MAP,
  POSTGRES_TYPE_MAP,
  SQLITE_TYPE_MAP,
} from '../src/descriptors/index.js'

describe('normalizeDbType strips what a type map should not have to enumerate', () => {
  it.each([
    // `varying` and `precision` are parts of the type *name*, not modifiers —
    // stripping them would turn these into `character` and `double`.
    ['character varying(255)', 'character varying', false],
    ['double precision', 'double precision', false],
    ['varchar(255)', 'varchar', false],
    ['numeric(10, 2)', 'numeric', false],
    ['NUMBER(19)', 'number', false],
    ['int unsigned', 'int', false],
    ['bigint UNSIGNED zerofill', 'bigint', false],
    ['timestamp without time zone', 'timestamp', false],
    ['timestamp with time zone', 'timestamp', false],
    ['text[]', 'text', true],
    ['_text', 'text', true],
    ['numeric(10,2)[]', 'numeric', true],
    ['  JSONB  ', 'jsonb', false],
    ['', '', false],
  ])('%s -> %s (array: %s)', (raw, base, isArray) => {
    expect(normalizeDbType(raw)).toEqual({ base, isArray })
  })

  it('does not mistake an underscore-prefixed user type for an array', () => {
    // `_1` is not `1[]`. The guard is narrow on purpose — a real user type
    // called `_internal` exists in the wild and flattening it to `array` would
    // render every value as a list.
    expect(normalizeDbType('_1').isArray).toBe(false)
  })
})

describe('normalizedTypeFor', () => {
  it('maps the common Postgres spellings', () => {
    expect(normalizedTypeFor('int4', POSTGRES_TYPE_MAP)).toBe('integer')
    expect(normalizedTypeFor('character varying(255)', POSTGRES_TYPE_MAP)).toBe('string')
    expect(normalizedTypeFor('timestamp with time zone', POSTGRES_TYPE_MAP)).toBe('timestamp')
    expect(normalizedTypeFor('jsonb', POSTGRES_TYPE_MAP)).toBe('json')
    expect(normalizedTypeFor('bytea', POSTGRES_TYPE_MAP)).toBe('binary')
    expect(normalizedTypeFor('uuid', POSTGRES_TYPE_MAP)).toBe('uuid')
  })

  it('maps the common MySQL spellings', () => {
    expect(normalizedTypeFor('bigint', MYSQL_TYPE_MAP)).toBe('integer')
    expect(normalizedTypeFor('decimal(10,2)', MYSQL_TYPE_MAP)).toBe('decimal')
    expect(normalizedTypeFor('varchar', MYSQL_TYPE_MAP)).toBe('string')
    expect(normalizedTypeFor('longtext', MYSQL_TYPE_MAP)).toBe('text')
    expect(normalizedTypeFor('datetime', MYSQL_TYPE_MAP)).toBe('timestamp')
    expect(normalizedTypeFor('longblob', MYSQL_TYPE_MAP)).toBe('binary')
    // The judgement call, asserted so it cannot drift: `tinyint` is an
    // integer in the map, and only `column_type` can make it a boolean.
    expect(normalizedTypeFor('tinyint', MYSQL_TYPE_MAP)).toBe('integer')
  })

  it('turns an array of a mapped base into `array`', () => {
    expect(normalizedTypeFor('_text', POSTGRES_TYPE_MAP)).toBe('array')
    expect(normalizedTypeFor('integer[]', POSTGRES_TYPE_MAP)).toBe('array')
  })

  it('keeps `vector` for an array type a descriptor pinned as one', () => {
    // pgvector's `vector` must not be flattened to `array` — the whole reason
    // it has its own entry is so a cell reads `768 dims` instead of a wall.
    expect(normalizedTypeFor('vector', POSTGRES_TYPE_MAP)).toBe('vector')
    expect(normalizedTypeFor('vector(1536)', POSTGRES_TYPE_MAP)).toBe('vector')
  })

  it('falls back to `unknown` for a type nobody mapped, and never throws', () => {
    // The documented contract. PostGIS, hstore, ltree, an extension released
    // tomorrow, and outright garbage all take this path.
    for (const raw of ['geometry', 'hstore', 'ltree', 'tsrange', 'nonsense_type_9000', '???']) {
      expect(() => normalizedTypeFor(raw, POSTGRES_TYPE_MAP)).not.toThrow()
      expect(normalizedTypeFor(raw, POSTGRES_TYPE_MAP), raw).toBe('unknown')
    }
    expect(normalizedTypeFor(null, POSTGRES_TYPE_MAP)).toBe('unknown')
    expect(normalizedTypeFor(undefined, POSTGRES_TYPE_MAP)).toBe('unknown')
    expect(normalizedTypeFor('', POSTGRES_TYPE_MAP)).toBe('unknown')
    expect(normalizedTypeFor('anything', {})).toBe('unknown')
  })

  it('normalises a normalized type that arrived over the wire', () => {
    expect(asNormalizedType('timestamp')).toBe('timestamp')
    expect(asNormalizedType('TIMESTAMP')).toBe('unknown')
    expect(asNormalizedType(null)).toBe('unknown')
    expect(asNormalizedType({})).toBe('unknown')
  })
})

describe('every shipped type map', () => {
  const maps = {
    postgres: POSTGRES_TYPE_MAP,
    mysql: MYSQL_TYPE_MAP,
    sqlite: SQLITE_TYPE_MAP,
    mssql: MSSQL_TYPE_MAP,
    duckdb: DUCKDB_TYPE_MAP,
    oracle: ORACLE_TYPE_MAP,
  }

  it.each(Object.entries(maps))('%s resolves each of its own keys', (engine, map) => {
    for (const key of Object.keys(map)) {
      expect(normalizedTypeFor(key, map), `${engine}.${key}`).toBe(map[key])
    }
  })

  it.each(Object.entries(maps))('%s covers the basics every engine has', (engine, map) => {
    const covered = new Set(Object.values(map))
    for (const required of ['integer', 'decimal', 'string', 'text', 'timestamp', 'binary']) {
      expect(covered, `${engine} has no ${required}`).toContain(required)
    }
  })

  it('does not invent a plain `date` for an engine that has none', () => {
    // Oracle's `DATE` carries a time component — it is a timestamp, and the
    // map says so. A blanket "every engine must map something to `date`" would
    // have forced a wrong entry here, which is why the check above omits it.
    expect(ORACLE_TYPE_MAP.date).toBe('timestamp')
    expect(Object.values(ORACLE_TYPE_MAP)).not.toContain('date')
    // The engines that genuinely have a date-without-time type do map one.
    for (const [engine, map] of [
      ['postgres', POSTGRES_TYPE_MAP],
      ['mysql', MYSQL_TYPE_MAP],
      ['mssql', MSSQL_TYPE_MAP],
      ['duckdb', DUCKDB_TYPE_MAP],
    ] as const) {
      expect(map.date, engine).toBe('date')
    }
  })
})

describe('the mapping onto @jugaaadi/table presets', () => {
  it('has an entry for every normalized type', () => {
    for (const type of NORMALIZED_TYPES) {
      expect(NORMALIZED_TYPE_PRESET[type], type).toBeTruthy()
      expect(typeOptionsForNormalizedType(type).type, type).toBeTruthy()
    }
  })

  it('only names presets @jugaaadi/table actually ships', () => {
    // The ids in `BUILTIN_PRESETS`. A rename in the grid must fail here rather
    // than silently resolving to `undefined` and giving every column the
    // default editor.
    const builtin = new Set([
      'text', 'number', 'decimal', 'currency', 'percent',
      'date', 'datetime', 'mixed', 'file', 'image',
    ])
    for (const type of NORMALIZED_TYPES) {
      expect(builtin, `${type} -> ${NORMALIZED_TYPE_PRESET[type]}`).toContain(
        NORMALIZED_TYPE_PRESET[type],
      )
    }
  })

  it('keeps integer and decimal apart', () => {
    // The grid's `number` editor truncates its operand, so routing a
    // `numeric(10,2)` through it would silently drop the cents.
    expect(presetIdForNormalizedType('integer')).toBe('number')
    expect(presetIdForNormalizedType('decimal')).toBe('decimal')
  })

  it('renders an unknown type as text rather than refusing to render it', () => {
    expect(presetIdForNormalizedType('unknown')).toBe('text')
    expect(presetIdForNormalizedType(undefined)).toBe('text')
  })

  it('never offers a file picker for a binary cell', () => {
    // The `file` preset would invite a user to upload a replacement for a cell
    // this library deliberately never streams inline.
    for (const type of ['binary', 'vector'] as const) {
      expect(presetIdForNormalizedType(type), type).not.toBe('file')
      expect(isBinaryNormalizedType(type)).toBe(true)
      const resolved = resolveColumnPreset({ normalizedType: type })
      expect(resolved.editable, type).toBe(false)
      expect(resolved.notEditableReason, type).toMatch(/binary/i)
    }
  })

  it('locks a generated column and explains why', () => {
    const resolved = resolveColumnPreset({ normalizedType: 'integer', readOnly: true })
    expect(resolved.editable).toBe(false)
    expect(resolved.notEditableReason).toMatch(/generated/i)
  })

  it('leaves a primary key editable', () => {
    // Changing a PK is rare but legitimate, and the pending-changes model
    // already makes the user review it before it is committed.
    expect(resolveColumnPreset({ normalizedType: 'integer', isPrimaryKey: true }).editable).toBe(
      true,
    )
  })
})
