/**
 * The row-limit / pagination / sort / filter strip.
 *
 * The limit is always visible and always applied — there is no "no limit"
 * option, because an unbounded `SELECT *` against a table someone else is
 * writing to is how a browser tool takes production down. Raising it is a
 * deliberate act, capped by the server's own maximum.
 */

import { useState } from 'react'
import type { Filter, FilterOperator } from '../types.js'
import type { DbBrowserState } from './useDbBrowser.js'

const LIMIT_CHOICES = [25, 50, 100, 250, 500, 1000]

const OPERATORS: Array<{ value: FilterOperator; label: string; needsValue: boolean }> = [
  { value: 'eq', label: '=', needsValue: true },
  { value: 'neq', label: '≠', needsValue: true },
  { value: 'contains', label: 'contains', needsValue: true },
  { value: 'startsWith', label: 'starts with', needsValue: true },
  { value: 'gt', label: '>', needsValue: true },
  { value: 'gte', label: '≥', needsValue: true },
  { value: 'lt', label: '<', needsValue: true },
  { value: 'lte', label: '≤', needsValue: true },
  { value: 'isNull', label: 'is NULL', needsValue: false },
  { value: 'isNotNull', label: 'is not NULL', needsValue: false },
]

export function Toolbar({ state }: { state: DbBrowserState }) {
  const { schema, page } = state
  const [column, setColumn] = useState('')
  const [op, setOp] = useState<FilterOperator>('eq')
  const [value, setValue] = useState('')

  if (!schema) return null
  const operator = OPERATORS.find((o) => o.value === op)

  const addFilter = () => {
    if (!column) return
    const filter: Filter = operator?.needsValue ? { column, op, value } : { column, op }
    state.setFilters([...state.filters, filter])
    setValue('')
  }

  return (
    <div className="dbb-toolbar">
      <div className="dbb-toolbar-row">
        <span className="dbb-table-title">
          {schema.table.schema}.<strong>{schema.table.name}</strong>
        </span>

        <span className="dbb-sep" />

        <label className="dbb-field">
          Rows
          <select
            value={state.limit}
            onChange={(e) => state.setLimit(Number(e.target.value))}
            title="Every query is capped. Raise this deliberately."
          >
            {LIMIT_CHOICES.filter((n) => n <= state.maxLimit).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>

        <div className="dbb-pager">
          <button type="button" onClick={state.prev} disabled={!state.canPrev || state.loading}>
            ← Prev
          </button>
          <span className="dbb-page-label">
            page {state.pageIndex + 1}
            {page ? (
              <span className="dbb-muted">
                {' '}
                · {page.rows.length} row{page.rows.length === 1 ? '' : 's'} ·{' '}
                <span title="How this page was fetched">{page.strategy}</span>
                {typeof page.totalEstimate === 'number' && page.totalEstimate >= 0 ? (
                  <> · ~{page.totalEstimate.toLocaleString()} total (estimate)</>
                ) : null}
              </span>
            ) : null}
          </span>
          <button type="button" onClick={state.next} disabled={!state.canNext || state.loading}>
            Next →
          </button>
        </div>

        <span className="dbb-spacer" />

        <button type="button" onClick={state.refresh} disabled={state.loading}>
          {state.loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="dbb-toolbar-row dbb-toolbar-filters">
        <label className="dbb-field">
          Sort
          <select
            value={state.sort[0]?.column ?? ''}
            onChange={(e) => (e.target.value ? state.toggleSort(e.target.value) : state.setFilters(state.filters))}
          >
            <option value="">(primary key)</option>
            {schema.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {state.sort[0] ? (
          <button
            type="button"
            className="dbb-chip"
            onClick={() => state.toggleSort(state.sort[0].column)}
            title="Click to flip direction, again to clear"
          >
            {state.sort[0].column} {state.sort[0].direction === 'asc' ? '▲' : '▼'}
          </button>
        ) : null}

        <span className="dbb-sep" />

        <label className="dbb-field">
          Filter
          <select value={column} onChange={(e) => setColumn(e.target.value)}>
            <option value="">column…</option>
            {schema.columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <select value={op} onChange={(e) => setOp(e.target.value as FilterOperator)}>
          {OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {operator?.needsValue ? (
          <input
            value={value}
            placeholder="value"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addFilter()
            }}
          />
        ) : null}
        <button type="button" onClick={addFilter} disabled={!column}>
          Add
        </button>

        {state.filters.map((f, i) => (
          <button
            key={`${f.column}-${f.op}-${i}`}
            type="button"
            className="dbb-chip dbb-chip-removable"
            onClick={() => state.setFilters(state.filters.filter((_, j) => j !== i))}
            title="Remove filter"
          >
            {f.column} {OPERATORS.find((o) => o.value === f.op)?.label ?? f.op}{' '}
            {f.value !== undefined ? String(f.value) : ''} ✕
          </button>
        ))}
      </div>

      {page?.strategy === 'offset' && state.pageIndex > 4 ? (
        <div className="dbb-hint">
          Deep OFFSET paging gets slower the further you go — this table has no usable key for
          keyset pagination.
        </div>
      ) : null}
    </div>
  )
}
