/**
 * The pending-changes model.
 *
 * `SpreadsheetTable` fires `onCellChange` on every keystroke-committed cell.
 * Turning that straight into an `UPDATE` would mean a stray keypress silently
 * rewrites a production row, and a typo followed by a correction would issue
 * two writes. So edits are **staged** here, shown for review, and only sent
 * when the user commits.
 *
 * Pure data + pure functions: no React, no I/O, fully unit-testable.
 */

import { sameValue } from '../render/values.js'
import type { PkValues, Row } from '../types.js'

export interface PendingCell {
  column: string
  before: unknown
  after: unknown
}

export interface PendingUpdate {
  rowKey: string
  pk: PkValues
  cells: Record<string, PendingCell>
}

export interface PendingInsert {
  tempKey: string
  values: Row
}

export interface PendingDelete {
  rowKey: string
  pk: PkValues
  snapshot: Row
}

export interface ChangeSet {
  updates: Record<string, PendingUpdate>
  inserts: PendingInsert[]
  deletes: Record<string, PendingDelete>
}

export function emptyChangeSet(): ChangeSet {
  return { updates: {}, inserts: [], deletes: {} }
}

export function changeCount(cs: ChangeSet): number {
  const cells = Object.values(cs.updates).reduce((n, u) => n + Object.keys(u.cells).length, 0)
  return cells + cs.inserts.length + Object.keys(cs.deletes).length
}

export function isEmpty(cs: ChangeSet): boolean {
  return changeCount(cs) === 0
}

export interface StageCellInput {
  rowKey: string
  pk: PkValues
  column: string
  /** The value as it exists in the database right now. */
  before: unknown
  after: unknown
}

/**
 * Stage one cell edit. Editing a cell back to its original value **removes**
 * the pending change rather than queuing a no-op write, so "type, undo" leaves
 * nothing to commit.
 */
export function stageCell(cs: ChangeSet, input: StageCellInput): ChangeSet {
  const existing = cs.updates[input.rowKey]
  const before = existing?.cells[input.column]?.before ?? input.before
  const cells: Record<string, PendingCell> = { ...(existing?.cells ?? {}) }
  if (sameValue(before, input.after)) {
    delete cells[input.column]
  } else {
    cells[input.column] = { column: input.column, before, after: input.after }
  }
  const updates = { ...cs.updates }
  if (Object.keys(cells).length === 0) {
    delete updates[input.rowKey]
  } else {
    updates[input.rowKey] = { rowKey: input.rowKey, pk: input.pk, cells }
  }
  return { ...cs, updates }
}

/** Drop one staged cell (or the whole row when `column` is omitted). */
export function unstage(cs: ChangeSet, rowKey: string, column?: string): ChangeSet {
  const updates = { ...cs.updates }
  const deletes = { ...cs.deletes }
  if (!column) {
    delete updates[rowKey]
    delete deletes[rowKey]
    return { ...cs, updates, deletes }
  }
  const row = updates[rowKey]
  if (!row) return cs
  const cells = { ...row.cells }
  delete cells[column]
  if (Object.keys(cells).length === 0) delete updates[rowKey]
  else updates[rowKey] = { ...row, cells }
  return { ...cs, updates }
}

export function stageDelete(cs: ChangeSet, rowKey: string, pk: PkValues, snapshot: Row): ChangeSet {
  return { ...cs, deletes: { ...cs.deletes, [rowKey]: { rowKey, pk, snapshot } } }
}

export function stageInsert(cs: ChangeSet, values: Row): ChangeSet {
  const tempKey = `new:${cs.inserts.length}:${Date.now()}`
  return { ...cs, inserts: [...cs.inserts, { tempKey, values }] }
}

export function discardAll(): ChangeSet {
  return emptyChangeSet()
}

export type Mutation =
  | { kind: 'update'; rowKey: string; pk: PkValues; patch: Row; before: Row }
  | { kind: 'insert'; tempKey: string; values: Row }
  | { kind: 'delete'; rowKey: string; pk: PkValues }

/**
 * Flatten to the ordered mutation list. Inserts run first, then updates, then
 * deletes — so a "replace these rows" session cannot delete a row another
 * pending update still refers to.
 */
export function toMutations(cs: ChangeSet): Mutation[] {
  const out: Mutation[] = []
  for (const ins of cs.inserts) out.push({ kind: 'insert', tempKey: ins.tempKey, values: ins.values })
  for (const u of Object.values(cs.updates)) {
    const patch: Row = {}
    const before: Row = {}
    for (const cell of Object.values(u.cells)) {
      patch[cell.column] = cell.after
      before[cell.column] = cell.before
    }
    out.push({ kind: 'update', rowKey: u.rowKey, pk: u.pk, patch, before })
  }
  for (const d of Object.values(cs.deletes)) {
    out.push({ kind: 'delete', rowKey: d.rowKey, pk: d.pk })
  }
  return out
}

export interface ChangeSummaryLine {
  rowKey: string
  kind: 'update' | 'insert' | 'delete'
  label: string
  column?: string
  before?: unknown
  after?: unknown
}

/** Flat, human-readable list for the review panel. */
export function summarize(cs: ChangeSet): ChangeSummaryLine[] {
  const lines: ChangeSummaryLine[] = []
  for (const ins of cs.inserts) {
    lines.push({ rowKey: ins.tempKey, kind: 'insert', label: 'new row' })
  }
  for (const u of Object.values(cs.updates)) {
    const label = Object.entries(u.pk)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')
    for (const cell of Object.values(u.cells)) {
      lines.push({
        rowKey: u.rowKey,
        kind: 'update',
        label,
        column: cell.column,
        before: cell.before,
        after: cell.after,
      })
    }
  }
  for (const d of Object.values(cs.deletes)) {
    lines.push({
      rowKey: d.rowKey,
      kind: 'delete',
      label: Object.entries(d.pk)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', '),
    })
  }
  return lines
}
