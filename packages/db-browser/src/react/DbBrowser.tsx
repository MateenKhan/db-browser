/**
 * `<DbBrowser dataSource={…} />` — the whole tool in one component.
 *
 * It owns nothing about *how* data arrives; swap the `DataSource` and the same
 * UI browses Postgres over HTTP, a SQLite file in a worker, or a mock in a
 * test.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { DataGrid } from './DataGrid.js'
import { Toolbar } from './Toolbar.js'
import { PendingChanges } from './PendingChanges.js'
import { SqlConsole } from './SqlConsole.js'
import { TableList } from './TableList.js'
import { BinaryDialog } from './BinaryDialog.js'
import { useTableStorageScope, getTableStorageScope } from './lazyTable.js'
import { useDbBrowser } from './useDbBrowser.js'
import type { ColumnMeta, DataSource, Row } from '../types.js'

export interface DbBrowserClassNames {
  root?: string
  sidebar?: string
  main?: string
}

export interface DbBrowserProps {
  dataSource: DataSource
  /** Rows per page before the user changes it. Default 100. */
  defaultLimit?: number
  /** Ceiling the user cannot raise past. Default 1000. */
  maxLimit?: number
  /** Open a table on mount. */
  initialTable?: { schema: string; name: string }
  classNames?: DbBrowserClassNames
  /** Extra content in the header (a connection picker, a sign-out button…). */
  headerSlot?: ReactNode
}

export function DbBrowser({
  dataSource,
  defaultLimit = 100,
  maxLimit = 1000,
  initialTable,
  classNames,
  headerSlot,
}: DbBrowserProps) {
  const state = useDbBrowser(dataSource, { defaultLimit, maxLimit })
  const [tab, setTab] = useState<'data' | 'sql'>('data')
  const [binary, setBinary] = useState<{ row: Row; column: ColumnMeta } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Re-point the embedded table's localStorage namespace at the table on
  // screen, so per-column view state never crosses tables or connections.
  useTableStorageScope(dataSource.id, state.active)

  useEffect(() => {
    if (initialTable && !state.active) state.openTable(initialTable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTable])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const caps = dataSource.capabilities()

  return (
    <div className={`dbb-root ${classNames?.root ?? ''}`}>
      <header className="dbb-header">
        <span className="dbb-brand">Database browser</span>
        <span className="dbb-badge dbb-badge-muted" title="Display label — never a connection string">
          {caps.label ?? 'connection'}
        </span>
        <span className={caps.writes ? 'dbb-badge dbb-badge-write' : 'dbb-badge dbb-badge-read'}>
          {caps.writes ? 'writes enabled' : 'read-only'}
        </span>
        <nav className="dbb-tabs">
          <button
            type="button"
            className={tab === 'data' ? 'dbb-tab dbb-tab-active' : 'dbb-tab'}
            onClick={() => setTab('data')}
          >
            Data
          </button>
          <button
            type="button"
            className={tab === 'sql' ? 'dbb-tab dbb-tab-active' : 'dbb-tab'}
            onClick={() => setTab('sql')}
          >
            SQL
          </button>
        </nav>
        <span className="dbb-spacer" />
        {state.active ? (
          <button
            type="button"
            className="dbb-link"
            title="Forget colours, merges and column types saved for this table"
            onClick={() => {
              getTableStorageScope()?.clearScope()
              setToast('Cleared this table’s saved view state.')
            }}
          >
            reset view state
          </button>
        ) : null}
        {headerSlot}
      </header>

      <div className={`dbb-body ${classNames?.main ?? ''}`}>
        <TableList
          tables={state.tables}
          active={state.active}
          loading={state.tablesLoading}
          error={state.tablesError}
          onOpen={(t) => {
            state.openTable(t)
            setTab('data')
          }}
          onReload={state.reloadTables}
        />

        <main className="dbb-main">
          {tab === 'data' ? (
            <>
              <Toolbar state={state} />
              <PendingChanges
                state={state}
                onCommitted={(applied, errors) =>
                  setToast(
                    errors.length
                      ? `${applied} applied, ${errors.length} failed: ${errors[0]}`
                      : `${applied} row${applied === 1 ? '' : 's'} updated.`,
                  )
                }
              />
              <DataGrid
                state={state}
                onInspectBinary={(row, column) => setBinary({ row, column })}
              />
            </>
          ) : (
            <SqlConsole
              dataSource={dataSource}
              tables={state.tables}
              schemas={state.schemas}
              defaultLimit={defaultLimit}
              maxLimit={maxLimit}
            />
          )}
        </main>
      </div>

      {binary && state.schema ? (
        <BinaryDialog
          dataSource={dataSource}
          schema={state.schema}
          row={binary.row}
          column={binary.column}
          onClose={() => setBinary(null)}
        />
      ) : null}

      {toast ? (
        <div className="dbb-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  )
}
