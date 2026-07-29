/**
 * The browsed table: `SpreadsheetTable` fed one page of rows, plus the
 * pagination / limit / sort controls that keep it honest.
 *
 * Type-aware rendering happens through the column *header* (which shows the
 * SQL type, PK/FK badges and nullability) and through the display values
 * themselves — NULL as `␀`, JSON/arrays as compact JSON, binary as a metadata
 * chip. The grid stays a text editor underneath, so nothing is silently
 * re-typed on the way in or out; coercion happens once, at commit, against the
 * column's real category.
 */

import { Suspense, useMemo } from 'react'
import { LazySpreadsheetTable } from './lazyTable.js'
import { isBinaryPlaceholder } from '../render/values.js'
import type { ColumnMeta, Row } from '../types.js'
import type { DbBrowserState } from './useDbBrowser.js'

export interface DataGridProps {
  state: DbBrowserState
  onInspectBinary?: (row: Row, column: ColumnMeta) => void
}

const CATEGORY_LABEL: Record<string, string> = {
  number: '#',
  boolean: '01',
  timestamp: '🕑',
  date: '🕑',
  time: '🕑',
  json: '{}',
  uuid: 'id',
  array: '[]',
  enum: '≡',
  binary: '⛁',
}

function ColumnHeader({ column }: { column: ColumnMeta }) {
  return (
    <span className="dbb-col">
      <span className="dbb-col-name">{column.name}</span>
      <span className="dbb-col-meta">
        {column.isPrimaryKey ? <span className="dbb-badge dbb-badge-pk">PK</span> : null}
        {column.foreignKey ? (
          <span
            className="dbb-badge dbb-badge-fk"
            title={`→ ${column.foreignKey.schema}.${column.foreignKey.table}.${column.foreignKey.column}`}
          >
            FK
          </span>
        ) : null}
        <span className="dbb-type" title={`${column.dataType}${column.nullable ? ' · nullable' : ' · NOT NULL'}`}>
          {CATEGORY_LABEL[column.category] ?? ''} {column.dataType}
        </span>
      </span>
    </span>
  )
}

export function DataGrid({ state, onInspectBinary }: DataGridProps) {
  const { schema, page, displayRows } = state

  const columns = useMemo(() => {
    if (!page) return []
    return page.columns.map((column) => ({
      accessorKey: column.name,
      id: column.name,
      header: () => <ColumnHeader column={column} />,
      // Deliberately always 'text'. Declaring a column as `number`/`date` to
      // the grid also opts it into that type's formatter, which would round a
      // bigint and re-render a timestamp in the grid's format — and then
      // commit that back. Values stay exact; coercion happens once, at commit,
      // from the column's real category. The header carries the type
      // information instead.
      meta: { type: 'text' as const },
    }))
  }, [page])

  const binaryColumns = useMemo(
    () => (page?.columns ?? []).filter((c) => c.isBinary),
    [page],
  )

  if (!schema) {
    return (
      <div className="dbb-empty">
        <p>Pick a table to browse.</p>
      </div>
    )
  }

  return (
    <div className="dbb-grid-wrap">
      {!schema.updatable ? (
        <div className="dbb-banner dbb-banner-info" role="status">
          <strong>Read-only.</strong> {schema.notUpdatableReason}
        </div>
      ) : null}

      {state.rejection ? (
        <div className="dbb-banner dbb-banner-warn" role="alert">
          <strong>Edit not staged.</strong> {state.rejection}
          <button type="button" className="dbb-link" onClick={state.clearRejection}>
            dismiss
          </button>
        </div>
      ) : null}

      {binaryColumns.length && onInspectBinary ? (
        <div className="dbb-banner dbb-banner-info">
          Binary column{binaryColumns.length > 1 ? 's' : ''}{' '}
          {binaryColumns.map((c) => c.name).join(', ')} show size only. Select a row and use{' '}
          <em>Fetch binary</em> to download the bytes — nothing is preloaded, and no blob URL is
          kept.
        </div>
      ) : null}

      <div className="dbb-grid">
        {state.loading && !page ? (
          <div className="dbb-empty">Loading…</div>
        ) : state.error ? (
          <div className="dbb-banner dbb-banner-error" role="alert">
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
