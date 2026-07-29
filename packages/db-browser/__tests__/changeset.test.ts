import { describe, expect, it } from 'vitest'
import {
  changeCount,
  emptyChangeSet,
  isEmpty,
  stageCell,
  stageDelete,
  stageInsert,
  summarize,
  toMutations,
  unstage,
} from '../src/pending/changeset.js'
import { fromDisplay, NULL_DISPLAY, toDisplay } from '../src/render/values.js'
import type { ColumnMeta } from '../src/types.js'

const pk = { app_id: 'a1', code: 'count.projects' }
const rowKey = JSON.stringify(['a1', 'count.projects'])

describe('staging edits', () => {
  it('stages a cell without touching the database', () => {
    const cs = stageCell(emptyChangeSet(), {
      rowKey,
      pk,
      column: 'name',
      before: 'Projects',
      after: 'Drawings',
    })
    expect(changeCount(cs)).toBe(1)
    expect(toMutations(cs)).toEqual([
      { kind: 'update', rowKey, pk, patch: { name: 'Drawings' }, before: { name: 'Projects' } },
    ])
  })

  it('cancels the change when a cell is edited back to its original value', () => {
    let cs = stageCell(emptyChangeSet(), { rowKey, pk, column: 'name', before: 'A', after: 'B' })
    cs = stageCell(cs, { rowKey, pk, column: 'name', before: 'B', after: 'A' })
    expect(isEmpty(cs)).toBe(true)
    expect(toMutations(cs)).toEqual([])
  })

  it('keeps the ORIGINAL before-value across repeated edits', () => {
    let cs = stageCell(emptyChangeSet(), { rowKey, pk, column: 'name', before: 'A', after: 'B' })
    cs = stageCell(cs, { rowKey, pk, column: 'name', before: 'B', after: 'C' })
    const [m] = toMutations(cs)
    expect(m).toMatchObject({ patch: { name: 'C' }, before: { name: 'A' } })
  })

  it('collects several columns of one row into a single UPDATE', () => {
    let cs = stageCell(emptyChangeSet(), { rowKey, pk, column: 'name', before: 'A', after: 'B' })
    cs = stageCell(cs, { rowKey, pk, column: 'unit', before: null, after: 'drawings' })
    const mutations = toMutations(cs)
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({ patch: { name: 'B', unit: 'drawings' } })
  })

  it('unstages one cell or a whole row', () => {
    let cs = stageCell(emptyChangeSet(), { rowKey, pk, column: 'name', before: 'A', after: 'B' })
    cs = stageCell(cs, { rowKey, pk, column: 'unit', before: 'x', after: 'y' })
    expect(changeCount(unstage(cs, rowKey, 'unit'))).toBe(1)
    expect(isEmpty(unstage(cs, rowKey))).toBe(true)
    expect(unstage(cs, 'nonexistent', 'unit')).toBe(cs)
  })

  it('orders mutations insert -> update -> delete', () => {
    let cs = stageDelete(emptyChangeSet(), rowKey, pk, { app_id: 'a1' })
    cs = stageCell(cs, { rowKey: 'other', pk: { app_id: 'z' }, column: 'n', before: 1, after: 2 })
    cs = stageInsert(cs, { app_id: 'a1', code: 'count.new' })
    expect(toMutations(cs).map((m) => m.kind)).toEqual(['insert', 'update', 'delete'])
  })

  it('summarizes for the review panel', () => {
    const cs = stageCell(emptyChangeSet(), { rowKey, pk, column: 'name', before: 'A', after: 'B' })
    expect(summarize(cs)).toEqual([
      {
        rowKey,
        kind: 'update',
        label: 'app_id=a1, code=count.projects',
        column: 'name',
        before: 'A',
        after: 'B',
      },
    ])
  })

  it('treats an equal-but-not-identical value as no change', () => {
    const cs = stageCell(emptyChangeSet(), {
      rowKey,
      pk,
      column: 'meta',
      before: { a: 1 },
      after: { a: 1 },
    })
    expect(isEmpty(cs)).toBe(true)
  })
})

describe('NULL is not the empty string', () => {
  const text: Pick<ColumnMeta, 'category' | 'name'> = { category: 'string', name: 'unit' }
  const num: Pick<ColumnMeta, 'category' | 'name'> = { category: 'number', name: 'n' }

  it('renders NULL distinctly from an empty string', () => {
    expect(toDisplay(null)).toBe(NULL_DISPLAY)
    expect(toDisplay('')).toBe('')
    expect(toDisplay(undefined)).toBe(NULL_DISPLAY)
  })

  it('round-trips the NULL glyph back to null', () => {
    expect(fromDisplay(NULL_DISPLAY, text)).toEqual({ ok: true, value: null })
    expect(fromDisplay('', text)).toEqual({ ok: true, value: '' })
  })

  it('coerces by category', () => {
    expect(fromDisplay('42', num)).toEqual({ ok: true, value: 42 })
    expect(fromDisplay('abc', num)).toEqual({ ok: false, error: '"abc" is not a number' })
    expect(fromDisplay('true', { category: 'boolean', name: 'b' })).toEqual({ ok: true, value: true })
    expect(fromDisplay('f', { category: 'boolean', name: 'b' })).toEqual({ ok: true, value: false })
    expect(fromDisplay('nope', { category: 'boolean', name: 'b' }).ok).toBe(false)
    expect(fromDisplay('{"a":1}', { category: 'json', name: 'j' })).toEqual({
      ok: true,
      value: { a: 1 },
    })
    expect(fromDisplay('{oops', { category: 'json', name: 'j' }).ok).toBe(false)
    expect(fromDisplay('["a","b"]', { category: 'array', name: 'arr' })).toEqual({
      ok: true,
      value: ['a', 'b'],
    })
  })

  it('refuses to edit binary columns as text', () => {
    const r = fromDisplay('anything', { category: 'binary', name: 'blob' })
    expect(r.ok).toBe(false)
  })

  it('renders a binary placeholder as metadata, never as bytes', () => {
    expect(toDisplay({ __dbbBinary: true, bytes: 2048 })).toBe('[binary · 2.0 KB]')
    expect(toDisplay({ __dbbBinary: true, bytes: null })).toBe('[binary · unknown size]')
  })
})
