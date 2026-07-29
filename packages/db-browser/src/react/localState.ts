/**
 * Query history and saved queries.
 *
 * These are the *user's* work, not server data, so persisting them is right —
 * but they are still namespaced per connection, under keys this package owns
 * (`dbb:<connection>:…`). Result rows are never written here; see
 * `storage/tableStorage.ts` for why that matters.
 */

export interface SavedQuery {
  id: string
  name: string
  sql: string
  createdAt: number
}

export interface HistoryEntry {
  id: string
  sql: string
  at: number
  ok: boolean
  rowCount?: number
  durationMs?: number
  error?: string
}

const MAX_HISTORY = 100

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function read<T>(key: string, fallback: T): T {
  const s = storage()
  if (!s) return fallback
  try {
    const raw = s.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(key, JSON.stringify(value))
  } catch {
    /* quota exceeded — history is disposable, so drop it silently */
  }
}

const historyKey = (connectionId: string) => `dbb:${connectionId}:history`
const savedKey = (connectionId: string) => `dbb:${connectionId}:saved`

export function loadHistory(connectionId: string): HistoryEntry[] {
  return read<HistoryEntry[]>(historyKey(connectionId), [])
}

export function pushHistory(connectionId: string, entry: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry[] {
  const next: HistoryEntry[] = [
    { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() },
    ...loadHistory(connectionId),
  ].slice(0, MAX_HISTORY)
  write(historyKey(connectionId), next)
  return next
}

export function clearHistory(connectionId: string): HistoryEntry[] {
  write(historyKey(connectionId), [])
  return []
}

export function loadSavedQueries(connectionId: string): SavedQuery[] {
  return read<SavedQuery[]>(savedKey(connectionId), [])
}

export function saveQuery(connectionId: string, name: string, sql: string): SavedQuery[] {
  const next = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim() || sql.slice(0, 40),
      sql,
      createdAt: Date.now(),
    },
    ...loadSavedQueries(connectionId),
  ]
  write(savedKey(connectionId), next)
  return next
}

export function deleteSavedQuery(connectionId: string, id: string): SavedQuery[] {
  const next = loadSavedQueries(connectionId).filter((q) => q.id !== id)
  write(savedKey(connectionId), next)
  return next
}
