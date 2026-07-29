/**
 * `@jugaaadi/db-browser` — a reusable database browser for React.
 *
 * ```tsx
 * import { DbBrowser, createHttpDataSource } from '@jugaaadi/db-browser'
 * import '@jugaaadi/table/style.css'
 * import '@jugaaadi/db-browser/style.css'
 *
 * const source = createHttpDataSource({ baseUrl: '/api/db' })
 * <DbBrowser dataSource={source} />
 * ```
 *
 * Import `@jugaaadi/db-browser/core` instead when you need the contract, the
 * SQL guard or the pagination planner without React.
 */

import './styles.css'

export * from './core.js'

export { DbBrowser } from './react/DbBrowser.js'
export type { DbBrowserProps, DbBrowserClassNames } from './react/DbBrowser.js'
export { DataGrid } from './react/DataGrid.js'
export { TableList } from './react/TableList.js'
export { Toolbar } from './react/Toolbar.js'
export { PendingChanges } from './react/PendingChanges.js'
export { SqlConsole } from './react/SqlConsole.js'
export { SqlEditor } from './react/SqlEditor.js'
export { BinaryDialog } from './react/BinaryDialog.js'
export { useDbBrowser } from './react/useDbBrowser.js'
export type { DbBrowserState, UseDbBrowserOptions, CommitOutcome } from './react/useDbBrowser.js'
export {
  LazySpreadsheetTable,
  getTableStorageScope,
  useTableStorageScope,
} from './react/lazyTable.js'
export { formatQuery } from './sql/format.js'
export type { FormatOptions } from './sql/format.js'
export { downloadText, toCsv, toJson } from './react/exportRows.js'
export {
  clearHistory,
  deleteSavedQuery,
  loadHistory,
  loadSavedQueries,
  pushHistory,
  saveQuery,
} from './react/localState.js'
export type { HistoryEntry, SavedQuery } from './react/localState.js'
