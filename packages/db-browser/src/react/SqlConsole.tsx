/**
 * The SQL console: editor, guard badge, results, history and saved queries.
 *
 * The guard runs **in the browser too** — not as a security boundary (it is
 * not one; the server re-checks everything) but so the classification of what
 * you are about to run is visible *before* you run it, and so an obviously
 * blocked statement does not cost a round trip.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { analyzeSql } from '../sql/guard.js'
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
  const [sql, setSql] = useState('SELECT * FROM public.feature LIMIT 20')
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
  const writable = dataSource.capabilities().writes

  useEffect(() => {
    setHistory(loadHistory(connectionId))
    setSaved(loadSavedQueries(connectionId))
  }, [connectionId])

  const analysis = useMemo(() => analyzeSql(sql), [sql])
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

  return (
    <div className="dbb-console">
      <div className="dbb-console-bar">
        <button type="button" className="dbb-primary" onClick={run} disabled={running || !!blocked}>
          {running ? 'Running…' : 'Run ⌘/Ctrl+↵'}
        </button>
        <button type="button" onClick={() => setSql(formatQuery(sql))}>
          Format
        </button>
        <label className="dbb-field">
          Rows
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

        <span className={`dbb-badge ${KIND_CLASS[analysis.kind] ?? ''}`} title="Statement classification">
          {analysis.statements.length > 1
            ? `${analysis.statements.length} statements`
            : (analysis.statements[0]?.command || 'empty')}
          {' · '}
          {analysis.kind}
        </span>

        {writable ? (
          <label className="dbb-field dbb-danger-toggle" title="Writes are off by default">
            <input
              type="checkbox"
              checked={allowWrite}
              onChange={(e) => setAllowWrite(e.target.checked)}
            />
            allow writes
          </label>
        ) : (
          <span className="dbb-badge dbb-badge-muted" title="The server opened this connection read-only">
            connection is read-only
          </span>
        )}

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
          <button type="button" onClick={() => setSaving(true)} disabled={!sql.trim()}>
            Save
          </button>
        )}
      </div>

      {blocked ? (
        <div className="dbb-banner dbb-banner-warn">
          <strong>Blocked:</strong> {blocked}.{' '}
          {analysis.multiple
            ? 'Semicolon-chained statements are the classic way a read-only console becomes a DROP.'
            : null}
        </div>
      ) : null}

      <div className="dbb-console-editor">
        <SqlEditor value={sql} onChange={setSql} onRun={run} tables={tables} schemas={schemas} />
      </div>

      {error ? (
        <div className="dbb-banner dbb-banner-error" role="alert">
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
            History
          </button>
          <button
            type="button"
            className={tab === 'saved' ? 'dbb-tab dbb-tab-active' : 'dbb-tab'}
            onClick={() => setTab('saved')}
          >
            Saved
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
