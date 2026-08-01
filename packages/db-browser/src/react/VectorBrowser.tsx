/**
 * Vector-store mode: what you see instead of a grid when the database turns out
 * to be an embedding store.
 *
 * ## Why this is not a grid
 *
 * The `chunk` and `embedding` tables *are* browsable, and stay browsable — the
 * `Data` tab in the header switches to the normal grid at any time. But rows
 * are the wrong primary view for this file. The question you bring to an
 * embedding store is "what in this codebase is about X", and the grid answers
 * "here is row 1 of 40,000, whose `vector` column is 3 KB of bytes". Every
 * affordance the grid offers — sort by column, filter by substring, edit a cell
 * — is either meaningless or actively wrong against an index that is derived
 * data.
 *
 * So the search box is the **primary control**: it is the first thing rendered,
 * it holds focus on mount, and it is the widest element on the screen.
 *
 * ## What this screen no longer says
 *
 * It used to open with a `Vector store` badge, a sentence explaining that this
 * is an embedding index, and a `Browse tables` button — three restatements of
 * facts the header's own mode tab and the sub-label already carry, occupying
 * the band directly above the control the screen exists for. All three are
 * gone. The stats strip lost its `Vectors` tile too: it is the chunk count in
 * every healthy index, and in the one case where it differs that *is* the
 * "incomplete index" warning, which says it with the consequence attached.
 *
 * ## Layout order, and why
 *
 * 1. **Stats** — model, dimensions, chunks, build time, commit. First because
 *    every result below is only meaningful relative to them: a hit from an
 *    index built three weeks ago is a different fact from the same hit against
 *    `HEAD`. They condense as you scroll into the results, because by result
 *    twelve you have read them.
 * 2. **Search** — the reason the screen exists.
 * 3. **Filters** — beside the box, never behind a disclosure. See `KindFilter`.
 * 4. **Results** — ranked, scannable, with the code.
 * 5. **Rebuild** — last, pinned, because it is the destructive-ish action and
 *    because it is what you reach for *after* the stats told you it is stale.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Glyph } from './iconography.js'
import { Appear, CondenseBox, useCondense } from './motion.js'
import { hint, useShortcuts } from './shortcuts.js'
import { KindFilter } from './KindFilter.js'
import { RebuildControl } from './RebuildControl.js'
import { SearchResults } from './SearchResults.js'
import type { IconName } from './iconography.js'
import type { VectorSearchHit, VectorService, VectorStoreProfile } from '../types.js'

export interface VectorBrowserProps {
  profile: VectorStoreProfile
  /** Null when no index service is reachable — search says so, browsing works. */
  service: VectorService | null
  /** Switch to the raw `chunk`/`embedding` grid. */
  onShowTables: () => void
  /** Open the `chunk` row behind a hit in the grid. */
  onOpenChunk?: (hit: VectorSearchHit) => void
  /** Re-read the profile after a rebuild finishes. */
  onRefreshProfile?: () => void
  label?: string
}

const LIMITS = [5, 10, 20, 50]

/** `2026-07-30T09:12:00Z` → `30 Jul 2026, 09:12`, plus "how long ago". */
function formatBuiltAt(iso: string | null): { absolute: string; relative: string } | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return { absolute: iso, relative: '' }
  const ms = Date.now() - at.getTime()
  const mins = Math.round(ms / 60000)
  const relative =
    mins < 1
      ? 'just now'
      : mins < 60
        ? `${mins} min ago`
        : mins < 60 * 24
          ? `${Math.round(mins / 60)} h ago`
          : `${Math.round(mins / (60 * 24))} d ago`
  return { absolute: at.toLocaleString(), relative }
}

function Stat({
  icon,
  label,
  value,
  title,
  index,
}: {
  icon: IconName
  label: string
  value: React.ReactNode
  title?: string
  index: number
}) {
  return (
    <Appear className="dbb-stat" index={index} y={4}>
      <span className="dbb-stat-icon">
        <Glyph name={icon} size="lg" />
      </span>
      <span className="dbb-stat-body" title={title}>
        <span className="dbb-stat-label">{label}</span>
        <span className="dbb-stat-value">{value}</span>
      </span>
    </Appear>
  )
}

export function VectorBrowser({
  profile,
  service,
  onShowTables,
  onOpenChunk,
  onRefreshProfile,
  label = 'embeddings',
}: VectorBrowserProps) {
  const [input, setInput] = useState('')
  const [limit, setLimit] = useState(10)
  const [hits, setHits] = useState<VectorSearchHit[]>([])
  const [ranQuery, setRanQuery] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  /** Empty = every kind. See `KindFilter` for why that is the representation. */
  const [kinds, setKinds] = useState<string[]>([])
  const [pathPrefix, setPathPrefix] = useState('')
  const [clientFiltered, setClientFiltered] = useState(false)
  const [fetched, setFetched] = useState(0)
  /** The filters the *displayed* results were produced with, for the summary. */
  const [ranKinds, setRanKinds] = useState<string[]>([])

  const box = useRef<HTMLInputElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  /** Aborts the previous search so a slow one cannot land after a fast one. */
  const inflight = useRef<AbortController | null>(null)
  const condense = useCondense(scroller)

  useEffect(() => {
    box.current?.focus()
  }, [])

  // Cancel anything in flight when the component goes away, so a resolved
  // fetch cannot call setState on an unmounted tree.
  useEffect(() => () => inflight.current?.abort(), [])

  const search = useCallback(
    async (text: string, overrideKinds?: string[], overridePath?: string) => {
      const q = text.trim()
      if (!q || !service) return
      const useKinds = overrideKinds ?? kinds
      const usePath = overridePath ?? pathPrefix
      inflight.current?.abort()
      const controller = new AbortController()
      inflight.current = controller
      setSearching(true)
      setError(null)
      try {
        const result = await service.search(q, limit, controller.signal, {
          kinds: useKinds,
          pathPrefix: usePath,
        })
        if (controller.signal.aborted) return
        setHits(result.hits)
        setRanQuery(result.query)
        setRanKinds(useKinds)
        setDurationMs(result.durationMs ?? null)
        setClientFiltered(!!result.filteredClientSide)
        setFetched(result.fetched ?? result.hits.length)
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return
        setError(e instanceof Error ? e.message : 'Search failed')
        setHits([])
        setRanQuery(q)
        setRanKinds(useKinds)
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    },
    [service, limit, kinds, pathPrefix],
  )

  /**
   * Changing a filter re-runs the *current* query immediately rather than
   * waiting for another Enter. The filter's whole value is that it takes one
   * click to go from "five docs and no code" to the implementation; making the
   * user re-submit would put a second step back in front of that.
   */
  const applyKinds = useCallback(
    (next: string[]) => {
      setKinds(next)
      if (ranQuery) void search(ranQuery, next)
    },
    [ranQuery, search],
  )

  useShortcuts([
    {
      id: 'vector-search',
      keys: 'mod+enter',
      label: 'Run search',
      group: 'Search',
      allowInEditor: true,
      enabled: !!service,
      run: () => void search(input),
    },
    {
      id: 'vector-code-only',
      // `alt+o` ("code Only"): Ctrl/⌘+Shift+C opens DevTools' element picker
      // and never reaches the page.
      keys: 'alt+o',
      label: 'Toggle “Code only”',
      group: 'Search',
      enabled: !!service && profile.kinds.length > 0,
      run: () =>
        applyKinds(
          kinds.length
            ? []
            : profile.kinds.map((k) => k.kind).filter((k) => k === 'function' || k === 'class'),
        ),
    },
  ])

  const built = formatBuiltAt(profile.builtAt)
  const mixedModels = profile.models.length > 1
  // An embedding row with no vector means the build stopped part-way; the
  // counts are the only place that is visible without reading every row.
  const incomplete =
    profile.chunkCount > 0 && profile.embeddingCount > 0 && profile.embeddingCount !== profile.chunkCount

  return (
    <div className="dbb-vector" ref={scroller}>
      <CondenseBox className="dbb-stats" style={condense}>
        <Stat
          index={0}
          icon="semanticSearch"
          label="Model"
          value={profile.model ?? <span className="dbb-muted">unknown</span>}
          title={
            mixedModels
              ? `This index contains vectors from more than one model: ${profile.models.join(', ')}`
              : 'From build_meta.model'
          }
        />
        <Stat
          index={1}
          icon="typeVector"
          label="Dimensions"
          value={profile.dims?.toLocaleString() ?? <span className="dbb-muted">unknown</span>}
          title="Floats per vector. Each stored blob is exactly dims × 4 bytes."
        />
        <Stat
          index={2}
          icon="chunk"
          label="Chunks"
          value={profile.chunkCount.toLocaleString()}
          title={
            incomplete
              ? `COUNT(*) over the chunk table. Only ${profile.embeddingCount.toLocaleString()} of them have a vector.`
              : 'COUNT(*) over the chunk table — every one of them has a vector'
          }
        />
        <Stat
          index={3}
          icon="rebuild"
          label="Built"
          value={
            built ? (
              <span title={built.absolute}>{built.relative || built.absolute}</span>
            ) : (
              <span className="dbb-muted">unknown</span>
            )
          }
          title={built?.absolute ?? 'build_meta.built_at is not set'}
        />
        <Stat
          index={4}
          icon="commit"
          label="Commit"
          value={
            profile.gitCommit ? (
              <code>{profile.gitCommit.slice(0, 10)}</code>
            ) : (
              <span className="dbb-muted">unknown</span>
            )
          }
          title={
            profile.gitCommit
              ? `Built from ${profile.gitCommit}. Results describe the code as of that commit.`
              : 'build_meta.git_commit is not set'
          }
        />
      </CondenseBox>

      {mixedModels ? (
        <Appear className="dbb-banner dbb-banner-warn">
          <Glyph name="failure" size="sm" />
          <span>
            <strong>Mixed models.</strong> This index holds vectors from {profile.models.join(', ')}.
            Similarity between vectors from different models is not meaningful — rebuild it.
          </span>
        </Appear>
      ) : null}
      {incomplete ? (
        <Appear className="dbb-banner dbb-banner-warn">
          <Glyph name="failure" size="sm" />
          <span>
            <strong>Incomplete index.</strong> {profile.chunkCount.toLocaleString()} chunks but{' '}
            {profile.embeddingCount.toLocaleString()} vectors — the last build did not finish, so some
            chunks can never be retrieved.
          </span>
        </Appear>
      ) : null}

      <form
        className="dbb-search-form"
        onSubmit={(e) => {
          e.preventDefault()
          void search(input)
        }}
      >
        <span className="dbb-search-icon">
          <Glyph name="semanticSearch" size="lg" />
        </span>
        <input
          ref={box}
          className="dbb-search-box"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search by meaning — “where do we retry a failed webhook”"
          aria-label="Semantic search"
          disabled={!service}
          data-dbb-focus="search"
        />
        <label className="dbb-field" title="How many ranked hits to fetch">
          <span className="dbb-sr-only">Results</span>
          <Glyph name="rows" size="sm" />
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="dbb-primary"
          disabled={!service || !input.trim() || searching}
          title={hint('Search', 'mod+enter')}
        >
          <Glyph name={searching ? 'busy' : 'search'} size="sm" spin={searching} tone="run" />
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {/* Filters sit *beside* the search box, not behind a disclosure: a
          conceptual query returns documentation by default, and the one-click
          fix has to be visible at the moment the user reads that result. */}
      <div className="dbb-filters">
        <KindFilter available={profile.kinds} selected={kinds} onChange={applyKinds} disabled={!service} />
        <label className="dbb-path-filter">
          <Glyph name="pathFilter" size="sm" />
          <span className="dbb-kinds-label">Path</span>
          <input
            value={pathPrefix}
            onChange={(e) => setPathPrefix(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ranQuery) {
                e.preventDefault()
                void search(ranQuery, undefined, pathPrefix)
              }
            }}
            onBlur={() => {
              if (ranQuery) void search(ranQuery, undefined, pathPrefix)
            }}
            placeholder="backend/"
            aria-label="Limit results to a path prefix"
            disabled={!service}
          />
          {pathPrefix ? (
            <button
              type="button"
              className="dbb-link"
              onClick={() => {
                setPathPrefix('')
                if (ranQuery) void search(ranQuery, undefined, '')
              }}
            >
              clear
            </button>
          ) : null}
        </label>
      </div>

      {/* Docs outrank code on conceptual queries. Said once, up front, rather
          than left for the user to rediscover — with the fix one click away. */}
      {ranQuery !== null && !kinds.length && hits.length > 0 && hits.every((h) => h.kind === 'doc') ? (
        <Appear className="dbb-banner dbb-banner-warn">
          <Glyph name="doc" size="sm" />
          <span>
            <strong>Every hit is documentation.</strong> A question phrased in prose matches prose, so
            docs rank above the code that implements it.{' '}
            <button
              type="button"
              className="dbb-link"
              onClick={() =>
                applyKinds(profile.kinds.map((k) => k.kind).filter((k) => k === 'function' || k === 'class'))
              }
            >
              Search code only
            </button>
            .
          </span>
        </Appear>
      ) : null}

      {/* Degrade, never hard-fail: with no index service the stats, the tables
          and the SQL console are all still perfectly usable. */}
      {!service ? (
        <div className="dbb-banner dbb-banner-info">
          <Glyph name="unavailable" size="sm" />
          <span>
            <strong>Search is unavailable.</strong> No index service is configured for this source, so
            queries cannot be embedded. Everything else still works —{' '}
            <button type="button" className="dbb-link" onClick={onShowTables}>
              browse the stored chunks
            </button>{' '}
            instead.
          </span>
        </div>
      ) : null}

      {ranQuery !== null && !error ? (
        <div className="dbb-result-head">
          <span>
            <strong>{hits.length}</strong> result{hits.length === 1 ? '' : 's'} for <code>{ranQuery}</code>
            {durationMs !== null ? ` · ${Math.round(durationMs)} ms` : ''}
          </span>
          {/* Where the filtering happened changes what the numbers mean, so it
              is stated rather than implied. Server-side filtering ranks over
              the whole index; client-side can only narrow one over-fetched
              page, so these are "the matching hits among the top N". */}
          {clientFiltered ? (
            <span
              className="dbb-badge dbb-badge-warn"
              title="The index service does not accept filter parameters, so the results were narrowed in the browser after ranking. These are the matching hits among the top results, not the top results of this kind."
            >
              filtered here · {hits.length} of {fetched} fetched
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="dbb-vector-results">
        <SearchResults
          hits={hits}
          loading={searching}
          query={ranQuery}
          error={error}
          onOpenHit={onOpenChunk}
          activeKinds={ranKinds}
          onClearFilters={() => applyKinds([])}
        />
      </div>

      <footer className="dbb-vector-foot">
        <RebuildControl service={service} label={label} onCompleted={onRefreshProfile} />
      </footer>
    </div>
  )
}
