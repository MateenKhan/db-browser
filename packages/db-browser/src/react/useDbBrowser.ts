/**
 * The whole browsing state machine: table list, one page of rows, sorting,
 * filtering, staged edits and commit.
 *
 * Three decisions worth knowing about:
 *
 *  1. **Rows are never durable state.** They live in React state keyed by
 *     table + page and are re-fetched on every navigation. Nothing writes them
 *     to storage, and the grid is re-mounted (`gridKey`) whenever the shape of
 *     what it shows changes, so a stale sheet cannot survive.
 *  2. **Edits are matched by primary key, not by row index.** The grid may sort
 *     internally, so an index means nothing by the time a change comes back.
 *     `applyGridRows` diffs the grid's rows against the fetched snapshot using
 *     the PK, which is also what makes "this table has no PK" a hard stop
 *     rather than a guess.
 *  3. **Nothing is written until `commit()`.** `onDataChange` only stages.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  changeCount,
  emptyChangeSet,
  stageCell,
  toMutations,
  unstage,
} from '../pending/changeset.js'
import type { ChangeSet } from '../pending/changeset.js'
import { fromDisplay, toDisplay } from '../render/values.js'
import { rowKeyOf } from '../schema.js'
import type {
  Cursor,
  DataSource,
  Filter,
  Page,
  PkValues,
  Row,
  SortSpec,
  TableMeta,
  TableRef,
  TableSchema,
} from '../types.js'

export interface UseDbBrowserOptions {
  defaultLimit?: number
  maxLimit?: number
}

export interface CommitOutcome {
  applied: number
  failed: number
  errors: string[]
}

export interface DbBrowserState {
  connectionId: string
  writable: boolean

  tables: TableMeta[]
  tablesLoading: boolean
  tablesError: string | null
  reloadTables: () => void

  active: TableRef | null
  openTable: (table: TableRef) => void
  schema: TableSchema | null
  /** Every schema fetched so far — feeds SQL completion. */
  schemas: Map<string, TableSchema>

  page: Page | null
  displayRows: Row[]
  loading: boolean
  error: string | null
  refresh: () => void

  limit: number
  setLimit: (limit: number) => void
  maxLimit: number

  sort: SortSpec[]
  toggleSort: (column: string) => void
  filters: Filter[]
  setFilters: (filters: Filter[]) => void

  pageIndex: number
  canNext: boolean
  canPrev: boolean
  next: () => void
  prev: () => void

  pending: ChangeSet
  pendingCount: number
  applyGridRows: (rows: Row[]) => void
  dropPending: (rowKey: string, column?: string) => void
  discard: () => void
  commit: () => Promise<CommitOutcome>
  committing: boolean
  /** Why the last edit was refused (read-only table, PK edit, bad value). */
  rejection: string | null
  clearRejection: () => void
  /** Bumped to force the grid to remount and re-read the true values. */
  gridKey: number
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Request failed'

export function useDbBrowser(
  dataSource: DataSource,
  options: UseDbBrowserOptions = {},
): DbBrowserState {
  const maxLimit = options.maxLimit ?? 1000
  const [tables, setTables] = useState<TableMeta[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [tablesNonce, setTablesNonce] = useState(0)

  const [active, setActive] = useState<TableRef | null>(null)
  const [schema, setSchema] = useState<TableSchema | null>(null)
  const [schemas, setSchemas] = useState<Map<string, TableSchema>>(new Map())

  const [page, setPage] = useState<Page | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const [limit, setLimitState] = useState(options.defaultLimit ?? 100)
  const [sort, setSort] = useState<SortSpec[]>([])
  const [filters, setFiltersState] = useState<Filter[]>([])

  /** Cursor stack: one entry per page already visited (keyset back-navigation). */
  const [cursors, setCursors] = useState<Array<Cursor | null>>([null])
  const [pageIndex, setPageIndex] = useState(0)

  const [pending, setPending] = useState<ChangeSet>(emptyChangeSet())
  const [committing, setCommitting] = useState(false)
  const [rejection, setRejection] = useState<string | null>(null)
  const [gridKey, setGridKey] = useState(0)

  const writable = dataSource.capabilities().writes

  // -- table list ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    setTablesLoading(true)
    setTablesError(null)
    dataSource
      .listTables()
      .then((list) => {
        if (!cancelled) setTables(list)
      })
      .catch((e) => {
        if (!cancelled) setTablesError(message(e))
      })
      .finally(() => {
        if (!cancelled) setTablesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [dataSource, tablesNonce])

  // -- schema --------------------------------------------------------------
  useEffect(() => {
    if (!active) {
      setSchema(null)
      return
    }
    let cancelled = false
    setError(null)
    dataSource
      .describeTable(active)
      .then((s) => {
        if (cancelled) return
        setSchema(s)
        setSchemas((prev) => {
          const next = new Map(prev)
          next.set(`${s.table.schema}.${s.table.name}`, s)
          return next
        })
      })
      .catch((e) => {
        if (!cancelled) setError(message(e))
      })
    return () => {
      cancelled = true
    }
  }, [dataSource, active])

  // -- rows ----------------------------------------------------------------
  useEffect(() => {
    if (!active || !schema) {
      setPage(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    dataSource
      .select({
        table: active,
        limit,
        sort,
        filters,
        cursor: cursors[pageIndex] ?? null,
        offset: pageIndex * limit,
      })
      .then((p) => {
        if (cancelled) return
        setPage(p)
        // A fresh page invalidates any staged edit that referred to the old one.
        setPending(emptyChangeSet())
        setGridKey((k) => k + 1)
      })
      .catch((e) => {
        if (!cancelled) {
          setError(message(e))
          setPage(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `schema` is included so rows are fetched only once the columns are known.
  }, [dataSource, active, schema, limit, sort, filters, pageIndex, cursors, nonce])

  // -- derived -------------------------------------------------------------
  /** The grid edits strings; this is the snapshot it is given. */
  const displayRows = useMemo(() => {
    if (!page) return []
    return page.rows.map((row) => {
      const out: Row = {}
      for (const column of page.columns) out[column.name] = toDisplay(row[column.name], column.category)
      return out
    })
  }, [page])

  const displayByKey = useMemo(() => {
    const map = new Map<string, { display: Row; raw: Row }>()
    if (!page || !schema?.primaryKey.length) return map
    page.rows.forEach((raw, i) => {
      const key = rowKeyOf(raw, schema.primaryKey)
      if (key) map.set(key, { display: displayRows[i], raw })
    })
    return map
  }, [page, schema, displayRows])

  const openTable = useCallback((table: TableRef) => {
    setActive(table)
    setPage(null)
    setSort([])
    setFiltersState([])
    setCursors([null])
    setPageIndex(0)
    setPending(emptyChangeSet())
    setRejection(null)
    setGridKey((k) => k + 1)
  }, [])

  const setLimit = useCallback((next: number) => {
    setLimitState(Math.max(1, Math.min(maxLimit, Math.floor(next) || 1)))
    setCursors([null])
    setPageIndex(0)
  }, [maxLimit])

  const setFilters = useCallback((next: Filter[]) => {
    setFiltersState(next)
    setCursors([null])
    setPageIndex(0)
  }, [])

  const toggleSort = useCallback((column: string) => {
    setSort((prev) => {
      const current = prev.find((s) => s.column === column)
      if (!current) return [{ column, direction: 'asc' }]
      if (current.direction === 'asc') return [{ column, direction: 'desc' }]
      return []
    })
    setCursors([null])
    setPageIndex(0)
  }, [])

  const next = useCallback(() => {
    if (!page?.hasMore) return
    setCursors((prev) => {
      const copy = prev.slice(0, pageIndex + 1)
      copy.push(page.nextCursor ?? null)
      return copy
    })
    setPageIndex((i) => i + 1)
  }, [page, pageIndex])

  const prev = useCallback(() => {
    setPageIndex((i) => Math.max(0, i - 1))
  }, [])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // -- staging -------------------------------------------------------------
  const reject = useCallback((why: string) => {
    setRejection(why)
    // Snap the grid back to the truth so the screen never shows an edit that
    // is not going to happen.
    setGridKey((k) => k + 1)
  }, [])

  const pendingRef = useRef(pending)
  pendingRef.current = pending

  const applyGridRows = useCallback(
    (rows: Row[]) => {
      if (!schema || !page) return
      if (!writable) {
        reject('This connection is read-only. Enable writes on the server to edit rows.')
        return
      }
      if (!schema.updatable) {
        reject(schema.notUpdatableReason ?? 'This table cannot be edited.')
        return
      }
      // An empty result set has nothing to diff against. The embedded grid
      // offers its own "add row" affordance on an empty sheet and emits a
      // change for it on mount; that is not a user edit.
      if (!displayRows.length) return
      if (rows.length !== displayRows.length) {
        reject(
          'Adding or removing rows in the grid is not supported. Use the SQL console for INSERT/DELETE.',
        )
        return
      }
      const pkSet = new Set(schema.primaryKey)
      let cs = pendingRef.current
      let changed = false
      for (const gridRow of rows) {
        const key = rowKeyOf(gridRow, schema.primaryKey)
        const original = key ? displayByKey.get(key) : undefined
        if (!original) {
          reject('Primary-key columns cannot be edited here — that would move the row, not change it.')
          return
        }
        for (const column of page.columns) {
          if (pkSet.has(column.name)) continue
          const before = original.display[column.name]
          const after = gridRow[column.name]
          if (String(after ?? '') === String(before ?? '')) continue
          if (column.isBinary) {
            reject(`"${column.name}" is a binary column and cannot be edited as text.`)
            return
          }
          if (column.readOnly) {
            reject(`"${column.name}" is a generated column and cannot be written.`)
            return
          }
          const coerced = fromDisplay(String(after ?? ''), column)
          if (!coerced.ok) {
            reject(coerced.error)
            return
          }
          const pk: PkValues = {}
          for (const name of schema.primaryKey) pk[name] = original.raw[name]
          cs = stageCell(cs, {
            rowKey: key as string,
            pk,
            column: column.name,
            before: original.raw[column.name],
            after: coerced.value,
          })
          changed = true
        }
      }
      if (changed) {
        setPending(cs)
        setRejection(null)
      }
    },
    [schema, page, displayRows, displayByKey, writable, reject],
  )

  const dropPending = useCallback((rowKey: string, column?: string) => {
    setPending((cs) => unstage(cs, rowKey, column))
    setGridKey((k) => k + 1)
  }, [])

  const discard = useCallback(() => {
    setPending(emptyChangeSet())
    setRejection(null)
    setGridKey((k) => k + 1)
  }, [])

  const commit = useCallback(async (): Promise<CommitOutcome> => {
    if (!active || !schema) return { applied: 0, failed: 0, errors: [] }
    const mutations = toMutations(pendingRef.current)
    if (!mutations.length) return { applied: 0, failed: 0, errors: [] }
    setCommitting(true)
    const errors: string[] = []
    let applied = 0
    try {
      for (const m of mutations) {
        try {
          if (m.kind === 'update') await dataSource.update(active, m.pk, m.patch)
          else if (m.kind === 'insert') await dataSource.insert(active, m.values)
          else await dataSource.delete(active, m.pk)
          applied++
        } catch (e) {
          errors.push(message(e))
        }
      }
    } finally {
      setCommitting(false)
    }
    setPending(emptyChangeSet())
    refresh()
    return { applied, failed: errors.length, errors }
  }, [dataSource, active, schema, refresh])

  return {
    connectionId: dataSource.id,
    writable,
    tables,
    tablesLoading,
    tablesError,
    reloadTables: () => setTablesNonce((n) => n + 1),
    active,
    openTable,
    schema,
    schemas,
    page,
    displayRows,
    loading,
    error,
    refresh,
    limit,
    setLimit,
    maxLimit,
    sort,
    toggleSort,
    filters,
    setFilters,
    pageIndex,
    canNext: !!page?.hasMore,
    canPrev: pageIndex > 0,
    next,
    prev,
    pending,
    pendingCount: changeCount(pending),
    applyGridRows,
    dropPending,
    discard,
    commit,
    committing,
    rejection,
    clearRejection: () => setRejection(null),
    gridKey,
  }
}
