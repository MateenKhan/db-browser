/**
 * The review-before-commit panel.
 *
 * Every staged edit is listed as `table.column @ pk: before → after` with the
 * exact statement count that will run. Nothing reaches the database until
 * **Commit** is pressed, and each line can be dropped individually — which is
 * the whole point: an `UPDATE` on a live table should be a decision, not a
 * side effect of a keystroke.
 */

import { summarize } from '../pending/changeset.js'
import { toDisplay } from '../render/values.js'
import type { DbBrowserState } from './useDbBrowser.js'

export interface PendingChangesProps {
  state: DbBrowserState
  onCommitted?: (applied: number, errors: string[]) => void
}

export function PendingChanges({ state, onCommitted }: PendingChangesProps) {
  const lines = summarize(state.pending)
  if (!lines.length) return null

  const commit = async () => {
    const outcome = await state.commit()
    onCommitted?.(outcome.applied, outcome.errors)
  }

  return (
    <div className="dbb-pending" role="region" aria-label="Pending changes">
      <div className="dbb-pending-head">
        <strong>
          {lines.length} pending change{lines.length === 1 ? '' : 's'}
        </strong>
        <span className="dbb-muted">
          {Object.keys(state.pending.updates).length} UPDATE
          {Object.keys(state.pending.updates).length === 1 ? '' : 's'} will run
        </span>
        <span className="dbb-spacer" />
        <button type="button" onClick={state.discard} disabled={state.committing}>
          Discard
        </button>
        <button type="button" className="dbb-primary" onClick={commit} disabled={state.committing}>
          {state.committing ? 'Committing…' : 'Commit'}
        </button>
      </div>
      <ul className="dbb-pending-list">
        {lines.map((line, i) => (
          <li key={`${line.rowKey}-${line.column}-${i}`}>
            <code className="dbb-pending-key">{line.label}</code>
            {line.column ? <code className="dbb-pending-col">{line.column}</code> : null}
            <span className="dbb-pending-before">{toDisplay(line.before)}</span>
            <span aria-hidden>→</span>
            <span className="dbb-pending-after">{toDisplay(line.after)}</span>
            <button
              type="button"
              className="dbb-link"
              onClick={() => state.dropPending(line.rowKey, line.column)}
              disabled={state.committing}
              aria-label={`Drop change to ${line.column ?? 'row'}`}
            >
              drop
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
