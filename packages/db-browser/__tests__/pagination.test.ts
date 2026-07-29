import { describe, expect, it } from 'vitest'
import {
  clampLimit,
  cursorFromRow,
  DEFAULT_LIMIT_POLICY,
  keysetPredicate,
  planPage,
} from '../src/sql/pagination.js'
import { quoteIdent } from '../src/sql/identifiers.js'
import type { ColumnMeta } from '../src/types.js'

function col(name: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return {
    name,
    dataType: 'text',
    udtName: 'text',
    category: 'string',
    nullable: false,
    isPrimaryKey: false,
    ordinal: 1,
    ...over,
  }
}

const columns: ColumnMeta[] = [
  col('app_id', { isPrimaryKey: true, primaryKeyPosition: 1 }),
  col('code', { isPrimaryKey: true, primaryKeyPosition: 2 }),
  col('name'),
  col('unit', { nullable: true }),
]

describe('clampLimit', () => {
  it('defaults when unset or nonsense, and never exceeds the ceiling', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT_POLICY.defaultLimit)
    expect(clampLimit(0)).toBe(DEFAULT_LIMIT_POLICY.defaultLimit)
    expect(clampLimit(-5)).toBe(DEFAULT_LIMIT_POLICY.defaultLimit)
    expect(clampLimit(Number.NaN)).toBe(DEFAULT_LIMIT_POLICY.defaultLimit)
    expect(clampLimit('abc')).toBe(DEFAULT_LIMIT_POLICY.defaultLimit)
    expect(clampLimit(50)).toBe(50)
    expect(clampLimit(10_000)).toBe(DEFAULT_LIMIT_POLICY.maxLimit)
    expect(clampLimit(10_000, { defaultLimit: 10, maxLimit: 25 })).toBe(25)
  })
})

describe('planPage', () => {
  it('uses keyset and completes the ordering with the primary key', () => {
    const plan = planPage({ columns, primaryKey: ['app_id', 'code'], limit: 25 })
    expect(plan.strategy).toBe('keyset')
    expect(plan.orderBy).toEqual([
      { column: 'app_id', direction: 'asc' },
      { column: 'code', direction: 'asc' },
    ])
    expect(plan.limit).toBe(25)
  })

  it('appends the PK after a user sort so the ordering is total', () => {
    const plan = planPage({
      columns,
      primaryKey: ['app_id', 'code'],
      sort: [{ column: 'name', direction: 'desc' }],
    })
    expect(plan.orderBy.map((t) => t.column)).toEqual(['name', 'app_id', 'code'])
    expect(plan.strategy).toBe('keyset')
  })

  it('falls back to OFFSET without a primary key, and says why', () => {
    const plan = planPage({ columns, primaryKey: [], offset: 40, limit: 20 })
    expect(plan.strategy).toBe('offset')
    expect(plan.offset).toBe(40)
    expect(plan.fallbackReason).toMatch(/no primary key/)
  })

  it('falls back to OFFSET when an ordering column is nullable', () => {
    // A NULL inside a keyset tuple comparison silently drops rows.
    const plan = planPage({
      columns,
      primaryKey: ['app_id', 'code'],
      sort: [{ column: 'unit', direction: 'asc' }],
    })
    expect(plan.strategy).toBe('offset')
    expect(plan.fallbackReason).toMatch(/nullable/)
  })

  it('ignores a sort on a column that does not exist', () => {
    const plan = planPage({
      columns,
      primaryKey: ['app_id', 'code'],
      sort: [{ column: 'injected"; DROP TABLE x; --', direction: 'asc' }],
    })
    expect(plan.orderBy.map((t) => t.column)).toEqual(['app_id', 'code'])
  })

  it('binds a cursor to the ordering terms', () => {
    const plan = planPage({
      columns,
      primaryKey: ['app_id', 'code'],
      cursor: {
        direction: 'after',
        values: [
          { column: 'app_id', value: 'a1' },
          { column: 'code', value: 'count.projects' },
        ],
      },
    })
    expect(plan.keyset?.terms).toEqual([
      { column: 'app_id', direction: 'asc', value: 'a1' },
      { column: 'code', direction: 'asc', value: 'count.projects' },
    ])
  })

  it('flips comparisons when walking backwards', () => {
    const plan = planPage({
      columns,
      primaryKey: ['app_id', 'code'],
      cursor: {
        direction: 'before',
        values: [
          { column: 'app_id', value: 'a1' },
          { column: 'code', value: 'c' },
        ],
      },
    })
    expect(plan.keyset?.terms.map((t) => t.direction)).toEqual(['desc', 'desc'])
  })

  it('rejects a cursor that no longer matches the sort', () => {
    expect(() =>
      planPage({
        columns,
        primaryKey: ['app_id', 'code'],
        cursor: { direction: 'after', values: [{ column: 'app_id', value: 'a1' }] },
      }),
    ).toThrow(/cursor/i)
  })
})

describe('keysetPredicate', () => {
  it('expands lexicographically and never inlines a value', () => {
    const params: unknown[] = []
    const bind = (v: unknown) => `$${params.push(v)}`
    const sql = keysetPredicate(
      [
        { column: 'app_id', direction: 'asc', value: 'a1' },
        { column: 'code', direction: 'asc', value: 'c1' },
      ],
      quoteIdent,
      bind,
    )
    expect(sql).toBe('(("app_id" > $1) OR ("app_id" = $1 AND "code" > $2))')
    expect(params).toEqual(['a1', 'c1'])
    expect(sql).not.toContain('a1')
  })

  it('handles mixed directions, which row-comparison cannot', () => {
    const params: unknown[] = []
    const bind = (v: unknown) => `$${params.push(v)}`
    const sql = keysetPredicate(
      [
        { column: 'name', direction: 'desc', value: 'Zed' },
        { column: 'id', direction: 'asc', value: 7 },
      ],
      quoteIdent,
      bind,
    )
    expect(sql).toBe('(("name" < $1) OR ("name" = $1 AND "id" > $2))')
  })

  it('is empty for no terms', () => {
    expect(keysetPredicate([], quoteIdent, () => '$1')).toBe('')
  })
})

describe('cursorFromRow', () => {
  it('captures the ordering values of the last row', () => {
    const cursor = cursorFromRow({ app_id: 'a', code: 'b', name: 'n' }, [
      { column: 'app_id', direction: 'asc' },
      { column: 'code', direction: 'asc' },
    ])
    expect(cursor).toEqual({
      direction: 'after',
      values: [
        { column: 'app_id', value: 'a' },
        { column: 'code', value: 'b' },
      ],
    })
  })
})
