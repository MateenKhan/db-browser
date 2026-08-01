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
export type { DbBrowserProps, DbBrowserClassNames, BrowserSource } from './react/DbBrowser.js'
export { DataGrid } from './react/DataGrid.js'
export { TableList } from './react/TableList.js'
export { Toolbar } from './react/Toolbar.js'
export { PendingChanges } from './react/PendingChanges.js'
export { SqlConsole } from './react/SqlConsole.js'
export { SqlEditor } from './react/SqlEditor.js'
export { BinaryDialog } from './react/BinaryDialog.js'
// Vector / code-graph mode. Exported individually as well as through
// `DbBrowser`, so a consumer can compose their own layout — e.g. embed just the
// search box in a page that already has its own chrome.
export { VectorBrowser } from './react/VectorBrowser.js'
export type { VectorBrowserProps } from './react/VectorBrowser.js'
export { CodeGraphBrowser } from './react/CodeGraphBrowser.js'
export type { CodeGraphBrowserProps } from './react/CodeGraphBrowser.js'
export { SearchResults } from './react/SearchResults.js'
export type { SearchResultsProps } from './react/SearchResults.js'
export { KindFilter, CODE_KINDS, kindClass } from './react/KindFilter.js'
export type { KindFilterProps } from './react/KindFilter.js'
export { SnippetHighlight } from './react/SnippetHighlight.js'
export type { SnippetHighlightProps } from './react/SnippetHighlight.js'
export { RebuildControl } from './react/RebuildControl.js'
export type { RebuildControlProps } from './react/RebuildControl.js'
export { useRebuildJob } from './react/useRebuildJob.js'
export type { RebuildState } from './react/useRebuildJob.js'
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

// --- design system ---------------------------------------------------------
// The icon registry, the motion primitives and the shortcut layer are exported
// so a host application can extend the browser without introducing a second
// visual or interaction language beside it: register a shortcut and it appears
// in the same `?` cheat sheet, use `<Glyph>` and your icon is in the same
// palette, use `<Appear>` and it honours the same reduced-motion guard.
export { Glyph, ICONS, ICON_PX, typeIconFor, tableIconFor } from './react/iconography.js'
export type { GlyphProps, IconName, IconSize, IconTone } from './react/iconography.js'
export { Appear, PaneTransition, useMotionOK, useCondense, EASE, DUR } from './react/motion.js'
export {
  ShortcutProvider,
  useShortcuts,
  useShortcutList,
  isTypingTarget,
  keyLabel,
  keyLabelParts,
  hint,
} from './react/shortcuts.js'
export type { ShortcutSpec } from './react/shortcuts.js'
// Platform-aware key naming. Exported so a host application's own shortcut
// hints are spelled the same way — `Ctrl` on Windows and Linux, `⌘` only on
// macOS — instead of hard-coding a glyph its users may not have a key for.
export { PLATFORM, IS_MAC, detectPlatform, keyToken, splitKeys, formatKeys } from './react/platform.js'
export type { Platform, PlatformNavigator } from './react/platform.js'
export { ShortcutOverlay } from './react/ShortcutOverlay.js'
export { CommandPalette } from './react/CommandPalette.js'
export type { CommandPaletteProps, PaletteCommand } from './react/CommandPalette.js'
export { Dialog } from './react/Dialog.js'
export type { DialogProps } from './react/Dialog.js'

// --- connection manager ----------------------------------------------------
export { ConnectionManager } from './react/connections/ConnectionManager.js'
export type { ConnectionManagerProps } from './react/connections/ConnectionManager.js'
export { ConnectionForm } from './react/connections/ConnectionForm.js'
export { ConnectorList } from './react/connections/ConnectorList.js'
export { EnginePicker } from './react/connections/EnginePicker.js'
export type { EnginePickerProps } from './react/connections/EnginePicker.js'
export { useConnectorInstall } from './react/connections/useConnectorInstall.js'
export type { ConnectorInstalls, InstallState } from './react/connections/useConnectorInstall.js'
export { createHttpConnectionsApi, pollInstall } from './react/connections/client.js'
export { describeTest, connectorAvailability } from './react/connections/types.js'
export type { HttpConnectionsOptions } from './react/connections/client.js'
// The envelope parsers, exported so a host supplying its own transport can
// reuse the exact tolerance the built-in client has — and, more importantly,
// the exact loudness: a shape these do not recognise throws rather than
// resolving to an empty list.
export {
  ConnectionsEnvelopeError,
  describeShape,
  parseConnectionBody,
  parseConnectionsBody,
  parseConnectorsBody,
  parseInstallJobBody,
  parseInstallProgressBody,
  parseTestResultBody,
} from './react/connections/envelope.js'
export type { EditingGate, ParsedConnections, ParsedConnectors } from './react/connections/envelope.js'
export type { ConnectorAvailability } from './react/connections/types.js'
export type {
  ConnectionDraft,
  ConnectionField,
  ConnectionFieldKind,
  ConnectionsApi,
  ConnectionsSnapshot,
  ConnectionValues,
  ConnectorCapabilities,
  ConnectorDescriptor,
  ConnectorsSnapshot,
  ConnectorStatus,
  EditPolicy,
  InstallProgress,
  StoredConnection,
  TestResult,
} from './react/connections/types.js'
