/**
 * The HTTP client for semantic search and index rebuilds.
 *
 * Kept apart from `DataSource` on purpose. The SQL connection and the *indexer*
 * are different processes with different lifetimes: the embedding store can be
 * perfectly browsable while the service that could rebuild it is not running.
 * Folding search into `DataSource` would mean one unreachable service takes the
 * whole page down; as a separate, optional dependency the UI can show the
 * stats, the tables and the rows, and put "the index service is unavailable" on
 * the one control that actually needs it.
 *
 * Every response is normalised here rather than trusted, because the server
 * that answers these routes is a *different* codebase (Piranha's db-server)
 * evolving on its own schedule. Field names are accepted in both `snake_case`
 * (the wire format the indexer emits) and `camelCase`.
 */

import { DbBrowserError } from '../types.js'
import type {
  RebuildJob,
  RebuildPhase,
  VectorSearchFilters,
  VectorSearchHit,
  VectorSearchResult,
  VectorService,
} from '../types.js'

/**
 * How many extra hits to ask for when a filter is active and the server may
 * not honour it.
 *
 * The measured problem this exists for: on a conceptual query against a real
 * index, the top 10 were **all** `doc` chunks. Filtering that page to
 * `function` yields zero results, and the user reasonably concludes the code is
 * not indexed. Over-fetching 5× makes the common case work — 50 hits will
 * contain code even when the top 10 do not — while staying one request and a
 * bounded payload. It is a mitigation, not a fix: a server that filters
 * *before* ranking is strictly better, which is why `search` reports which
 * happened.
 */
export const FILTER_OVERFETCH = 5

/** Ceiling on the over-fetch, so a large `limit` cannot ask for thousands. */
export const MAX_OVERFETCH_LIMIT = 200

/**
 * The routes, relative to a configurable base. Two families because the code
 * graph is rebuilt by a different pipeline than the embeddings are, and a
 * "rebuild" button that hits the wrong one is worse than no button.
 */
export const VECTOR_SERVICE_ROUTES = {
  embeddings: {
    search: '/embeddings/search',
    rebuild: '/embeddings/rebuild',
    /** `${rebuild}/${jobId}` */
    status: '/embeddings/rebuild',
  },
  codeGraph: {
    search: '/code-graph/search',
    rebuild: '/code-graph/rebuild',
    status: '/code-graph/rebuild',
  },
} as const

export type VectorServiceKind = keyof typeof VECTOR_SERVICE_ROUTES

export interface HttpVectorServiceOptions {
  /** Base URL of the indexer, or of a proxy in front of it. */
  baseUrl: string
  /** Which route family to use. Default `embeddings`. */
  kind?: VectorServiceKind
  /** Stable id used to namespace the in-flight-job record. Defaults to `baseUrl`. */
  id?: string
  headers?: () => Record<string, string> | Promise<Record<string, string>>
  fetchImpl?: typeof fetch
}

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length ? v : v == null ? null : String(v)

const PHASES: readonly RebuildPhase[] = ['queued', 'scan', 'chunk', 'embed', 'write', 'done', 'failed']

function asPhase(v: unknown): RebuildPhase {
  const s = String(v ?? '').toLowerCase()
  return (PHASES as readonly string[]).includes(s) ? (s as RebuildPhase) : 'queued'
}

/** Accept either spelling for a field the indexer might send in either style. */
function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (row[n] !== undefined && row[n] !== null) return row[n]
  return undefined
}

export function normalizeHit(raw: unknown): VectorSearchHit {
  const row = (raw ?? {}) as Record<string, unknown>
  return {
    path: String(pick(row, 'path', 'file', 'file_path', 'filePath') ?? ''),
    startLine: num(pick(row, 'start_line', 'startLine'), 0),
    endLine: num(pick(row, 'end_line', 'endLine'), 0),
    symbol: str(pick(row, 'symbol', 'name')),
    kind: str(pick(row, 'kind')),
    // A score is never defaulted to something plausible: 0 is "no similarity",
    // which is the honest reading of a server that did not send one.
    score: num(pick(row, 'score', 'similarity', 'distance'), 0),
    snippet: str(pick(row, 'snippet', 'content', 'text')),
    chunkId: (pick(row, 'chunk_id', 'chunkId', 'id') as string | number | undefined) ?? null,
  }
}

/**
 * Percent is recomputed from `processed`/`total` when the server omits it, and
 * clamped when it sends one — a progress bar that reads 143% is a bug report
 * the user has to file on our behalf.
 */
export function normalizeJob(raw: unknown, fallbackId = ''): RebuildJob {
  const row = (raw ?? {}) as Record<string, unknown>
  const processed = num(pick(row, 'processed', 'done'), 0)
  const total = num(pick(row, 'total', 'count'), 0)
  const phase = asPhase(pick(row, 'phase', 'state'))
  const rawPercent = pick(row, 'percent', 'progress')
  const percent =
    rawPercent === undefined
      ? total > 0
        ? (processed / total) * 100
        : phase === 'done'
          ? 100
          : 0
      : num(rawPercent, 0)

  const explicitStatus = String(pick(row, 'status') ?? '').toLowerCase()
  const status: RebuildJob['status'] =
    explicitStatus === 'succeeded' || explicitStatus === 'failed' || explicitStatus === 'running'
      ? (explicitStatus as RebuildJob['status'])
      : phase === 'done'
        ? 'succeeded'
        : phase === 'failed'
          ? 'failed'
          : 'running'

  return {
    id: String(pick(row, 'id', 'job_id', 'jobId') ?? fallbackId),
    phase,
    processed,
    total,
    percent: Math.max(0, Math.min(100, percent)),
    message: str(pick(row, 'message', 'detail')),
    status,
    error: status === 'failed' ? (str(pick(row, 'error', 'message')) ?? 'The build failed') : null,
    startedAt: str(pick(row, 'started_at', 'startedAt')),
    finishedAt: str(pick(row, 'finished_at', 'finishedAt')),
  }
}

/**
 * Apply the filters to a hit list. Exported and pure so the rule is testable
 * without a server, and so a custom `VectorService` can reuse it.
 *
 * Kind matching is case-insensitive because `kind` is free text written by the
 * indexer; path matching is a plain prefix on a forward-slash path, with
 * backslashes normalised so a Windows-flavoured prefix still matches.
 */
export function applySearchFilters(
  hits: readonly VectorSearchHit[],
  filters: VectorSearchFilters | undefined,
): VectorSearchHit[] {
  if (!filters) return [...hits]
  const kinds = filters.kinds?.length
    ? new Set(filters.kinds.map((k) => k.toLowerCase()))
    : null
  const prefix = filters.pathPrefix?.trim().replace(/\\/g, '/').replace(/^\/+/, '') || null
  if (!kinds && !prefix) return [...hits]
  return hits.filter((h) => {
    if (kinds && !kinds.has(String(h.kind ?? '').toLowerCase())) return false
    if (prefix && !h.path.replace(/\\/g, '/').startsWith(prefix)) return false
    return true
  })
}

const hasFilters = (f: VectorSearchFilters | undefined): boolean =>
  !!(f && ((f.kinds && f.kinds.length) || (f.pathPrefix && f.pathPrefix.trim())))

export function createHttpVectorService(options: HttpVectorServiceOptions): VectorService {
  const base = options.baseUrl.replace(/\/+$/, '')
  const routes = VECTOR_SERVICE_ROUTES[options.kind ?? 'embeddings']
  const doFetch = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (!doFetch) throw new DbBrowserError('NO_FETCH', 'No fetch implementation available')

  async function call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    const extra = options.headers ? await options.headers() : {}
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method,
        headers:
          init.method === 'POST'
            ? { 'content-type': 'application/json', ...extra }
            : { ...extra },
        body: init.method === 'POST' ? JSON.stringify(init.body ?? {}) : undefined,
        signal: init.signal,
      })
    } catch (e) {
      // A refused connection is the normal case when the indexer is not
      // running. It gets its own code so the UI can say so precisely instead
      // of showing a browser-specific network string.
      if ((e as Error)?.name === 'AbortError') throw e
      throw new DbBrowserError(
        'SERVICE_UNAVAILABLE',
        'The index service is not reachable. Start it, or set its base URL.',
        (e as Error)?.message,
      )
    }
    const text = await res.text()
    let parsed: unknown = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new DbBrowserError(
          'BAD_RESPONSE',
          `The index service returned non-JSON (${res.status})`,
        )
      }
    }
    if (!res.ok) {
      const body = parsed as { error?: { code?: string; message?: string }; message?: string } | null
      // Surface the server's own message: "no repo configured" is actionable,
      // "Request failed with 500" is not.
      throw new DbBrowserError(
        body?.error?.code ?? `HTTP_${res.status}`,
        body?.error?.message ?? body?.message ?? `The index service returned ${res.status}`,
      )
    }
    return parsed as T
  }

  return {
    id: options.id ?? base,

    async search(
      query: string,
      limit: number,
      signal?: AbortSignal,
      filters?: VectorSearchFilters,
    ): Promise<VectorSearchResult> {
      const started = Date.now()
      const filtering = hasFilters(filters)
      // Ask for more than we need when filtering, because we cannot know until
      // the answer arrives whether the server applied the filter itself.
      const askFor = filtering ? Math.min(limit * FILTER_OVERFETCH, MAX_OVERFETCH_LIMIT) : limit

      // The filter parameters are sent in both spellings. A server that
      // supports them uses them (and this becomes a proper server-side filter,
      // ranked over the whole index); one that does not ignores unknown JSON
      // fields, and the client-side pass below still produces a correct — if
      // narrower — result. Sending them can never make things worse.
      const body = await call<Record<string, unknown>>(routes.search, {
        method: 'POST',
        body: {
          query,
          limit: askFor,
          ...(filters?.kinds?.length ? { kinds: filters.kinds, kind: filters.kinds } : {}),
          ...(filters?.pathPrefix?.trim()
            ? { path_prefix: filters.pathPrefix.trim(), pathPrefix: filters.pathPrefix.trim() }
            : {}),
        },
        signal,
      })

      const rawHits = (pick(body ?? {}, 'hits', 'results', 'matches') ?? []) as unknown[]
      const all = (Array.isArray(rawHits) ? rawHits : []).map(normalizeHit)
      if (!filtering) {
        return {
          query,
          hits: all,
          durationMs: num(pick(body ?? {}, 'duration_ms', 'durationMs'), Date.now() - started),
          fetched: all.length,
        }
      }

      const kept = applySearchFilters(all, filters)
      // If nothing was dropped, the server had already narrowed the set — which
      // means these really are the top `limit` of that kind, not the survivors
      // of one over-fetched page. The UI says which.
      const serverFiltered = kept.length === all.length
      return {
        query,
        hits: kept.slice(0, limit),
        durationMs: num(pick(body ?? {}, 'duration_ms', 'durationMs'), Date.now() - started),
        filteredClientSide: !serverFiltered,
        fetched: all.length,
      }
    },

    async startRebuild(): Promise<RebuildJob> {
      const body = await call<Record<string, unknown>>(routes.rebuild, { method: 'POST' })
      const job = normalizeJob(body)
      if (!job.id) {
        throw new DbBrowserError(
          'NO_JOB_ID',
          'The index service accepted the rebuild but did not return a job id, so progress cannot be followed.',
        )
      }
      return job
    },

    async rebuildStatus(jobId: string): Promise<RebuildJob> {
      const body = await call<Record<string, unknown>>(
        `${routes.status}/${encodeURIComponent(jobId)}`,
        { method: 'GET' },
      )
      return normalizeJob(body, jobId)
    },
  }
}
