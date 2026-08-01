/**
 * `<DbBrowser dataSource={…} />` — the whole tool in one component.
 *
 * It owns nothing about *how* data arrives; swap the `DataSource` and the same
 * UI browses Postgres over HTTP, a SQLite file in a Node process, or a mock in
 * a test.
 *
 * ## Modes
 *
 * Not every database is a set of tables you want to look at as a grid. Some
 * SQLite files are **embedding stores** — derived data whose only useful
 * question is "what is this about" — and some are **code graphs**. The
 * `DataSource` reports which (`describeDatabase()`), detected from the schema
 * rather than from configuration, and the main pane follows:
 *
 * | mode | pane | why |
 * | :-- | :-- | :-- |
 * | `relational` | grid + toolbar + pending changes | rows are the subject |
 * | `vector` | semantic search, ranked results, stats, rebuild | rows are 3 KB of floats |
 * | `code-graph` | node/edge overview, read-only, rebuild | rows are derived facts |
 *
 * **The grid never goes away.** Every special mode is one tab away from the
 * `Data` tab, because "show me the actual rows" is always a legitimate question
 * — the special view is the better default, not a replacement. `describeDatabase`
 * is optional and any failure falls back to `relational`, so an adapter that
 * has never heard of profiles (or a server mid-upgrade) still works.
 *
 * ## The title bar says each thing once
 *
 * An earlier revision put the database name, the engine, the detected mode and
 * the read-only posture in four separate pills, and then repeated the mode as a
 * heading and a sentence in the pane below, and the engine again as a badge in
 * the SQL console. Every one of those facts now has exactly one home:
 *
 * | fact | where it lives | why there |
 * | :-- | :-- | :-- |
 * | database name | the title cluster, left | it is the title |
 * | engine | muted, under the name | it qualifies the name; it is never the subject |
 * | mode | the first tab's own name and icon (`Search` / `Graph`) | the mode *is* what that tab shows |
 * | read-only | one lock glyph beside the name | a posture, not a headline |
 * | current table | the toolbar, above the grid | it changes as you browse |
 *
 * Anything that needs more than a glyph — why a mode was detected, what the
 * lock means — is a tooltip, not another pill.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CodeGraphBrowser } from './CodeGraphBrowser.js'
import { CommandPalette } from './CommandPalette.js'
import type { PaletteCommand } from './CommandPalette.js'
import { DataGrid } from './DataGrid.js'
import { Toolbar } from './Toolbar.js'
import { PendingChanges } from './PendingChanges.js'
import { ShortcutOverlay } from './ShortcutOverlay.js'
import { SqlConsole } from './SqlConsole.js'
import { TableList } from './TableList.js'
import { BinaryDialog } from './BinaryDialog.js'
import { VectorBrowser } from './VectorBrowser.js'
import { Glyph } from './iconography.js'
import { PaneTransition } from './motion.js'
import { RootElementProvider } from './rootPortal.js'
import { ShortcutProvider, hint, useShortcuts } from './shortcuts.js'
import { ConnectionManager } from './connections/ConnectionManager.js'
import type { ConnectionsApi } from './connections/types.js'
import { useTableStorageScope, getTableStorageScope } from './lazyTable.js'
import { useDbBrowser } from './useDbBrowser.js'
import { asDialect, DIALECT_LABEL } from '../sql/dialect.js'
import type { ColumnMeta, DataSource, DatabaseProfile, Row, VectorService } from '../types.js'

export interface DbBrowserClassNames {
  root?: string
  sidebar?: string
  main?: string
}

/** One entry in the source switcher. */
export interface BrowserSource {
  id: string
  label: string
  /** Engine, path, anything that disambiguates two similarly named sources. */
  detail?: string
  disabled?: boolean
  disabledReason?: string
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
  /** Extra content in the header, after the built-in controls. */
  headerSlot?: ReactNode
  /**
   * Semantic search + rebuild, for a vector store or code graph. Optional, and
   * separate from `dataSource` because the indexer is a **different process**
   * that may not be running: without it the special views still render and only
   * the controls that need it report themselves unavailable.
   */
  vectorService?: VectorService | null
  /**
   * Force a mode instead of asking the source. For tests, and for a consumer
   * that already knows; normally leave it off and let detection decide.
   */
  forceMode?: DatabaseProfile['mode']
  /** Every source the host can switch between, for the picker and the palette. */
  sources?: readonly BrowserSource[]
  activeSourceId?: string | null
  onSelectSource?: (id: string) => void
  /**
   * The connection manager's backend. Null (the default) hides the button
   * entirely — a manager with nothing behind it is worse than no manager.
   */
  connectionsApi?: ConnectionsApi | null
  /** Re-read sources after the manager changes one. */
  onConnectionsChanged?: () => void
}

/** Which pane the main area shows. `auto` = whatever this database is. */
type Pane = 'auto' | 'tables' | 'sql'

export function DbBrowser(props: DbBrowserProps) {
  // The shortcut registry has to wrap everything that registers a binding,
  // including the header controls, so it is the outermost thing this component
  // renders rather than something the host has to remember to install.
  return (
    <ShortcutProvider>
      <DbBrowserInner {...props} />
    </ShortcutProvider>
  )
}

function DbBrowserInner({
  dataSource,
  defaultLimit = 100,
  maxLimit = 1000,
  initialTable,
  classNames,
  headerSlot,
  vectorService = null,
  forceMode,
  sources,
  activeSourceId,
  onSelectSource,
  connectionsApi = null,
  onConnectionsChanged,
}: DbBrowserProps) {
  const state = useDbBrowser(dataSource, { defaultLimit, maxLimit })
  const [pane, setPane] = useState<Pane>('auto')
  const [binary, setBinary] = useState<{ row: Row; column: ColumnMeta } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [profile, setProfile] = useState<DatabaseProfile | null>(null)
  const [profileNonce, setProfileNonce] = useState(0)
  const [palette, setPalette] = useState(false)
  const [cheatsheet, setCheatsheet] = useState(false)
  const [manager, setManager] = useState(false)
  const sourceSelect = useRef<HTMLSelectElement | null>(null)
  const rootEl = useRef<HTMLDivElement | null>(null)
  // The ref is populated after the first paint, and `usePortalTarget` reads it
  // during render — so one re-render is needed before an overlay can portal
  // into the root. Every overlay starts closed, so nothing is ever missed.
  const [, setRootReady] = useState(false)
  useEffect(() => setRootReady(true), [])

  // Re-point the embedded table's localStorage namespace at the table on
  // screen, so per-column view state never crosses tables or connections.
  useTableStorageScope(dataSource.id, state.active)

  useEffect(() => {
    if (initialTable && !state.active) state.openTable(initialTable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTable])

  // What kind of database is this? Asked once per source, and again after a
  // rebuild. A source that cannot answer, or that throws, is treated as
  // relational — never as a failure, because the grid works either way.
  useEffect(() => {
    if (forceMode || !dataSource.describeDatabase) {
      setProfile(null)
      return
    }
    let cancelled = false
    dataSource
      .describeDatabase()
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => {
        if (!cancelled) setProfile(null)
      })
    return () => {
      cancelled = true
    }
  }, [dataSource, forceMode, profileNonce])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [toast])

  const caps = dataSource.capabilities()
  const dialect = asDialect(caps.dialect)
  const mode = forceMode ?? profile?.mode ?? 'relational'
  const special = mode !== 'relational'
  const showSpecial = special && pane === 'auto'
  /** The database a SQLite file's tables live in; `public` on Postgres. */
  const primarySchema = state.tables[0]?.schema ?? (dialect === 'sqlite' ? 'main' : 'public')

  const refreshProfile = useCallback(() => setProfileNonce((n) => n + 1), [])

  const openTable = useCallback(
    (table: { schema: string; name: string }) => {
      state.openTable(table)
      setPane('tables')
    },
    // `state` is rebuilt every render; `openTable` on it is a stable useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.openTable],
  )

  /**
   * `/` focuses "the search box on this screen", whichever screen that is —
   * the semantic search box in vector mode, the table filter otherwise. Rather
   * than thread a ref through four components, the target marks itself with
   * `data-dbb-focus="search"` and this picks the first one that is actually
   * rendered. One attribute per search box, no plumbing, and a pane that grows
   * a search box gets the shortcut by adding the attribute.
   */
  const focusSearch = useCallback(() => {
    const root = document.querySelector('.dbb-root')
    const box = root?.querySelector<HTMLInputElement>('[data-dbb-focus="search"]')
    box?.focus()
    box?.select?.()
  }, [])

  const anyOverlay = palette || cheatsheet || manager || !!binary
  const closeOverlays = useCallback(() => {
    setPalette(false)
    setCheatsheet(false)
    setManager(false)
    setBinary(null)
  }, [])

  useShortcuts([
    { id: 'palette', keys: 'mod+k', label: 'Command palette', group: 'Global', run: () => setPalette(true) },
    { id: 'cheatsheet', keys: '?', label: 'Keyboard shortcuts', group: 'Global', run: () => setCheatsheet((v) => !v) },
    {
      id: 'close',
      keys: 'escape',
      label: 'Close dialog',
      group: 'Global',
      enabled: anyOverlay,
      run: closeOverlays,
    },
    { id: 'focus-search', keys: '/', label: 'Focus search', group: 'Navigate', run: focusSearch },
    {
      id: 'pane-auto',
      keys: 'alt+1',
      label: special ? (mode === 'vector' ? 'Go to Search' : 'Go to Graph') : 'Go to Data',
      group: 'Navigate',
      run: () => setPane('auto'),
    },
    { id: 'pane-data', keys: 'alt+2', label: 'Go to Data', group: 'Navigate', enabled: special, run: () => setPane('tables') },
    { id: 'pane-sql', keys: 'alt+3', label: 'Go to SQL', group: 'Navigate', run: () => setPane('sql') },
    {
      id: 'switch-source',
      keys: 'mod+shift+s',
      label: 'Switch source',
      group: 'Navigate',
      enabled: !!sources?.length,
      run: () => sourceSelect.current?.focus(),
    },
    {
      id: 'refresh',
      keys: 'f5',
      label: 'Refresh',
      group: 'Data',
      run: () => {
        if (pane === 'tables' || (!special && pane === 'auto')) state.refresh()
        state.reloadTables()
        refreshProfile()
      },
    },
    {
      id: 'page-next',
      keys: ']',
      label: 'Next page',
      group: 'Data',
      enabled: !!state.active && state.canNext,
      run: state.next,
    },
    {
      id: 'page-prev',
      keys: '[',
      label: 'Previous page',
      group: 'Data',
      enabled: !!state.active && state.canPrev,
      run: state.prev,
    },
    {
      id: 'connections',
      // `alt+c`, not `mod+shift+m`: Chrome binds Ctrl/⌘+Shift+M to the profile
      // switcher and never delivers it to the page, so the cheat sheet would
      // be documenting a shortcut that provably does nothing. See the note in
      // `shortcuts.tsx` about which chords are safe to claim.
      keys: 'alt+c',
      label: 'Manage connections',
      group: 'Connections',
      enabled: !!connectionsApi,
      run: () => setManager(true),
    },
  ])

  const commands = useMemo<PaletteCommand[]>(() => {
    const out: PaletteCommand[] = []
    for (const s of sources ?? []) {
      out.push({
        id: `src:${s.id}`,
        label: `Open source: ${s.label}`,
        detail: s.detail,
        icon: 'database',
        group: 'Sources',
        run: () => onSelectSource?.(s.id),
      })
    }
    for (const t of state.tables) {
      out.push({
        id: `tbl:${t.schema}.${t.name}`,
        label: t.name,
        detail: t.schema,
        icon: t.kind === 'view' || t.kind === 'matview' ? 'view' : 'table',
        group: 'Tables',
        run: () => openTable({ schema: t.schema, name: t.name }),
      })
    }
    if (state.active) {
      out.push({
        id: 'reset-view',
        label: 'Reset this table’s saved view state',
        detail: 'colours, merges, column types',
        icon: 'settings',
        group: 'Data',
        run: () => {
          getTableStorageScope()?.clearScope()
          setToast('Cleared this table’s saved view state.')
        },
      })
    }
    return out
  }, [sources, onSelectSource, state.tables, state.active, openTable])

  const paneKey = pane === 'sql' ? 'sql' : showSpecial ? `special:${mode}` : `tables:${state.active?.name ?? '-'}`

  return (
    <RootElementProvider value={rootEl}>
    <div className={`dbb-root ${classNames?.root ?? ''}`} ref={rootEl}>
      <header className="dbb-header">
        {/* --- identity: name, engine, posture. Said once, each. --- */}
        <div className="dbb-identity">
          <Glyph name="database" size="lg" />
          <span className="dbb-identity-text">
            <span className="dbb-brand" title={caps.label ?? 'connection'}>
              {caps.label ?? 'connection'}
            </span>
            <span className="dbb-identity-sub">
              {DIALECT_LABEL[dialect]}
              {special ? ` · ${mode === 'vector' ? 'vector store' : 'code graph'}` : ''}
            </span>
          </span>
          <span
            className="dbb-posture"
            title={
              caps.writes
                ? 'Writes are enabled on this connection. Statements are still guarded and staged.'
                : 'The server opened this connection read-only. Writes are refused twice: by the guard and by the engine.'
            }
            aria-label={caps.writes ? 'Writes enabled' : 'Read-only connection'}
          >
            <Glyph name={caps.writes ? 'writable' : 'readOnly'} size="md" />
          </span>
        </div>

        {/* --- panes --- */}
        <nav className="dbb-seg dbb-seg-panes" aria-label="View">
          {special ? (
            <button
              type="button"
              className={showSpecial ? 'dbb-seg-btn dbb-seg-on' : 'dbb-seg-btn'}
              onClick={() => setPane('auto')}
              aria-current={showSpecial}
              title={hint(profile?.detectedBy ?? 'Detected from the schema', 'alt+1')}
            >
              <Glyph name={mode === 'vector' ? 'semanticSearch' : 'graph'} size="md" />
              {mode === 'vector' ? 'Search' : 'Graph'}
            </button>
          ) : null}
          <button
            type="button"
            className={
              pane === 'tables' || (!special && pane === 'auto') ? 'dbb-seg-btn dbb-seg-on' : 'dbb-seg-btn'
            }
            onClick={() => setPane('tables')}
            aria-current={pane === 'tables' || (!special && pane === 'auto')}
            title={hint('Browse tables', special ? 'alt+2' : 'alt+1')}
          >
            <Glyph name="grid" size="md" />
            Data
          </button>
          <button
            type="button"
            className={pane === 'sql' ? 'dbb-seg-btn dbb-seg-on' : 'dbb-seg-btn'}
            onClick={() => setPane('sql')}
            aria-current={pane === 'sql'}
            title={hint('SQL console', 'alt+3')}
          >
            <Glyph name="sql" size="md" />
            SQL
          </button>
        </nav>

        <span className="dbb-spacer" />

        {/* --- source switcher --- */}
        {sources?.length ? (
          <label className="dbb-source" title={hint('Switch source', 'mod+shift+s')}>
            <Glyph name="server" size="sm" />
            <span className="dbb-sr-only">Source</span>
            <select
              ref={sourceSelect}
              value={activeSourceId ?? ''}
              onChange={(e) => onSelectSource?.(e.target.value)}
              aria-label="Source"
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id} disabled={s.disabled}>
                  {s.label}
                  {s.detail ? ` · ${s.detail}` : ''}
                  {s.disabled ? ' (unavailable)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {headerSlot}

        <div className="dbb-header-actions">
          {connectionsApi ? (
            <button
              type="button"
              className="dbb-icon-btn"
              onClick={() => setManager(true)}
              aria-label="Manage connections"
              title={hint('Manage connections', 'alt+c')}
            >
              <Glyph name="connection" size="md" />
            </button>
          ) : null}
          <button
            type="button"
            className="dbb-icon-btn"
            onClick={() => setPalette(true)}
            aria-label="Command palette"
            title={hint('Command palette', 'mod+k')}
          >
            <Glyph name="palette" size="md" />
          </button>
          <button
            type="button"
            className="dbb-icon-btn"
            onClick={() => setCheatsheet(true)}
            aria-label="Keyboard shortcuts"
            title={hint('Keyboard shortcuts', '?')}
          >
            <Glyph name="keyboard" size="md" />
          </button>
        </div>
      </header>

      <div className={`dbb-body ${classNames?.main ?? ''}`}>
        {/* Hidden in a special mode: there is no table to pick until you ask
            for the grid, and a table list beside a search box invites reading
            ranked results as rows. */}
        {!showSpecial ? (
          <TableList
            tables={state.tables}
            active={state.active}
            loading={state.tablesLoading}
            error={state.tablesError}
            backingTables={profile?.backingTables}
            groupBySchema={dialect !== 'sqlite'}
            onOpen={openTable}
            onReload={state.reloadTables}
          />
        ) : null}

        <main className="dbb-main">
          <PaneTransition paneKey={paneKey} className="dbb-pane">
            {pane === 'sql' ? (
              <SqlConsole
                dataSource={dataSource}
                tables={state.tables}
                schemas={state.schemas}
                defaultLimit={defaultLimit}
                maxLimit={maxLimit}
              />
            ) : showSpecial && mode === 'vector' && profile?.vector ? (
              <VectorBrowser
                profile={profile.vector}
                service={vectorService}
                onShowTables={() => setPane('tables')}
                onRefreshProfile={refreshProfile}
                onOpenChunk={() => openTable({ schema: primarySchema, name: 'chunk' })}
              />
            ) : showSpecial && mode === 'code-graph' && profile?.graph ? (
              <CodeGraphBrowser
                profile={profile.graph}
                service={vectorService}
                schema={primarySchema}
                onShowTables={() => setPane('tables')}
                onOpenTable={openTable}
                onRefreshProfile={refreshProfile}
              />
            ) : (
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
                <DataGrid state={state} onInspectBinary={(row, column) => setBinary({ row, column })} />
              </>
            )}
          </PaneTransition>
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

      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <ShortcutOverlay open={cheatsheet} onClose={() => setCheatsheet(false)} />
      {connectionsApi ? (
        <ConnectionManager
          open={manager}
          onClose={() => setManager(false)}
          api={connectionsApi}
          onChanged={onConnectionsChanged}
          activeConnectionId={activeSourceId ?? null}
          onOpenConnection={
            onSelectSource
              ? (c) => {
                  setManager(false)
                  onSelectSource(c.id)
                }
              : undefined
          }
        />
      ) : null}

      {toast ? (
        <div className="dbb-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
    </RootElementProvider>
  )
}
