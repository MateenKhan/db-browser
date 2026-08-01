import { describe, expect, it } from 'vitest'
import { finalizeColumn, planPage } from '@jugaaadi/db-browser/core'
import { POSTGRES_TYPE_MAP } from '@jugaaadi/db-browser-connectors'
import type { ColumnMeta } from '@jugaaadi/db-browser/core'
import {
  Binder,
  buildBinaryFetch,
  buildDelete,
  buildFilter,
  buildInsert,
  buildPkPredicate,
  buildSelect,
  buildUpdate,
  projectionFor,
  wrapWithLimit,
} from '../src/sqlBuilder.js'

/**
 * `finalizeColumn` fills the metadata-driven half (`dbType`,
 * `normalizedType`, `isForeignKey`, `references`) from a type map, exactly as
 * every adapter's introspector does — so a fixture built here has the same
 * shape as one that came out of a real database.
 */
function col(name: string, over: Partial<ColumnMeta> = {}): ColumnMeta {
  return finalizeColumn(
    {
      name,
      dataType: 'text',
      udtName: 'text',
      category: 'string',
      nullable: true,
      isPrimaryKey: false,
      ordinal: 1,
      ...over,
    },
    POSTGRES_TYPE_MAP,
  )
}

const columns: ColumnMeta[] = [
  col('app_id', { isPrimaryKey: true, primaryKeyPosition: 1, nullable: false }),
  col('code', { isPrimaryKey: true, primaryKeyPosition: 2, nullable: false }),
  col('name', { nullable: false }),
  col('meters_cogs', { category: 'boolean', udtName: 'bool', nullable: false }),
  col('payload', { category: 'binary', udtName: 'bytea', isBinary: true }),
  col('created_at', { category: 'timestamp', udtName: 'timestamp', nullable: false }),
]
const table = { schema: 'public', name: 'feature' }
const primaryKey = ['app_id', 'code']

/** The single invariant this whole module exists for. */
function assertNoInlinedValues(text: string, values: unknown[]): void {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 2) {
      expect(text).not.toContain(v)
    }
  }
}

describe('projection', () => {
  it('never selects binary bytes — only their length', () => {
    const sql = projectionFor(columns)
    expect(sql).toContain('octet_length("payload") AS "payload"')
    expect(sql).not.toMatch(/(^|,)\s*"payload"\s*(,|$)/)
  })

  it('quotes every identifier', () => {
    expect(projectionFor(columns, ['name'])).toBe('"name"')
  })

  it('refuses a projection column that does not exist', () => {
    expect(() => projectionFor(columns, ['nope'])).toThrow(/Column not found/)
  })
})

describe('buildSelect', () => {
  it('binds the limit and orders by the completed key', () => {
    const plan = planPage({ columns, primaryKey, limit: 25 })
    const { text, values } = buildSelect({ table, columns, plan })
    expect(text).toContain('FROM "public"."feature"')
    expect(text).toContain('ORDER BY "app_id" ASC, "code" ASC')
    expect(text).toContain('LIMIT $1')
    expect(values).toEqual([26]) // limit + 1 probe row
  })

  it('emits a keyset predicate with bound values', () => {
    const plan = planPage({
      columns,
      primaryKey,
      cursor: {
        direction: 'after',
        values: [
          { column: 'app_id', value: 'cms4swvu80000p5r4d4sfmoog' },
          { column: 'code', value: 'count.projects' },
        ],
      },
    })
    const { text, values } = buildSelect({ table, columns, plan })
    expect(text).toContain('WHERE (("app_id" > $1) OR ("app_id" = $1 AND "code" > $2))')
    expect(values).toEqual(['cms4swvu80000p5r4d4sfmoog', 'count.projects', 101])
    assertNoInlinedValues(text, values)
  })

  it('uses OFFSET only for the offset strategy', () => {
    const keyset = planPage({ columns, primaryKey, offset: 100 })
    expect(buildSelect({ table, columns, plan: keyset }).text).not.toContain('OFFSET')

    const offset = planPage({ columns, primaryKey: [], offset: 100, limit: 50 })
    const built = buildSelect({ table, columns, plan: offset })
    expect(built.text).toContain('LIMIT $1 OFFSET $2')
    expect(built.values).toEqual([51, 100])
  })

  it('binds filter values and escapes LIKE metacharacters', () => {
    const plan = planPage({ columns, primaryKey })
    const { text, values } = buildSelect({
      table,
      columns,
      plan,
      filters: [{ column: 'name', op: 'contains', value: '100%_real' }],
    })
    expect(text).toContain(`"name"::text ILIKE $1 ESCAPE '\\'`)
    expect(values[0]).toBe('%100\\%\\_real%')
    assertNoInlinedValues(text, values)
  })

  it('refuses a filter on an unknown column instead of interpolating it', () => {
    const plan = planPage({ columns, primaryKey })
    expect(() =>
      buildSelect({
        table,
        columns,
        plan,
        filters: [{ column: 'x"; DROP TABLE feature; --', op: 'eq', value: 1 }],
      }),
    ).toThrow(/Column not found/)
  })
})

describe('buildFilter', () => {
  it.each([
    ['eq', '"name" = $1'],
    ['neq', '"name" <> $1'],
    ['lt', '"name" < $1'],
    ['gte', '"name" >= $1'],
  ])('maps %s', (op, expected) => {
    const b = new Binder()
    expect(buildFilter({ column: 'name', op: op as never, value: 'x' }, columns, b)).toBe(expected)
  })

  it('turns eq-null into IS NULL rather than "= NULL", which is never true', () => {
    const b = new Binder()
    expect(buildFilter({ column: 'name', op: 'eq', value: null }, columns, b)).toBe('"name" IS NULL')
    expect(b.values).toEqual([])
  })

  it('binds an IN list as a single array parameter', () => {
    const b = new Binder()
    expect(buildFilter({ column: 'code', op: 'in', values: ['a', 'b'] }, columns, b)).toBe(
      '"code" = ANY ($1)',
    )
    expect(b.values).toEqual([['a', 'b']])
  })

  it('rejects an unknown operator', () => {
    expect(() => buildFilter({ column: 'name', op: 'evil' as never }, columns, new Binder())).toThrow(
      /Unsupported filter operator/,
    )
  })
})

describe('writes', () => {
  const pk = { app_id: 'a1', code: 'count.projects' }

  it('builds a fully parameterised UPDATE keyed on the whole PK', () => {
    const { text, values } = buildUpdate({
      table,
      columns,
      primaryKey,
      pk,
      patch: { name: "Robert'); DROP TABLE feature;--" },
    })
    expect(text).toBe(
      'UPDATE "public"."feature" SET "name" = $1 WHERE "app_id" = $2 AND "code" = $3 ' +
        'RETURNING "app_id", "code", "name", "meters_cogs", octet_length("payload") AS "payload", "created_at"',
    )
    expect(values).toEqual(["Robert'); DROP TABLE feature;--", 'a1', 'count.projects'])
    assertNoInlinedValues(text, values)
  })

  it('refuses to update without every primary-key value — no partial WHERE', () => {
    expect(() =>
      buildUpdate({ table, columns, primaryKey, pk: { app_id: 'a1' }, patch: { name: 'x' } }),
    ).toThrow(/Missing primary-key value for "code"/)
  })

  it('refuses to update a table with no primary key at all', () => {
    expect(() =>
      buildUpdate({ table, columns, primaryKey: [], pk: {}, patch: { name: 'x' } }),
    ).toThrow(/no primary key/i)
  })

  it('refuses a null primary-key value', () => {
    expect(() =>
      buildUpdate({ table, columns, primaryKey, pk: { app_id: 'a', code: null }, patch: { name: 'x' } }),
    ).toThrow(/is null/)
  })

  it('refuses to write a generated column', () => {
    const generated = [...columns, col('id', { readOnly: true })]
    expect(() =>
      buildUpdate({ table, columns: generated, primaryKey, pk, patch: { id: 5 } }),
    ).toThrow(/generated/)
  })

  it('refuses an empty patch instead of emitting invalid SQL', () => {
    expect(() => buildUpdate({ table, columns, primaryKey, pk, patch: {} })).toThrow(/No columns/)
  })

  it('builds INSERT and DELETE the same way', () => {
    const ins = buildInsert({ table, columns, primaryKey, row: { app_id: 'a', name: 'n' } })
    expect(ins.text).toContain('INSERT INTO "public"."feature" ("app_id", "name") VALUES ($1, $2)')
    expect(ins.values).toEqual(['a', 'n'])

    const del = buildDelete({ table, columns, primaryKey, pk })
    expect(del.text).toBe('DELETE FROM "public"."feature" WHERE "app_id" = $1 AND "code" = $2')
    expect(del.values).toEqual(['a1', 'count.projects'])
  })

  it('drops generated columns from an INSERT rather than failing', () => {
    const generated = [...columns, col('id', { readOnly: true })]
    const ins = buildInsert({ table, columns: generated, primaryKey, row: { id: 1, name: 'n' } })
    expect(ins.text.slice(0, ins.text.indexOf('RETURNING'))).not.toContain('"id"')
    expect(ins.values).toEqual(['n'])
  })

  it('quotes a hostile column name instead of letting it break out', () => {
    const weird = [col('we"ird', { isPrimaryKey: true, primaryKeyPosition: 1 })]
    const b = new Binder()
    expect(buildPkPredicate({ 'we"ird': 1 }, ['we"ird'], weird, b)).toBe('"we""ird" = $1')
  })
})

describe('binary fetch', () => {
  it('reads one cell as base64, on demand only', () => {
    const { text, values } = buildBinaryFetch({
      table,
      columns,
      primaryKey,
      pk: { app_id: 'a', code: 'c' },
      column: 'payload',
    })
    expect(text).toContain(`encode("payload", 'base64') AS base64`)
    expect(text).toContain('octet_length("payload") AS bytes')
    expect(values).toEqual(['a', 'c'])
  })

  it('refuses a non-binary column', () => {
    expect(() =>
      buildBinaryFetch({ table, columns, primaryKey, pk: { app_id: 'a', code: 'c' }, column: 'name' }),
    ).toThrow(/not a binary column/)
  })
})

describe('wrapWithLimit', () => {
  it('caps rows on the server, and cannot be fed a non-numeric limit', () => {
    expect(wrapWithLimit('SELECT 1', 10)).toBe('SELECT * FROM (SELECT 1) AS _dbb_capped LIMIT 10')
    expect(wrapWithLimit('SELECT 1', 10.9)).toContain('LIMIT 10')
    // The one interpolated number in the codebase refuses anything that is not
    // a positive integer, so `LIMIT NaN` / `LIMIT 1; DROP TABLE x` cannot exist.
    expect(() => wrapWithLimit('SELECT 1', -5)).toThrow(/positive integer/)
    expect(() => wrapWithLimit('SELECT 1', Number.NaN)).toThrow(/positive integer/)
    expect(() =>
      wrapWithLimit('SELECT 1', '1; DROP TABLE x' as unknown as number),
    ).toThrow(/positive integer/)
  })
})
