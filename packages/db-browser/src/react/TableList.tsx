/**
 * The table sidebar.
 *
 * Counts are **estimates** (`pg_class.reltuples` on Postgres, `sqlite_stat1` on
 * SQLite) and are labelled as such — running `COUNT(*)` on every table to
 * populate a sidebar is exactly the kind of query a browser tool should never
 * issue on its own.
 *
 * ## Icons carry the kind, so the badge does not have to
 *
 * Every row used to be a name plus a grey `view` / `virtual` word plus a count,
 * and — in a vector store — an identical purple sparkle on all three tables,
 * which made the one useful distinction invisible. Now the leading glyph *is*
 * the kind, in the kind's own colour (table/emerald, view/cyan, virtual/cyan
 * stacked, foreign/indigo), so a list of forty `nodes_fts_*` shadow tables is
 * separable from the four real ones at a glance without reading a word. The
 * "backs the special view" fact keeps its own mark, at the end of the row,
 * because it is a different question from "what kind of object is this".
 */

import { useMemo, useState } from 'react'
import { Glyph, tableIconFor } from './iconography.js'
import { Appear } from './motion.js'
import { hint } from './shortcuts.js'
import type { TableMeta, TableRef } from '../types.js'

export interface TableListProps {
  tables: readonly TableMeta[]
  active: TableRef | null
  loading?: boolean
  error?: string | null
  /**
   * Tables that back a special mode (`chunk`, `embedding`, `nodes`, …). Marked,
   * so it is obvious which rows the search or graph view is actually reading.
   */
  backingTables?: readonly string[]
  /**
   * Group under a schema heading. Off for SQLite, where every ordinary table
   * lives in `main` and one "main" heading above the whole list is pure chrome.
   */
  groupBySchema?: boolean
  onOpen: (table: TableRef) => void
  onReload: () => void
}

const KIND_TITLE: Record<string, string> = {
  view: 'View — a stored query, not stored rows',
  matview: 'Materialised view — a stored query with stored results',
  foreign: 'Foreign table — rows live in another server',
  partitioned: 'Partitioned table — rows live in its partitions',
  virtual: 'Virtual table — an extension module backs it (FTS, rtree…)',
  table: 'Table',
}

export function TableList({
  tables,
  active,
  loading,
  error,
  backingTables,
  groupBySchema = true,
  onOpen,
  onReload,
}: TableListProps) {
  const [query, setQuery] = useState('')
  const backing = useMemo(
    () => new Set((backingTables ?? []).map((t) => t.toLowerCase())),
    [backingTables],
  )

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(q))
      : tables
    const map = new Map<string, TableMeta[]>()
    for (const t of filtered) {
      const key = groupBySchema ? t.schema : ''
      const list = map.get(key) ?? []
      list.push(t)
      map.set(key, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [tables, query, groupBySchema])

  const shown = grouped.reduce((n, [, list]) => n + list.length, 0)

  return (
    <aside className="dbb-sidebar">
      <div className="dbb-sidebar-head">
        <span className="dbb-search-wrap">
          <Glyph name="search" size="sm" />
          <input
            className="dbb-search"
            value={query}
            placeholder="Filter tables…"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter tables"
            data-dbb-focus="search"
          />
        </span>
        <button
          type="button"
          className="dbb-icon-btn"
          onClick={onReload}
          disabled={loading}
          aria-label="Re-read the schema"
          title={hint('Re-read the schema', 'f5')}
        >
          <Glyph name={loading ? 'busy' : 'refresh'} size="md" spin={loading} />
        </button>
      </div>

      {/* A failure to read the schema must be visible *and* recoverable in the
          same place. The spinner it replaces offered neither: an unanswered
          request left this pane on "Loading tables…" with nothing to press. */}
      {error ? (
        <div className="dbb-banner dbb-banner-error" role="alert">
          <Glyph name="failure" size="sm" />
          <span>
            {error}{' '}
            <button type="button" className="dbb-link-btn" onClick={onReload} disabled={loading}>
              Try again
            </button>
          </span>
        </div>
      ) : null}
      {loading && !tables.length ? <div className="dbb-empty">Loading tables…</div> : null}
      {query && !shown ? (
        <div className="dbb-empty">
          No table matches “{query}”.
        </div>
      ) : null}

      <div className="dbb-sidebar-scroll">
        {grouped.map(([schema, list]) => (
          <div key={schema || '(flat)'} className="dbb-schema-group">
            {schema ? (
              <div className="dbb-schema-name">
                <Glyph name="schema" size="sm" />
                {schema}
              </div>
            ) : null}
            <ul>
              {list.map((t, i) => {
                const isActive = active?.schema === t.schema && active?.name === t.name
                const isBacking = backing.has(t.name.toLowerCase())
                return (
                  <Appear as="li" key={`${t.schema}.${t.name}`} index={Math.min(i, 12)} y={3}>
                    <button
                      type="button"
                      className={isActive ? 'dbb-table-item dbb-table-item-active' : 'dbb-table-item'}
                      onClick={() => onOpen({ schema: t.schema, name: t.name })}
                      title={t.comment ?? KIND_TITLE[t.kind] ?? t.kind}
                      aria-current={isActive}
                    >
                      <Glyph name={tableIconFor(t.kind)} size="md" />
                      <span className="dbb-table-name">{t.name}</span>
                      {isBacking ? (
                        <span
                          className="dbb-table-backing"
                          title="This table backs the special view for this database"
                          aria-label="backs the special view"
                        >
                          <Glyph name="semanticSearch" size="sm" />
                        </span>
                      ) : null}
                      <span className="dbb-muted dbb-table-count" title="estimate, not COUNT(*)">
                        {t.rowCountEstimate >= 0 ? `~${t.rowCountEstimate.toLocaleString()}` : '—'}
                      </span>
                    </button>
                  </Appear>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </aside>
  )
}
