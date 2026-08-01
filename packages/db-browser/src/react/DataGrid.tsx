/**
 * The browsed table: `SpreadsheetTable` fed one page of rows.
 *
 * ## Where the column's type comes from
 *
 * Not from this file. Each column arrives with a `normalizedType` — the
 * engine-agnostic vocabulary in `metadata/normalizedTypes.ts` — and
 * `resolveColumnPreset()` maps that to a **preset id in `@jugaaadi/table`'s own
 * `ColumnTypePreset` registry**, together with whether the column can be edited
 * at all. The header then resolves that id through the live registry
 * (`useColumnTypePresets`), so the name it reports is the grid's name, a user's
 * custom preset resolves like a built-in, and a preset renamed upstream renames
 * here without a change in this package.
 *
 * ## Why the *cells* are still declared `text`
 *
 * The preset drives the header, the icon, the alignment and the lock. It
 * deliberately does **not** drive `meta.type` on the cell, and that is a
 * correctness decision rather than an oversight: the grid's `number` editor
 * truncates its operand and its `date` editor reformats, and both write the
 * result back through `onDataChange` — so a 20-digit `bigint` id or a
 * `timestamptz` would be silently rewritten by the act of looking at it. Values
 * stay exactly as the driver sent them, and coercion happens once, at commit,
 * against the column's real category. The type information lives in the header,
 * where it can be read without being applied.
 *
 * Binary is the visible payoff: a `bytea` column shows `768 dims · 3.0 KB`
 * rather than three megabytes of hex, is marked non-editable by the same
 * resolution, and fetches its bytes only when a cell is clicked.
 */

import { Suspense, useMemo } from 'react'
import { Glyph, typeIconFor } from './iconography.js'
import { LazySpreadsheetTable, useColumnTypePresets } from './lazyTable.js'
import { Appear } from './motion.js'
import { resolveColumnPreset } from '../metadata/columnTypePresets.js'
import { isBinaryPlaceholder } from '../render/values.js'
import type { ColumnMeta, Row } from '../types.js'
import type { DbBrowserState } from './useDbBrowser.js'

export interface DataGridProps {
  state: DbBrowserState
  onInspectBinary?: (row: Row, column: ColumnMeta) => void
}

function ColumnHeader({
  column,
  presetName,
}: {
  column: ColumnMeta
  presetName: (id: string) => string | undefined
}) {
  const resolution = resolveColumnPreset(column)
  const preset = presetName(resolution.presetId)
  const typeTitle = [
    column.dataType,
    column.nullable ? 'nullable' : 'NOT NULL',
    `edits as ${preset ?? resolution.presetId}`,
    resolution.notEditableReason,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <span className="dbb-col">
      <span className="dbb-col-name">
        {column.name}
        {column.isPrimaryKey ? (
          <span title={`Primary key${column.primaryKeyPosition ? ` (${column.primaryKeyPosition})` : ''}`}>
            <Glyph name="primaryKey" size="sm" />
          </span>
        ) : null}
        {column.foreignKey ? (
          <span
            title={`References ${column.foreignKey.schema}.${column.foreignKey.table}.${column.foreignKey.column}`}
          >
            <Glyph name="foreignKey" size="sm" />
          </span>
        ) : null}
        {!resolution.editable ? (
          <span title={resolution.notEditableReason ?? 'Read-only column'}>
            <Glyph name="readOnly" size="sm" tone="mute" />
          </span>
        ) : null}
      </span>
      <span className="dbb-col-meta" title={typeTitle}>
        <Glyph name={typeIconFor(column.normalizedType)} size="sm" />
        <span className="dbb-type">{column.dataType}</span>
      </span>
    </span>
  )
}

export function DataGrid({ state, onInspectBinary }: DataGridProps) {
  const { schema, page, displayRows } = state
  const presetName = useColumnTypePresets()

  const columns = useMemo(() => {
    if (!page) return []
    return page.columns.map((column) => ({
      accessorKey: column.name,
      id: column.name,
      header: () => <ColumnHeader column={column} presetName={(id) => presetName(id)?.label} />,
      // See this file's header: the resolved preset drives presentation, not
      // the cell's storage type. `text` is what keeps values byte-exact.
      meta: { type: 'text' as const },
    }))
    // `presetName` is a fresh closure each render but reads a module-level
    // registry; re-deriving columns on it would remount the grid on every
    // render, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  const binaryColumns = useMemo(() => (page?.columns ?? []).filter((c) => c.isBinary), [page])

  if (!schema) {
    return (
      <div className="dbb-empty dbb-empty-lg">
        <Glyph name="grid" size="lg" />
        <p>Pick a table to browse.</p>
        <p className="dbb-muted">
          Press <kbd>/</kbd> to filter the list, or <kbd>Ctrl</kbd>+<kbd>K</kbd> to jump straight to a
          table.
        </p>
      </div>
    )
  }

  return (
    <div className="dbb-grid-wrap">
      {!schema.updatable ? (
        <Appear className="dbb-banner dbb-banner-info">
          <Glyph name="readOnly" size="sm" />
          <span>
            <strong>Read-only.</strong> {schema.notUpdatableReason}
          </span>
        </Appear>
      ) : schema.rowIdentity === 'implicit' ? (
        // Editable, but *not* through a key the schema declares. Saying so is
        // the point: a rowid is unique now and is not guaranteed to survive a
        // VACUUM, so a user who plans to script against these keys has to know
        // where they came from.
        <Appear className="dbb-banner dbb-banner-info">
          <Glyph name="primaryKey" size="sm" />
          <span>
            <strong>Editable via {schema.primaryKey.join(', ')}.</strong> {schema.identityNote}
          </span>
        </Appear>
      ) : null}

      {state.rejection ? (
        <div className="dbb-banner dbb-banner-warn" role="alert">
          <Glyph name="danger" size="sm" />
          <span>
            <strong>Edit not staged.</strong> {state.rejection}
          </span>
          <button type="button" className="dbb-link" onClick={state.clearRejection}>
            dismiss
          </button>
        </div>
      ) : null}

      {binaryColumns.length && onInspectBinary ? (
        <div className="dbb-banner dbb-banner-info">
          <Glyph name="typeBinary" size="sm" />
          <span>
            {binaryColumns.map((c) => c.name).join(', ')} show size only — click a cell to fetch the
            bytes. Nothing is preloaded and no blob URL is kept.
          </span>
        </div>
      ) : null}

      <div className="dbb-grid">
        {state.loading && !page ? (
          <div className="dbb-empty">Loading…</div>
        ) : state.error ? (
          <div className="dbb-banner dbb-banner-error" role="alert">
            <Glyph name="failure" size="sm" />
            {state.error}
          </div>
        ) : (
          <Suspense fallback={<div className="dbb-empty">Loading grid…</div>}>
            <LazySpreadsheetTable
              // Re-mounting on every page/table change is what guarantees the
              // grid never carries state from a previous result set.
              key={`${schema.table.schema}.${schema.table.name}:${state.pageIndex}:${state.gridKey}`}
              columns={columns}
              data={displayRows}
              onDataChange={(rows: Row[]) => state.applyGridRows(rows)}
              onCellClick={(info: { rowIndex: number; columnId: string }) => {
                const column = page?.columns.find((c) => c.name === info.columnId)
                const raw = page?.rows[info.rowIndex]
                if (column?.isBinary && raw && isBinaryPlaceholder(raw[column.name])) {
                  onInspectBinary?.(raw, column)
                }
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}
