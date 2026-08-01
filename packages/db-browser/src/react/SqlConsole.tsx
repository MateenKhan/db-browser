/**
 * The SQL console: editor, guard badge, results, history and saved queries.
 *
 * The guard runs **in the browser too** — not as a security boundary (it is
 * not one; the server re-checks everything) but so the classification of what
 * you are about to run is visible *before* you run it, and so an obviously
 * blocked statement does not cost a round trip.
 *
 * ## What the toolbar dropped
 *
 * It used to carry a `SQLite` badge and a `connection is read-only` badge. The
 * application header states both, permanently, for every pane — repeating them
 * here made a seven-control toolbar out of a five-control one, and put the two
 * least changeable facts on screen beside the most changeable. What stays is
 * the statement **classification** (`SELECT · read`), which is the one badge
 * here that changes as you type and is the whole reason the guard also runs
 * client-side.
 *
 * The `Run` button no longer spells its shortcut into its own label either. The
 * binding is in its tooltip and in the `?` cheat sheet, which is where every
 * other binding in this application lives.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Glyph } from './iconography.js'
import { Appear } from './motion.js'
import { hint, useShortcuts } from './shortcuts.js'
import { analyzeSql } from '../sql/guard.js'
import { asDialect } from '../sql/dialect.js'
import { formatQuery } from '../sql/format.js'
import { toDisplay } from '../render/values.js'
import { downloadText, toCsv, toJson } from './exportRows.js'
import { LazySpreadsheetTable } from './lazyTable.js'
import { SqlEditor } from './SqlEditor.js'
import {
  clearHistory,
  deleteSavedQuery,
  loadHistory,
  loadSavedQueries,
  pushHistory,
  saveQuery,
} from './localState.js'
import type { HistoryEntry, SavedQuery } from './localState.js'
import type { DataSource, QueryResult, Row, TableMeta, TableSchema } from '../types.js'

export interface SqlConsoleProps {
  dataSource: DataSource
  tables: readonly TableMeta[]
  schemas: ReadonlyMap<string, TableSchema>
  defaultLimit?: number
  maxLimit?: number
}

const KIND_CLASS: Record<string, string> = {
  read: 'dbb-badge-read',
  write: 'dbb-badge-write',
  ddl: 'dbb-badge-ddl',
  transaction: 'dbb-badge-warn',
  other: 'dbb-badge-warn',
  empty: 'dbb-badge-muted',
}

export function SqlConsole({
  dataSource,
  tables,
  schemas,
  defaultLimit = 100,
  maxLimit = 1000,
}: SqlConsoleProps) {
  const caps = dataSource.capabilities()
  const dialect = asDialect(caps.dialect)

  // The starter statement has to name a table that plausibly exists on the
  // engine you are connected to. `public.feature` is a Postgres-shaped guess;
  // on SQLite it is a syntax-valid statement that can only ever error.
  const [sql, setSql] = useState(() =>
    dialect === 'sqlite'
      ? "SELECT type, name FROM sqlite_master WHERE type = 'table' LIMIT 20"
      : 'SELECT * FROM public.feature LIMIT 20',
  )
  const [limit, setLimit] = useState(defaultLimit)
  const [allowWrite, setAllowWrite] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [tab, setTab] = useState<'history' | 'saved'>('history')
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState('')

  const connectionId = dataSource.id
  const writable = caps.writes

  useEffect(() => {
    setHistory(loadHistory(connectionId))
    setSaved(loadSavedQueries(connectionId))
  }, [connectionId])

  // Analysed with the connected engine's denylist, so the badge and the
  // "blocked" banner agree with what the server will actually decide.
  const analysis = useMemo(() => analyzeSql(sql, dialect), [sql, dialect])
  const blocked = useMemo(() => {
    if (!analysis.statements.length) return 'Nothing to run'
    if (analysis.multiple) return 'Multiple statements are blocked'
    if (!analysis.readOnly && !(writable && allowWrite)) {
      return analysis.smuggledKeyword
        ? `Contains ${analysis.smuggledKeyword} — blocked in read-only mode`
        : 'Writes are blocked in read-only mode'
    }
    return null
  }, [analysis, writable, allowWrite])

  const run = useCallback(async () => {
    if (running) return
    setRunning(true)
    setError(null)
    try {
      const res = await dataSource.runQuery(sql, { limit, allowWrite: allowWrite && writable })
      setResult(res)
      setHistory(
        pushHistory(connectionId, {
          sql,
          ok: true,
          rowCount: res.rowCount,
          durationMs: res.durationMs,
        }),
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      setResult(null)
      setHistory(pushHistory(connectionId, { sql, ok: false, error: msg }))
    } finally {
      setRunning(false)
    }
  }, [dataSource, sql, limit, allowWrite, writable, connectionId, running])

  const commitSave = useCallback(() => {
    setSaved(saveQuery(connectionId, saveName, sql))
    setSaveName('')
    setSaving(false)
    setTab('saved')
  }, [connectionId, saveName, sql])

  const columns = useMemo(
    () =>
      (result?.columns ?? []).map((c, i) => ({
        accessorKey: c.name,
        id: `${c.name}-${i}`,
        header: c.name,
        meta: { type: 'text' as const },
      })),
    [result],
  )

  const displayRows = useMemo(
    () =>
      (result?.rows ?? []).map((row) => {
        const out: Row = {}
        for (const c of result?.columns ?? []) out[c.name] = toDisplay(row[c.name], c.category)
        return out
      }),
    [result],
  )

  const columnNames = useMemo(() => (result?.columns ?? []).map((c) => c.name), [result])

  // `allowInEditor` on exactly two of these: they are *editor* commands, and
  // their whole purpose is to fire while the SQL editor has focus. Neither can
  // be produced by ordinary typing. Everything else stays suppressed while a
  // field is focused — see `shortcuts.tsx`.
  useShortcuts([
    {
      id: 'sql-run',
      keys: 'mod+enter',
      label: 'Run query',
      group: 'Query',
      allowInEditor: true,
      enabled: !blocked && !running,
      run: () => void run(),
    },
    {
      id: 'sql-format',
      keys: 'shift+alt+f',
      label: 'Format query',
      group: 'Query',
      allowInEditor: true,
      run: () => setSql(formatQuery(sql, { dialect })),
    },
    {
      id: 'sql-save',
      keys: 'mod+s',
      label: 'Save query',
      group: 'Query',
      enabled: !!sql.trim(),
      run: () => setSaving(true),
    },
    {
      id: 'sql-writes',
      // **Not** `mod+shift+w`, which closes the browser window. Binding a
      // destructive-adjacent toggle to a chord that shuts the tool down is the
      // kind of thing that only gets found in a bug report.
      keys: 'alt+w',
      label: 'Toggle “allow writes”',
      group: 'Query',
      enabled: writable,
      run: () => setAllowWrite((v) => !v),
    },
  ])

  return (
    <div className="dbb-console">
      <div className="dbb-console-bar">
        <div className="dbb-group">
          <button
            type="button"
            className="dbb-primary"
            onClick={run}
            disabled={running || !!blocked}
            title={blocked ?? hint('Run this statement', 'mod+enter')}
          >
            <Glyph name={running ? 'busy' : 'run'} size="sm" spin={running} tone="run" />
            {running ? 'Running…' : 'Run'}
          </button>
          <span className="dbb-group-sep" />
          <button
            type="button"
            onClick={() => setSql(formatQuery(sql, { dialect }))}
            title={hint('Format', 'shift+alt+f')}
          >
            <Glyph name="format" size="sm" />
            Format
          </button>
          <span className="dbb-group-sep" />
          <label className="dbb-field" title="Every query is capped. Raise this deliberately.">
            <Glyph name="rows" size="sm" />
            <span className="dbb-sr-only">Row limit</span>
            <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[25, 50, 100, 250, 500, 1000]
                .filter((n) => n <= maxLimit)
                .map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
            </select>
          </label>
        </div>

        <span
          className={`dbb-badge ${KIND_CLASS[analysis.kind] ?? ''}`}
          title="How the guard classifies what is in the editor right now. The server reaches the same verdict independently."
        >
          {analysis.statements.length > 1
            ? `${analysis.statements.length} statements`
            : (analysis.statements[0]?.command || 'empty')}
          {' · '}
          {analysis.kind}
        </span>

        {writable ? (
          <label
            className="dbb-field dbb-danger-toggle"
            title={hint('Writes are off by default — this arms them', 'alt+w')}
          >
            <input
              type="checkbox"
              checked={allowWrite}
              onChange={(e) => setAllowWrite(e.target.checked)}
            />
            <Glyph name={allowWrite ? 'writable' : 'readOnly'} size="sm" />
            allow writes
          </label>
        ) : null}

        <span className="dbb-spacer" />
        {/* An inline field rather than `window.prompt`: a modal dialog blocks
            the whole page and is unavailable in a sandboxed iframe. */}
        {saving ? (
          <span className="dbb-save-inline">
            <input
              autoFocus
              value={saveName}
              placeholder="Name this query"
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSave()
                if (e.key === 'Escape') setSaving(false)
              }}
            />
            <button type="button" className="dbb-primary" onClick={commitSave}>
              Save
            </button>
            <button type="button" onClick={() => setSaving(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setSaving(true)}
            disabled={!sql.trim()}
            title={hint('Save this query', 'mod+s')}
          >
            <Glyph name="save" size="sm" />
            Save
          </button>
        )}
      </div>

      {blocked ? (
        <Appear className="dbb-banner dbb-banner-warn">
          <Glyph name="danger" size="sm" />
          <span>
            <strong>Blocked:</strong> {blocked}.{' '}
            {analysis.multiple
              ? 'Semicolon-chained statements are the classic way a read-only console becomes a DROP.'
              : null}
          </span>
        </Appear>
      ) : null}

      <div className="dbb-console-editor">
        <SqlEditor
          value={sql}
          onChange={setSql}
          onRun={run}
          tables={tables}
          schemas={schemas}
          dialect={dialect}
        />
      </div>

      {error ? (
        <div className="dbb-banner dbb-banner-error" role="alert">
          <Glyph name="failure" size="sm" />
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="dbb-result">
          <div className="dbb-result-head">
            <span>
              {result.rowCount} row{result.rowCount === 1 ? '' : 's'} · {result.durationMs} ms
              {result.command ? ` · ${result.command}` : ''}
            </span>
            {result.truncated ? (
              <span className="dbb-badge dbb-badge-warn">
                truncated at {result.limit} — raise the row limit to see more
              </span>
            ) : null}
            <span className="dbb-spacer" />
            <button
              type="button"
              onClick={() => downloadText('result.csv', toCsv(result.rows, columnNames), 'text/csv')}
            >
              CSV
            </button>
            <button
              type="button"
              onClick={() =>
                downloadText('result.json', toJson(result.rows, columnNames), 'application/json')
              }
            >
              JSON
            </button>
          </div>
          <div className="dbb-grid">
            <Suspense fallback={<div className="dbb-empty">Loading grid…</div>}>
              <LazySpreadsheetTable
                key={`result:${history[0]?.id ?? 'none'}`}
                columns={columns}
                data={displayRows}
              />
            </Suspense>
          </div>
        </div>
      ) : null}

      <div className="dbb-side">
        <div className="dbb-tabs">
          <button
            type="button"
            className={tab === 'history' ? 'dbb-tab dbb-tab-active' : 'dbb-tab'}
            onClick={() => setTab('history')}
          >
            <Glyph name="history" size="sm" />
            History
            {history.length ? <span className="dbb-seg-count">{history.length}</span> : null}
          </button>
          <button
            type="button"
            className={tab === 'saved' ? 'dbb-tab dbb-tab-active' : 'dbb-tab'}
            onClick={() => setTab('saved')}
          >
            <Glyph name="save" size="sm" />
            Saved
            {saved.length ? <span className="dbb-seg-count">{saved.length}</span> : null}
          </button>
          <span className="dbb-spacer" />
          {tab === 'history' ? (
            <button type="button" className="dbb-link" onClick={() => setHistory(clearHistory(connectionId))}>
              clear
            </button>
          ) : null}
        </div>
        <ul className="dbb-list">
          {tab === 'history'
            ? history.map((h) => (
                <li key={h.id}>
                  <button type="button" className="dbb-list-item" onClick={() => setSql(h.sql)}>
                    <code>{h.sql.slice(0, 120)}</code>
                    <span className={h.ok ? 'dbb-muted' : 'dbb-error-text'}>
                      {h.ok ? `${h.rowCount} rows · ${h.durationMs} ms` : h.error}
                    </span>
                  </button>
                </li>
              ))
            : saved.map((q) => (
                <li key={q.id}>
                  <button type="button" className="dbb-list-item" onClick={() => setSql(q.sql)}>
                    <strong>{q.name}</strong>
                    <code>{q.sql.slice(0, 120)}</code>
                  </button>
                  <button
                    type="button"
                    className="dbb-link"
                    onClick={() => setSaved(deleteSavedQuery(connectionId, q.id))}
                  >
                    delete
                  </button>
                </li>
              ))}
        </ul>
      </div>
    </div>
  )
}
