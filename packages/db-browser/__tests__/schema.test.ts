import { finalizeColumn } from '../src/schema.js'
import { describe, expect, it } from 'vitest'
import {
  buildTableSchema,
  categoryForType,
  describeUpdatability,
  primaryKeyOf,
  rowKeyOf,
} from '../src/schema.js'
import type { ColumnMeta } from '../src/types.js'

function col(name: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return finalizeColumn({
    name,
    dataType: 'text',
    udtName: 'text',
    category: 'string',
    nullable: true,
    isPrimaryKey: false,
    ordinal: 1,
    ...over,
  })
}

describe('categoryForType', () => {
  it.each([
    ['int4', undefined, 'number'],
    ['numeric', undefined, 'number'],
    ['bool', undefined, 'boolean'],
    ['timestamp', 'timestamp without time zone', 'timestamp'],
    ['timestamptz', undefined, 'timestamp'],
    ['date', undefined, 'date'],
    ['jsonb', undefined, 'json'],
    ['uuid', undefined, 'uuid'],
    ['_text', 'ARRAY', 'array'],
    ['bytea', undefined, 'binary'],
    ['text', undefined, 'string'],
    ['varchar', 'character varying', 'string'],
    ['interval', undefined, 'interval'],
    ['point', undefined, 'other'],
  ])('maps %s -> %s', (udt, dataType, expected) => {
    expect(categoryForType(udt as string, dataType as string | undefined)).toBe(expected)
  })

  it('treats a USER-DEFINED type with labels as an enum', () => {
    expect(categoryForType('feature_kind', 'USER-DEFINED', ['LIMIT', 'METERED'])).toBe('enum')
  })
})

describe('primary keys', () => {
  it('returns composite keys in key order, not column order', () => {
    const columns = [
      col('code', { isPrimaryKey: true, primaryKeyPosition: 2 }),
      col('name'),
      col('app_id', { isPrimaryKey: true, primaryKeyPosition: 1 }),
    ]
    expect(primaryKeyOf(columns)).toEqual(['app_id', 'code'])
  })
})

describe('updatability — the PK-less rule', () => {
  it('marks a table with a primary key updatable', () => {
    const u = describeUpdatability({
      kind: 'table',
      columns: [col('id', { isPrimaryKey: true, primaryKeyPosition: 1 }), col('name')],
    })
    expect(u).toEqual({ updatable: true, primaryKey: ['id'], reason: null })
  })

  it('marks a PK-less table read-only WITH A REASON rather than guessing a WHERE', () => {
    const u = describeUpdatability({ kind: 'table', columns: [col('identifier'), col('token')] })
    expect(u.updatable).toBe(false)
    expect(u.primaryKey).toEqual([])
    expect(u.reason).toMatch(/no primary key/i)
    expect(u.reason).toMatch(/duplicate rows/i)
  })

  it('marks views and materialized views read-only', () => {
    expect(describeUpdatability({ kind: 'view', columns: [col('x')] }).updatable).toBe(false)
    expect(describeUpdatability({ kind: 'matview', columns: [col('x')] }).reason).toMatch(/refresh/i)
    expect(describeUpdatability({ kind: 'foreign', columns: [col('x')] }).updatable).toBe(false)
  })

  it('a view is read-only even when it happens to expose a PK-looking column', () => {
    const u = describeUpdatability({
      kind: 'view',
      columns: [col('id', { isPrimaryKey: true, primaryKeyPosition: 1 })],
    })
    expect(u.updatable).toBe(false)
  })

  it('buildTableSchema carries the reason through', () => {
    const schema = buildTableSchema({ schema: 'public', name: 'verification_token' }, 'table', [
      col('identifier'),
      col('token'),
    ])
    expect(schema.updatable).toBe(false)
    expect(schema.notUpdatableReason).toMatch(/no primary key/i)
  })
})

describe('rowKeyOf', () => {
  it('is stable and distinguishes composite keys', () => {
    const pk = ['app_id', 'code']
    expect(rowKeyOf({ app_id: 'a', code: 'b' }, pk)).toBe(rowKeyOf({ app_id: 'a', code: 'b' }, pk))
    expect(rowKeyOf({ app_id: 'a', code: 'b' }, pk)).not.toBe(rowKeyOf({ app_id: 'b', code: 'a' }, pk))
  })

  it('does not confuse a null with the string "null"', () => {
    const pk = ['a']
    expect(rowKeyOf({ a: null }, pk)).not.toBe(rowKeyOf({ a: 'null' }, pk))
  })

  it('returns null when there is no key or a key value is missing', () => {
    expect(rowKeyOf({ a: 1 }, [])).toBeNull()
    expect(rowKeyOf({}, ['a'])).toBeNull()
  })
})
