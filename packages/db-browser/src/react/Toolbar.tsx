/**
 * The table toolbar: identity, paging, sort and filters, in one dense strip.
 *
 * ## Density, and what was removed to get it
 *
 * A real application toolbar is a row of tight clusters separated by hairlines;
 * a web page is a row of well-spaced controls. This is the former. Controls
 * that belong to one idea (refresh + page size + pager) sit against each other
 * inside a bordered group, and the groups are separated rather than the
 * controls.
 *
 * The previous version stated the same page in four ways at once —
 * `page 1 · 100 rows · keyset · ~13,482 total (estimate)` — beside a row-limit
 * select that already said `100`. Now:
 *
 *  - **the page number** is the pager's own label;
 *  - **the row count** appears only when it *disagrees* with the limit, which
 *    is the one case it is news (a short last page);
 *  - **the fetch strategy** is a tooltip on the pager, because it explains the
 *    pager's behaviour and is not a fact about the data;
 *  - **the total estimate** stays, once, because nothing else says it.
 *
 * The limit itself is always visible and always applied — there is no "no
 * limit" option, because an unbounded `SELECT *` against a table someone else
 * is writing to is how a browser tool takes production down.
 */

import { useState } from 'react'
import { Glyph } from './iconography.js'
import { hint } from './shortcuts.js'
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

const STRATEGY_NOTE: Record<string, string> = {
  keyset:
    'Keyset paging: each page is fetched with a WHERE on the last row’s key, so page 900 costs the same as page 2.',
  offset:
    'OFFSET paging: this table has no usable key, so the engine must skip every preceding row. Deep pages get slower.',
}

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

  const shortPage = page && page.rows.length !== state.limit
  const total = typeof page?.totalEstimate === 'number' && page.totalEstimate >= 0 ? page.totalEstimate : null

  return (
    <div className="dbb-toolbar">
      <div className="dbb-toolbar-row">
        <span className="dbb-table-title" title={`${schema.table.schema}.${schema.table.name}`}>
          <Glyph name="table" size="md" />
          <span className="dbb-muted">{schema.table.schema}.</span>
          <strong>{schema.table.name}</strong>
        </span>

        {/* --- fetch cluster: refresh, page size, pager --- */}
        <div className="dbb-group">
          <button
            type="button"
            className="dbb-icon-btn"
            onClick={state.refresh}
            disabled={state.loading}
            aria-label="Refresh this page of rows"
            title={hint('Refresh', 'f5')}
          >
            <Glyph name={state.loading ? 'busy' : 'refresh'} size="md" spin={state.loading} />
          </button>
          <span className="dbb-group-sep" />
          <label className="dbb-field" title="Every query is capped. Raise this deliberately.">
            <Glyph name="rows" size="sm" />
            <span className="dbb-sr-only">Rows per page</span>
            <select value={state.limit} onChange={(e) => state.setLimit(Number(e.target.value))}>
              {LIMIT_CHOICES.filter((n) => n <= state.maxLimit).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="dbb-group-sep" />
          <span
            className="dbb-pager"
            title={page ? (STRATEGY_NOTE[page.strategy] ?? page.strategy) : undefined}
          >
            <button
              type="button"
              className="dbb-icon-btn"
              onClick={state.prev}
              disabled={!state.canPrev || state.loading}
              aria-label="Previous page"
              title={hint('Previous page', '[')}
            >
              <Glyph name="prev" size="md" />
            </button>
            <span className="dbb-page-label">
              {state.pageIndex + 1}
              {shortPage ? <span className="dbb-muted"> · {page?.rows.length} rows</span> : null}
            </span>
            <button
              type="button"
              className="dbb-icon-btn"
              onClick={state.next}
              disabled={!state.canNext || state.loading}
              aria-label="Next page"
              title={hint('Next page', ']')}
            >
              <Glyph name="next" size="md" />
            </button>
          </span>
        </div>

        {total !== null ? (
          <span className="dbb-muted dbb-total" title="An estimate from the engine’s statistics — never a COUNT(*)">
            ~{total.toLocaleString()} rows
          </span>
        ) : null}

        {/* --- sort cluster --- */}
        <div className="dbb-group">
          <label className="dbb-field">
            <Glyph name={state.sort[0]?.direction === 'desc' ? 'sortDesc' : 'sortAsc'} size="sm" />
            <span className="dbb-sr-only">Sort by</span>
            <select
              value={state.sort[0]?.column ?? ''}
              onChange={(e) =>
                e.target.value ? state.toggleSort(e.target.value) : state.setFilters(state.filters)
              }
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
              className="dbb-chip dbb-chip-on"
              onClick={() => state.toggleSort(state.sort[0].column)}
              title="Click to flip direction, again to clear"
            >
              <Glyph name={state.sort[0].direction === 'asc' ? 'sortAsc' : 'sortDesc'} size="sm" />
              {state.sort[0].column}
            </button>
          ) : null}
        </div>

        {/* --- filter cluster --- */}
        <div className="dbb-group">
          <label className="dbb-field">
            <Glyph name="filter" size="sm" />
            <span className="dbb-sr-only">Filter column</span>
            <select value={column} onChange={(e) => setColumn(e.target.value)}>
              <option value="">column…</option>
              {schema.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <select value={op} onChange={(e) => setOp(e.target.value as FilterOperator)} aria-label="Operator">
            {OPERATORS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {operator?.needsValue ? (
            <input
              className="dbb-filter-value"
              value={value}
              placeholder="value"
              aria-label="Filter value"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addFilter()
              }}
            />
          ) : null}
          <button
            type="button"
            className="dbb-icon-btn"
            onClick={addFilter}
            disabled={!column}
            aria-label="Add filter"
            title="Add filter"
          >
            <Glyph name="add" size="md" />
          </button>
        </div>

        {state.filters.map((f, i) => (
          <button
            key={`${f.column}-${f.op}-${i}`}
            type="button"
            className="dbb-chip dbb-chip-filter"
            onClick={() => state.setFilters(state.filters.filter((_, j) => j !== i))}
            title="Remove this filter"
          >
            {f.column} {OPERATORS.find((o) => o.value === f.op)?.label ?? f.op}{' '}
            {f.value !== undefined ? String(f.value) : ''}
            <Glyph name="close" size="sm" />
          </button>
        ))}
      </div>

      {page?.strategy === 'offset' && state.pageIndex > 4 ? (
        <div className="dbb-hint">
          <Glyph name="info" size="sm" />
          Deep OFFSET paging gets slower the further you go — this table has no usable key for keyset
          pagination.
        </div>
      ) : null}
    </div>
  )
}
