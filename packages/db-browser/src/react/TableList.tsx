/**
 * The table sidebar. Counts are `pg_class.reltuples` **estimates** and are
 * labelled as such — running `COUNT(*)` on every table to populate a sidebar
 * is exactly the kind of query a browser tool should never issue on its own.
 */

import { useMemo, useState } from 'react'
import type { TableMeta, TableRef } from '../types.js'

export interface TableListProps {
  tables: readonly TableMeta[]
  active: TableRef | null
  loading?: boolean
  error?: string | null
  onOpen: (table: TableRef) => void
  onReload: () => void
}

const KIND_LABEL: Record<string, string> = {
  view: 'view',
  matview: 'matview',
  foreign: 'foreign',
  partitioned: 'partitioned',
}

export function TableList({ tables, active, loading, error, onOpen, onReload }: TableListProps) {
  const [query, setQuery] = useState('')

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(q))
      : tables
    const map = new Map<string, TableMeta[]>()
    for (const t of filtered) {
      const list = map.get(t.schema) ?? []
      list.push(t)
      map.set(t.schema, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [tables, query])

  return (
    <aside className="dbb-sidebar">
      <div className="dbb-sidebar-head">
        <input
          className="dbb-search"
          value={query}
          placeholder="Filter tables…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter tables"
        />
        <button type="button" onClick={onReload} title="Re-read the schema" disabled={loading}>
          ⟳
        </button>
      </div>

      {error ? <div className="dbb-banner dbb-banner-error">{error}</div> : null}
      {loading && !tables.length ? <div className="dbb-empty">Loading tables…</div> : null}

      <div className="dbb-sidebar-scroll">
        {grouped.map(([schema, list]) => (
          <div key={schema} className="dbb-schema-group">
            <div className="dbb-schema-name">{schema}</div>
            <ul>
              {list.map((t) => {
                const isActive = active?.schema === t.schema && active?.name === t.name
                return (
                  <li key={`${t.schema}.${t.name}`}>
                    <button
                      type="button"
                      className={isActive ? 'dbb-table-item dbb-table-item-active' : 'dbb-table-item'}
                      onClick={() => onOpen({ schema: t.schema, name: t.name })}
                      title={t.comment ?? undefined}
                    >
                      <span className="dbb-table-name">{t.name}</span>
                      {KIND_LABEL[t.kind] ? (
                        <span className="dbb-badge dbb-badge-muted">{KIND_LABEL[t.kind]}</span>
                      ) : null}
                      <span className="dbb-muted dbb-table-count" title="planner estimate, not COUNT(*)">
                        {t.rowCountEstimate >= 0 ? `~${t.rowCountEstimate.toLocaleString()}` : '—'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  )
}
