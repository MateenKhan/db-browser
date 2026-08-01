/**
 * Semantic search results.
 *
 * **A list, not a table.** A grid is the right shape for homogeneous rows you
 * scan *down* one column at a time; a ranked retrieval result is the opposite —
 * every hit is read as a unit ("what is this, how well does it match, show me
 * the code"), and the snippet is multi-line, so a table cell would either clip
 * it or make every row 200px tall. So each hit is a card: location, symbol,
 * relevance, code.
 *
 * The score is rendered **twice on purpose** — as a bar and as a number. The
 * bar makes the *ranking* legible without reading (the eye compares lengths far
 * faster than it compares decimals), and the number keeps it honest, because
 * "0.62" and "0.61" are indistinguishable as bars but can be the difference
 * between a real match and a near-miss.
 *
 * ## Motion
 *
 * Cards above the fold cascade in on a capped ramp; cards below it animate as
 * they are scrolled to, once each. That is the one place scroll-linked motion
 * genuinely earns itself here — a ranked list is read top-down, and a card that
 * arrives as you reach it reinforces the ordering. Nothing waits on it: a card
 * is clickable on its first frame, and under `prefers-reduced-motion` no motion
 * component is mounted at all.
 */

import { Glyph } from './iconography.js'
import { Appear } from './motion.js'
import { CODE_KINDS, kindClass } from './KindFilter.js'
import { SnippetHighlight } from './SnippetHighlight.js'
import type { IconName } from './iconography.js'
import type { VectorSearchHit } from '../types.js'

export interface SearchResultsProps {
  hits: readonly VectorSearchHit[]
  /** True while a search is in flight — keeps the old list visible, dimmed. */
  loading?: boolean
  /** Null until a search has actually been run. */
  query: string | null
  error?: string | null
  onOpenHit?: (hit: VectorSearchHit) => void
  /** Shown in the empty state so a filter that hid everything is obvious. */
  activeKinds?: readonly string[]
  onClearFilters?: () => void
}

/** Which glyph a chunk kind gets. Doc, file and code are the three that matter. */
function kindIcon(kind: string): IconName {
  const k = kind.toLowerCase()
  if (k === 'doc' || k === 'docs' || k === 'documentation') return 'doc'
  if (k === 'file') return 'fileChunk'
  return 'chunk'
}

/**
 * The kind badge carries its own icon as well as its own colour.
 *
 * Two channels rather than one because this is the distinction the user most
 * needs to make at a glance — a conceptual query returns documentation that
 * *reads* like an answer while the implementation is elsewhere, and the only
 * signal that a hit is prose rather than code is this badge. Colour alone would
 * also fail anyone with a colour-vision deficiency on exactly the distinction
 * that matters most here.
 */
function KindBadge({ kind }: { kind: string }) {
  const k = kind.toLowerCase()
  return (
    <span
      className={`${kindClass(kind)} dbb-kind-badge`}
      title={
        k === 'doc' || k === 'docs'
          ? 'Documentation. Prose matches prose — a conceptual query ranks docs above the code that implements it, so filter to Code only to find the implementation.'
          : CODE_KINDS.includes(k)
            ? `A ${k} chunk — this is source code`
            : `Chunk kind: ${kind}`
      }
    >
      <Glyph name={kindIcon(kind)} size="sm" tone="mute" className="dbb-kind-glyph" />
      {kind}
    </span>
  )
}

/**
 * `path:12-40`. The colon-line form is the one every editor, terminal and
 * stack trace already uses, so it can be copied straight into `code -g` or a
 * `grep` result and just work.
 */
function locationOf(hit: VectorSearchHit): string {
  if (!hit.startLine) return hit.path
  return hit.endLine && hit.endLine !== hit.startLine
    ? `${hit.path}:${hit.startLine}-${hit.endLine}`
    : `${hit.path}:${hit.startLine}`
}

/**
 * Vectors are stored L2-normalised, so a score is a cosine in `[-1, 1]` and in
 * practice lands in `[0, 1]`. It is shown as a percentage because "68%" is
 * immediately comparable, and clamped because a negative cosine is real but a
 * negative-width bar is not.
 */
function scorePercent(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(100, score * 100))
}

export function SearchResults({
  hits,
  loading,
  query,
  error,
  onOpenHit,
  activeKinds,
  onClearFilters,
}: SearchResultsProps) {
  if (error) {
    return (
      <div className="dbb-banner dbb-banner-error" role="alert">
        <Glyph name="failure" size="sm" />
        <span>
          <strong>Search failed.</strong> {error}
        </span>
      </div>
    )
  }

  if (query === null) {
    return (
      <div className="dbb-empty dbb-empty-lg dbb-search-hint">
        <Glyph name="semanticSearch" size="lg" />
        <p>
          Search this index by <strong>meaning</strong>, not by substring. Describe what the code does
          — “where do we validate a webhook signature” — rather than naming an identifier.
        </p>
      </div>
    )
  }

  if (!hits.length && !loading) {
    const filtered = !!activeKinds?.length
    return (
      <div className="dbb-empty">
        <p>
          No {filtered ? <strong>{activeKinds.join(' / ')}</strong> : null} chunk in this index is close
          to <code>{query}</code>.
        </p>
        {/* A filter that hides everything looks identical to an empty index.
            Saying which one it is — and offering the undo — is the difference
            between "no results" and "no results *because of this*". */}
        {filtered ? (
          <p className="dbb-muted">
            The kind filter removed every hit. The nearest chunks were of another kind.
            {onClearFilters ? (
              <>
                {' '}
                <button type="button" className="dbb-link" onClick={onClearFilters}>
                  search all kinds
                </button>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <ol className={loading ? 'dbb-hits dbb-hits-stale' : 'dbb-hits'}>
      {hits.map((hit, i) => {
        const pct = scorePercent(hit.score)
        return (
          <Appear
            as="li"
            className="dbb-hit"
            key={`${hit.chunkId ?? hit.path}-${hit.startLine}-${i}`}
            index={i}
            // Past the sixth card the list is below the fold on most viewports;
            // animating on scroll instead keeps the cascade tied to reading.
            whenVisible={i > 5}
          >
            <div className="dbb-hit-head">
              <span className="dbb-hit-rank" aria-label={`Rank ${i + 1}`}>
                {i + 1}
              </span>
              {onOpenHit ? (
                <button
                  type="button"
                  className="dbb-hit-path dbb-link"
                  onClick={() => onOpenHit(hit)}
                  title="Open the backing chunk row"
                >
                  <Glyph name="chunk" size="sm" />
                  {locationOf(hit)}
                </button>
              ) : (
                <span className="dbb-hit-path">
                  <Glyph name="chunk" size="sm" />
                  {locationOf(hit)}
                </span>
              )}
              {hit.symbol ? <code className="dbb-hit-symbol">{hit.symbol}</code> : null}
              {hit.kind ? <KindBadge kind={hit.kind} /> : null}
              <span className="dbb-spacer" />
              <span
                className="dbb-score"
                title={`Cosine similarity ${hit.score.toFixed(4)} — a dot product, because stored vectors are L2-normalised`}
              >
                <span className="dbb-score-bar" aria-hidden>
                  <span className="dbb-score-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="dbb-score-value">{pct.toFixed(0)}%</span>
              </span>
            </div>
            {hit.snippet ? (
              <SnippetHighlight code={hit.snippet} symbol={hit.symbol} startLine={hit.startLine} />
            ) : null}
          </Appear>
        )
      })}
    </ol>
  )
}
