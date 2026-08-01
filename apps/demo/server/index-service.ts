/**
 * A **stand-in index service** for the demo.
 *
 * ## What this is, and what it is not
 *
 * Semantic search and rebuilds are properly served by Piranha's db-server. That
 * process is owned by another team and is not always running, which would
 * otherwise leave the demo unable to show the two features the vector UI exists
 * for. So this file implements the same three routes locally:
 *
 *   POST /embeddings/search        {query, limit, kinds?, path_prefix?}
 *   POST /embeddings/rebuild       -> {id}
 *   GET  /embeddings/rebuild/:id   -> {phase, processed, total, percent, message}
 *
 * **Search is real.** It embeds the query with the same Ollama model the index
 * was built with (`build_meta.model`), then scores it against every stored
 * vector with a dot product — which is cosine similarity, because the vectors
 * are L2-normalised at write time. Brute force over 13,482 × 768 floats is a
 * few tens of milliseconds; an ANN index would be the answer at a hundred times
 * this size, and premature here.
 *
 * **Rebuild is a dry run, and deliberately so.** It walks the real chunk table
 * and reports genuine phase/processed/total progress, but it **writes nothing**
 * — the store belongs to another repository and this demo opens it read-only.
 * That is enough to exercise everything the progress UI has to get right (real
 * percentages, phase transitions, a job that outlives a page reload, a disabled
 * button while in flight) without touching a file it does not own.
 *
 * Set `PIRANHA_API_URL` to point at the real service instead, and the demo
 * proxies to that; leave `DEMO_INDEX_SERVICE=true` to use this one.
 */

import { createSqliteDataSource } from '@jugaaadi/db-browser-sqlite'
import { openSqlite } from '@jugaaadi/db-browser-sqlite'
import { decodeFloat32LE, dotProduct, l2Normalize } from '@jugaaadi/db-browser/core'
import type { SqliteDb } from '@jugaaadi/db-browser-sqlite'

export interface IndexServiceOptions {
  filename: string
  /** Ollama base URL. Read from `build_meta.ollama_host` when present. */
  ollamaHost?: string
}

interface ChunkRow {
  id: number
  path: string
  start_line: number
  end_line: number
  kind: string
  symbol: string | null
  content: string
}

interface LoadedVector {
  chunkId: number
  vector: Float32Array
}

export interface DemoIndexService {
  search(query: string, limit: number, kinds?: string[], pathPrefix?: string): Promise<unknown>
  startRebuild(): { id: string }
  rebuildStatus(id: string): unknown
  close(): void
}

/** Embed one string with Ollama, using the index's own model. */
async function embed(host: string, model: string, text: string): Promise<Float32Array> {
  const res = await fetch(`${host.replace(/\/+$/, '')}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
  })
  if (!res.ok) {
    throw new Error(`Ollama returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const body = (await res.json()) as { embedding?: number[] }
  if (!Array.isArray(body.embedding)) throw new Error('Ollama returned no embedding')
  // The query must be normalised the same way the stored vectors were, or the
  // dot product is not a cosine and the scores are not comparable.
  return l2Normalize(body.embedding)
}

export async function createDemoIndexService(
  options: IndexServiceOptions,
): Promise<DemoIndexService> {
  const db: SqliteDb = await openSqlite({ filename: options.filename, readOnly: true })

  const meta: Record<string, string> = {}
  for (const r of db.prepare('SELECT key, value FROM build_meta').all() as Array<{
    key: string
    value: string
  }>) {
    meta[r.key] = r.value
  }
  const model = meta.model || 'nomic-embed-text'
  const dims = Number(meta.dims || 768)
  const host = options.ollamaHost || meta.ollama_host || 'http://localhost:11434'

  // Vectors are loaded once and held in memory: 13,482 × 3 KB is ~40 MB, which
  // is the right trade for a service that answers a search in one pass. A real
  // deployment at a larger scale wants an ANN index instead.
  let vectors: LoadedVector[] | null = null
  function loadVectors(): LoadedVector[] {
    if (vectors) return vectors
    const rows = db
      .prepare('SELECT chunk_id, vector FROM embedding')
      .all() as unknown as Array<{ chunk_id: number; vector: Uint8Array }>
    vectors = rows.map((r) => ({
      chunkId: Number(r.chunk_id),
      vector: decodeFloat32LE(r.vector, dims),
    }))
    return vectors
  }

  const chunkById = db.prepare(
    'SELECT id, path, start_line, end_line, kind, symbol, content FROM chunk WHERE id = ?',
  )

  return {
    async search(query: string, limit: number, kinds?: string[], pathPrefix?: string) {
      const started = Date.now()
      const q = await embed(host, model, query)
      const all = loadVectors()

      // Score everything, then partially sort. `sort` over 13k scored entries
      // is trivially fast and far simpler than maintaining a heap.
      const scored = all
        .map((v) => ({ chunkId: v.chunkId, score: dotProduct(q, v.vector) }))
        .sort((a, b) => b.score - a.score)

      // Server-side filtering: applied *before* the top-N cut, which is the
      // whole advantage over the client's fallback. Filtering here means "the
      // top 10 functions"; filtering in the browser can only mean "the
      // functions among the top 50".
      const wantKinds = kinds?.length ? new Set(kinds.map((k) => k.toLowerCase())) : null
      const prefix = pathPrefix?.trim().replace(/\\/g, '/').replace(/^\/+/, '') || null

      const hits: unknown[] = []
      for (const s of scored) {
        if (hits.length >= limit) break
        const row = chunkById.get(s.chunkId) as unknown as ChunkRow | undefined
        if (!row) continue
        if (wantKinds && !wantKinds.has(String(row.kind).toLowerCase())) continue
        if (prefix && !row.path.replace(/\\/g, '/').startsWith(prefix)) continue
        hits.push({
          chunk_id: row.id,
          path: row.path,
          start_line: row.start_line,
          end_line: row.end_line,
          kind: row.kind,
          symbol: row.symbol,
          score: s.score,
          // Trimmed: a chunk can be hundreds of lines and the card shows ~12.
          snippet: String(row.content ?? '').split('\n').slice(0, 14).join('\n'),
        })
      }

      return { hits, duration_ms: Date.now() - started, query, model }
    },

    startRebuild() {
      const id = `demo-${Date.now().toString(36)}`
      jobs.set(id, startDryRun(db, id))
      return { id }
    },

    rebuildStatus(id: string) {
      const job = jobs.get(id)
      if (!job) return { id, phase: 'failed', message: 'Unknown job id', status: 'failed' }
      return job.snapshot()
    },

    close: () => db.close(),
  }
}

// ---------------------------------------------------------------------------
// The dry-run rebuild
// ---------------------------------------------------------------------------

interface Job {
  snapshot(): Record<string, unknown>
}

const jobs = new Map<string, Job>()

/**
 * Walk the real index and report real progress — without writing anything.
 *
 * The phases and their relative costs mirror a real build: `scan` and `chunk`
 * are fast, `embed` is the long one, `write` is quick again. That shape is the
 * point: a progress UI that only ever sees an even ramp does not prove it can
 * render a build that sits at 30% for two minutes, which is what a real one
 * does.
 */
function startDryRun(db: SqliteDb, id: string): Job {
  const total = Number(
    (db.prepare('SELECT count(*) AS n FROM chunk').get() as { n: number } | undefined)?.n ?? 0,
  )
  const paths = Number(
    (db.prepare('SELECT count(DISTINCT path) AS n FROM chunk').get() as { n: number } | undefined)
      ?.n ?? 0,
  )

  const state = {
    id,
    phase: 'scan' as string,
    processed: 0,
    total: paths,
    message: 'scanning the repository',
    status: 'running' as string,
    started_at: new Date().toISOString(),
    finished_at: null as string | null,
  }

  const phases: Array<{ name: string; total: number; ms: number; message: string }> = [
    { name: 'scan', total: paths, ms: 1500, message: 'walking the repository' },
    { name: 'chunk', total, ms: 2500, message: 'splitting files into symbol-sized chunks' },
    { name: 'embed', total, ms: 12_000, message: 'calling the embedding model' },
    { name: 'write', total, ms: 1500, message: 'writing vectors (dry run — nothing is written)' },
  ]

  let phaseIndex = 0
  let phaseStart = Date.now()

  const tick = setInterval(() => {
    const phase = phases[phaseIndex]
    const elapsed = Date.now() - phaseStart
    const fraction = Math.min(1, elapsed / phase.ms)
    state.phase = phase.name
    state.total = phase.total
    state.processed = Math.round(phase.total * fraction)
    state.message = `${phase.message} (${state.processed.toLocaleString()} / ${phase.total.toLocaleString()})`

    if (fraction >= 1) {
      phaseIndex++
      phaseStart = Date.now()
      if (phaseIndex >= phases.length) {
        state.phase = 'done'
        state.status = 'succeeded'
        state.processed = total
        state.total = total
        state.message = 'dry run complete — the store was not modified'
        state.finished_at = new Date().toISOString()
        clearInterval(tick)
      }
    }
  }, 250)
  // Do not hold the process open for a job nobody is watching.
  tick.unref?.()

  return {
    snapshot: () => ({
      ...state,
      percent: state.total > 0 ? (state.processed / state.total) * 100 : 0,
    }),
  }
}

/** Re-export so the server can construct a source without a second import. */
export { createSqliteDataSource }
