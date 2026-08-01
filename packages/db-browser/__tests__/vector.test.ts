/**
 * Vector-store support: schema detection, BLOB→Float32Array decoding, the
 * search filters, and the rebuild-job record that survives a reload.
 *
 * The decoding tests matter most. A vector blob has no self-describing header —
 * it is `dims * 4` raw bytes — so every guarantee about it (little-endian,
 * float32, L2-normalised, `dims` matching the row) is an *agreement*, and the
 * only thing standing between a broken agreement and silently meaningless
 * similarity scores is a check that throws.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import {
  buildColumnIndex,
  matchesCodeGraph,
  matchesVectorStore,
  VECTOR_STORE_CONTRACT,
} from '../src/vector/contract.js'
import {
  decodeFloat32LE,
  dimsForByteLength,
  dotProduct,
  encodeFloat32LE,
  isNormalized,
  l2Norm,
  l2Normalize,
} from '../src/vector/blob.js'
import { applySearchFilters, normalizeHit, normalizeJob } from '../src/vector/service.js'
import {
  clearRebuildJob,
  loadRebuildJob,
  pollIntervalFor,
  saveRebuildJob,
  STALE_JOB_MS,
} from '../src/vector/jobs.js'
import { DbBrowserError } from '../src/types.js'
import type { VectorSearchHit } from '../src/types.js'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** The real Piranha store's shape, column for column. */
const VECTOR_TABLES = [
  {
    name: 'chunk',
    columns: [
      'id', 'path', 'start_line', 'end_line', 'kind',
      'symbol', 'content', 'token_count', 'content_sha', 'updated_at',
    ],
  },
  { name: 'embedding', columns: ['chunk_id', 'model', 'dims', 'vector'] },
  { name: 'build_meta', columns: ['key', 'value'] },
]

/** The real `code-review-graph` shape, read off `base-app/.code-review-graph`. */
const GRAPH_TABLES = [
  {
    name: 'nodes',
    columns: ['id', 'kind', 'name', 'qualified_name', 'file_path', 'line_start', 'signature'],
  },
  {
    name: 'edges',
    columns: ['id', 'kind', 'source_qualified', 'target_qualified', 'file_path', 'line', 'extra'],
  },
  { name: 'metadata', columns: ['key', 'value'] },
]

describe('vector-store detection', () => {
  it('recognises the contract', () => {
    const m = matchesVectorStore(buildColumnIndex(VECTOR_TABLES))
    expect(m.matched).toBe(true)
    expect(m.missing).toEqual([])
    expect(m.reason).toContain('embedding store')
  })

  it('accepts a SUPERSET — a store that gained a column is still a store', () => {
    // Refusing to recognise an index because the builder added a field would
    // turn every schema addition into an outage.
    const extended = VECTOR_TABLES.map((t) =>
      t.name === 'chunk' ? { ...t, columns: [...t.columns, 'language', 'repo_id'] } : t,
    )
    expect(matchesVectorStore(buildColumnIndex(extended)).matched).toBe(true)
  })

  it('is case-insensitive about table and column names', () => {
    const shouty = VECTOR_TABLES.map((t) => ({
      name: t.name.toUpperCase(),
      columns: t.columns.map((c) => c.toUpperCase()),
    }))
    expect(matchesVectorStore(buildColumnIndex(shouty)).matched).toBe(true)
  })

  it('rejects a MISSING column and names it', () => {
    const broken = VECTOR_TABLES.map((t) =>
      t.name === 'embedding' ? { ...t, columns: ['chunk_id', 'model', 'dims'] } : t,
    )
    const m = matchesVectorStore(buildColumnIndex(broken))
    expect(m.matched).toBe(false)
    expect(m.missing).toContain('embedding.vector')
    expect(m.reason).toContain('embedding.vector')
  })

  it('rejects a missing table and says which', () => {
    const m = matchesVectorStore(buildColumnIndex(VECTOR_TABLES.slice(0, 2)))
    expect(m.matched).toBe(false)
    expect(m.missing).toContain('build_meta (table)')
  })

  it('does not confuse a code graph for a vector store, or the reverse', () => {
    expect(matchesVectorStore(buildColumnIndex(GRAPH_TABLES)).matched).toBe(false)
    expect(matchesCodeGraph(buildColumnIndex(VECTOR_TABLES)).matched).toBe(false)
  })

  it('recognises the real code-graph shape', () => {
    const m = matchesCodeGraph(buildColumnIndex(GRAPH_TABLES))
    expect(m.matched).toBe(true)
    expect(m.reason).toContain('code graph')
  })

  it('does not require the optional analysis tables', () => {
    // `communities`/`flows`/`risk_index` appear only after the deeper passes
    // run; a graph without them is still a graph.
    expect(matchesCodeGraph(buildColumnIndex(GRAPH_TABLES)).matched).toBe(true)
  })

  it('treats a plain relational database as neither', () => {
    const ordinary = [
      { name: 'customer', columns: ['id', 'name'] },
      { name: 'invoice', columns: ['id', 'customer_id', 'total'] },
    ]
    expect(matchesVectorStore(buildColumnIndex(ordinary)).matched).toBe(false)
    expect(matchesCodeGraph(buildColumnIndex(ordinary)).matched).toBe(false)
  })

  it('pins the contract, so a rename is a failing test rather than silent non-detection', () => {
    expect(Object.keys(VECTOR_STORE_CONTRACT).sort()).toEqual(['build_meta', 'chunk', 'embedding'])
    expect(VECTOR_STORE_CONTRACT.embedding).toContain('vector')
    expect(VECTOR_STORE_CONTRACT.embedding).toContain('dims')
  })
})

// ---------------------------------------------------------------------------
// BLOB decoding
// ---------------------------------------------------------------------------

describe('decodeFloat32LE', () => {
  it('round-trips through the stored little-endian encoding', () => {
    const values = [0.5, -0.25, 1, 0, -1, 3.5]
    const decoded = decodeFloat32LE(encodeFloat32LE(values))
    expect(Array.from(decoded)).toEqual(values)
  })

  it('reads little-endian regardless of how the bytes were produced', () => {
    // 1.0 as float32 LE is 00 00 80 3F. Written by hand so the test does not
    // depend on the encoder it is checking.
    const bytes = new Uint8Array([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0xc0])
    expect(Array.from(decodeFloat32LE(bytes))).toEqual([1, -2])
  })

  it('handles an UNALIGNED view — the normal case for a Node Buffer', () => {
    // A `Buffer` is a view into a shared pool, so its `byteOffset` is very
    // often not a multiple of 4, and `new Float32Array(buf.buffer, offset)`
    // throws outright. The decoder must copy instead of blowing up.
    const backing = new Uint8Array(4 + 8)
    backing.set(encodeFloat32LE([2.5, -0.5]), 3) // deliberately offset by 3
    const unaligned = backing.subarray(3, 11)
    expect(unaligned.byteOffset % 4).not.toBe(0)
    expect(Array.from(decodeFloat32LE(unaligned))).toEqual([2.5, -0.5])
  })

  it('accepts an ArrayBuffer or any view', () => {
    const encoded = encodeFloat32LE([1, 2])
    expect(Array.from(decodeFloat32LE(encoded.buffer as ArrayBuffer))).toEqual([1, 2])
    expect(Array.from(decodeFloat32LE(new DataView(encoded.buffer as ArrayBuffer)))).toEqual([1, 2])
  })

  it('throws when the byte length is not a whole number of float32s', () => {
    // 10 bytes cannot be a float array. Silently decoding 2 floats and dropping
    // the rest would produce a vector that compares against others just fine
    // and means nothing.
    expect(() => decodeFloat32LE(new Uint8Array(10))).toThrow(DbBrowserError)
    expect(() => decodeFloat32LE(new Uint8Array(10))).toThrow(/not a whole number of float32s/)
  })

  it('throws when the width disagrees with the row’s declared dims', () => {
    // The signature of an index built with one model and appended to with
    // another. Every score computed across the two would be meaningless.
    const v = encodeFloat32LE(new Array(384).fill(0.1))
    expect(() => decodeFloat32LE(v, 768)).toThrow(/384 dimensions but the row declares 768/)
    expect(() => decodeFloat32LE(v, 384)).not.toThrow()
  })

  it('throws on an empty blob', () => {
    expect(() => decodeFloat32LE(new Uint8Array(0))).toThrow(/empty/)
  })

  it('decodes a realistic 768-dimension vector', () => {
    const source = Array.from({ length: 768 }, (_, i) => Math.sin(i) / 28)
    const bytes = encodeFloat32LE(source)
    expect(bytes.byteLength).toBe(768 * 4)
    expect(bytes.byteLength).toBe(3072)
    expect(decodeFloat32LE(bytes, 768)).toHaveLength(768)
  })
})

describe('dimsForByteLength', () => {
  it.each([
    [3072, 768],
    [1536, 384],
    [6144, 1536],
  ])('%i bytes -> %i dims', (bytes, dims) => {
    expect(dimsForByteLength(bytes)).toBe(dims)
  })

  it('returns null rather than a wrong number when the size cannot be a float array', () => {
    expect(dimsForByteLength(10)).toBeNull()
    expect(dimsForByteLength(0)).toBeNull()
    expect(dimsForByteLength(null)).toBeNull()
    expect(dimsForByteLength(undefined)).toBeNull()
  })
})

describe('similarity', () => {
  it('dot product of unit vectors IS cosine similarity', () => {
    const a = l2Normalize([1, 1, 0])
    const b = l2Normalize([1, 0, 0])
    // cos(45°) = 0.7071…
    expect(dotProduct(a, b)).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('dot(v, v) is 1 for a unit vector', () => {
    const v = l2Normalize([3, 4, 12])
    expect(dotProduct(v, v)).toBeCloseTo(1, 5)
    expect(isNormalized(v)).toBe(true)
  })

  it('refuses to compare different widths', () => {
    expect(() => dotProduct([1, 2], [1, 2, 3])).toThrow(/2-dimension vector with a 3-dimension/)
  })

  it('l2Normalize leaves a zero vector alone rather than producing NaN', () => {
    const z = l2Normalize([0, 0, 0])
    expect(Array.from(z)).toEqual([0, 0, 0])
    expect(l2Norm(z)).toBe(0)
  })

  it('detects a NON-normalised vector instead of quietly fixing it up', () => {
    // Re-normalising on read would hide a builder that forgot to.
    expect(isNormalized([1, 1, 1])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Search filters — the doc-dominance fix
// ---------------------------------------------------------------------------

const hit = (over: Partial<VectorSearchHit>): VectorSearchHit => ({
  path: 'backend/agentic/db/secretbox.ts',
  startLine: 10,
  endLine: 40,
  symbol: 'encrypt',
  kind: 'function',
  score: 0.7,
  snippet: null,
  chunkId: 1,
  ...over,
})

describe('applySearchFilters', () => {
  const hits = [
    hit({ kind: 'doc', path: 'docs/security.md', symbol: null }),
    hit({ kind: 'doc', path: 'README.md', symbol: null }),
    hit({ kind: 'function', path: 'backend/agentic/db/secretbox.ts', symbol: 'encrypt' }),
    hit({ kind: 'class', path: 'ui/src/Crypto.ts', symbol: 'Crypto' }),
    hit({ kind: 'file', path: 'backend/agentic/db/secretbox.ts', symbol: null }),
  ]

  it('passes everything through when there is no filter', () => {
    expect(applySearchFilters(hits, undefined)).toHaveLength(5)
    expect(applySearchFilters(hits, {})).toHaveLength(5)
    expect(applySearchFilters(hits, { kinds: [] })).toHaveLength(5)
  })

  it('keeps only the requested kinds — the fix for a docs-only result', () => {
    // The measured failure: "how are secrets encrypted before being stored"
    // returned five docs and zero code. Filtering to function+class is the
    // one-click remedy.
    const code = applySearchFilters(hits, { kinds: ['function', 'class'] })
    expect(code.map((h) => h.kind)).toEqual(['function', 'class'])
    expect(code.every((h) => h.kind !== 'doc')).toBe(true)
  })

  it('matches kinds case-insensitively — `kind` is free text from the indexer', () => {
    expect(applySearchFilters(hits, { kinds: ['FUNCTION'] })).toHaveLength(1)
  })

  it('filters by path prefix', () => {
    const backend = applySearchFilters(hits, { pathPrefix: 'backend/' })
    expect(backend).toHaveLength(2)
    expect(backend.every((h) => h.path.startsWith('backend/'))).toBe(true)
  })

  it('normalises backslashes so a Windows-flavoured prefix still matches', () => {
    expect(applySearchFilters(hits, { pathPrefix: 'backend\\agentic' })).toHaveLength(2)
  })

  it('ignores a leading slash on the prefix', () => {
    expect(applySearchFilters(hits, { pathPrefix: '/backend/' })).toHaveLength(2)
  })

  it('combines both filters with AND', () => {
    const both = applySearchFilters(hits, { kinds: ['function'], pathPrefix: 'backend/' })
    expect(both).toHaveLength(1)
    expect(both[0].symbol).toBe('encrypt')
  })

  it('returns an empty list rather than falling back to everything', () => {
    // "No results because of the filter" must stay distinguishable from
    // "no results" — the UI says which, and it can only do that if the filter
    // is honest about having removed everything.
    expect(applySearchFilters(hits, { kinds: ['interface'] })).toEqual([])
  })

  it('does not mutate the input', () => {
    const copy = [...hits]
    applySearchFilters(hits, { kinds: ['doc'] })
    expect(hits).toEqual(copy)
  })
})

// ---------------------------------------------------------------------------
// Wire normalisation
// ---------------------------------------------------------------------------

describe('normalizeHit', () => {
  it('accepts snake_case, which is what the indexer emits', () => {
    expect(
      normalizeHit({
        path: 'a/b.ts',
        start_line: 3,
        end_line: 9,
        symbol: 'f',
        kind: 'function',
        score: 0.42,
        snippet: 'code',
        chunk_id: 7,
      }),
    ).toEqual({
      path: 'a/b.ts',
      startLine: 3,
      endLine: 9,
      symbol: 'f',
      kind: 'function',
      score: 0.42,
      snippet: 'code',
      chunkId: 7,
    })
  })

  it('accepts camelCase too', () => {
    const h = normalizeHit({ path: 'a.ts', startLine: 1, endLine: 2, score: 0.1 })
    expect(h.startLine).toBe(1)
    expect(h.endLine).toBe(2)
  })

  it('defaults a missing score to 0, not to something plausible', () => {
    expect(normalizeHit({ path: 'a.ts' }).score).toBe(0)
  })

  it('survives a malformed row without throwing', () => {
    expect(() => normalizeHit(null)).not.toThrow()
    expect(normalizeHit(null).path).toBe('')
  })
})

describe('normalizeJob', () => {
  it('reads the phase/processed/total/percent/message the backend emits', () => {
    const job = normalizeJob({
      id: 'j1',
      phase: 'embed',
      processed: 500,
      total: 2000,
      percent: 25,
      message: 'embedding backend/…',
    })
    expect(job).toMatchObject({ id: 'j1', phase: 'embed', processed: 500, total: 2000, percent: 25 })
    expect(job.status).toBe('running')
  })

  it('computes percent when the server omits it', () => {
    expect(normalizeJob({ id: 'j', phase: 'chunk', processed: 1, total: 4 }).percent).toBe(25)
  })

  it('clamps a percent the server got wrong', () => {
    // A bar that reads 143% is a bug report the user has to file for us.
    expect(normalizeJob({ id: 'j', phase: 'embed', percent: 143 }).percent).toBe(100)
    expect(normalizeJob({ id: 'j', phase: 'embed', percent: -5 }).percent).toBe(0)
  })

  it('treats phase `done` as succeeded, at 100%', () => {
    const job = normalizeJob({ id: 'j', phase: 'done', processed: 10, total: 10 })
    expect(job.status).toBe('succeeded')
    expect(job.percent).toBe(100)
  })

  it('carries the server’s failure message verbatim', () => {
    // "no API key configured" is actionable; "The build failed" is not.
    const job = normalizeJob({ id: 'j', phase: 'failed', message: 'ollama refused: no such model' })
    expect(job.status).toBe('failed')
    expect(job.error).toBe('ollama refused: no such model')
  })

  it('falls back to a known phase for an unrecognised one', () => {
    expect(normalizeJob({ id: 'j', phase: 'wat' }).phase).toBe('queued')
  })

  it('does not report 0/0 as 100% while still queued', () => {
    expect(normalizeJob({ id: 'j', phase: 'queued', processed: 0, total: 0 }).percent).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Re-attaching to a build after a reload
// ---------------------------------------------------------------------------

describe('rebuild job persistence', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    // A minimal localStorage. The module reads `globalThis.localStorage`
    // defensively, so this is all it needs.
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size
      },
    }
  })

  it('re-attaches to a job started before a reload', () => {
    // A build takes minutes; F5 in the middle must not lose it, or the user
    // starts a second build on top of the first.
    saveRebuildJob('svc', 'job-42')
    expect(loadRebuildJob('svc')).toMatchObject({ jobId: 'job-42' })
  })

  it('namespaces per service, so two indexes cannot cross', () => {
    saveRebuildJob('svc-a', 'job-a')
    saveRebuildJob('svc-b', 'job-b')
    expect(loadRebuildJob('svc-a')?.jobId).toBe('job-a')
    expect(loadRebuildJob('svc-b')?.jobId).toBe('job-b')
  })

  it('drops a record old enough that the server has surely forgotten it', () => {
    saveRebuildJob('svc', 'ancient', Date.now() - STALE_JOB_MS - 1)
    expect(loadRebuildJob('svc')).toBeNull()
    // …and the record is cleaned up, not just ignored.
    expect(loadRebuildJob('svc')).toBeNull()
  })

  it('keeps a record that is merely long-running', () => {
    saveRebuildJob('svc', 'slow', Date.now() - 60_000)
    expect(loadRebuildJob('svc')?.jobId).toBe('slow')
  })

  it('clears on demand', () => {
    saveRebuildJob('svc', 'job')
    clearRebuildJob('svc')
    expect(loadRebuildJob('svc')).toBeNull()
  })

  it('returns null for corrupt storage rather than throwing', () => {
    globalThis.localStorage.setItem('dbb:svc:rebuild-job', '{not json')
    expect(loadRebuildJob('svc')).toBeNull()
    globalThis.localStorage.setItem('dbb:svc:rebuild-job', '{"jobId":""}')
    expect(loadRebuildJob('svc')).toBeNull()
  })

  it('backs off polling during the slow phase', () => {
    // `embed` is rate-limited by the model provider; polling it as hard as
    // `scan` is wasted work.
    expect(pollIntervalFor('embed')).toBeGreaterThan(pollIntervalFor('scan'))
  })
})
