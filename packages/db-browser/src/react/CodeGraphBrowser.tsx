/**
 * Code-graph mode: the read-only overview of a `code-review-graph` database.
 *
 * The schema this renders was **read off a real file**
 * (`.code-review-graph/graph.db`), not designed here: `nodes` (symbols, keyed
 * by `qualified_name`), `edges` (`kind`, `source_qualified`,
 * `target_qualified`), `metadata` (`schema_version`), plus the optional
 * analysis tables — `communities`, `flows`, `risk_index` — that only appear
 * once the deeper passes have run. Anything this component shows exists in that
 * file; anything it does not show is because that file does not have it.
 *
 * **Read-only, deliberately, and not because of a missing feature.** Every row
 * here is derived: it is a fact *about* source code that a build produced. A
 * hand-edit would survive exactly until the next rebuild and, in the meantime,
 * would make the graph disagree with the repository it claims to describe —
 * which is worse than not editing it, because the graph's whole value is being
 * trustworthy about the code.
 *
 * The overview is a *starting point*, not the whole story: the kind histograms
 * are the fastest way to see what a build actually captured (a graph with 4,000
 * `File` nodes and 11 `CALLS` edges did not resolve calls), and every stat is a
 * link into the table behind it.
 *
 * ## Decluttering note
 *
 * The `Code graph` badge, the sentence under it and the `Browse tables` button
 * are gone: the header's mode tab is literally called **Graph**, its sub-label
 * says `code graph`, and the `Data` tab is the browse-tables control. The
 * `metadata` list also no longer repeats `schema_version` — it has a stat of
 * its own, and a fact printed twice on one screen makes the reader wonder which
 * one is current.
 */

import { Glyph } from './iconography.js'
import { Appear, motion, useMotionOK } from './motion.js'
import { RebuildControl } from './RebuildControl.js'
import type { IconName } from './iconography.js'
import type { CodeGraphProfile, TableRef, VectorService } from '../types.js'

export interface CodeGraphBrowserProps {
  profile: CodeGraphProfile
  /** Null when no rebuild service is configured. */
  service: VectorService | null
  onShowTables: () => void
  /** Open one table in the normal grid. */
  onOpenTable: (table: TableRef) => void
  /** The database/schema the graph tables live in (`main` for SQLite). */
  schema: string
  onRefreshProfile?: () => void
}

/** Facts the stats strip already states. Printing them twice invites doubt. */
const META_SHOWN_ELSEWHERE = new Set(['schema_version'])

/**
 * A histogram row. Bars are scaled to the **largest bucket**, not to the total,
 * because a graph is almost always dominated by one edge kind and scaling to
 * the total would render every other bar as an invisible sliver.
 */
function Histogram({
  title,
  hint,
  rows,
  emptyNote,
}: {
  title: string
  hint: string
  rows: Array<{ kind: string; count: number }>
  emptyNote: string
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0)
  const ok = useMotionOK()
  return (
    <section className="dbb-histogram">
      <h3 title={hint}>{title}</h3>
      {rows.length ? (
        <ul>
          {rows.map((r, i) => (
            <li key={r.kind}>
              <span className="dbb-hist-label" title={r.kind}>
                {r.kind}
              </span>
              <span className="dbb-hist-bar" aria-hidden>
                {ok ? (
                  <motion.span
                    className="dbb-hist-fill"
                    initial={{ width: 0 }}
                    animate={{ width: max ? `${(r.count / max) * 100}%` : '0%' }}
                    transition={{ duration: 0.45, ease: [0.2, 0, 0.13, 1], delay: Math.min(i * 0.03, 0.2) }}
                  />
                ) : (
                  <span
                    className="dbb-hist-fill"
                    style={{ width: max ? `${(r.count / max) * 100}%` : '0%' }}
                  />
                )}
              </span>
              <span className="dbb-hist-count">{r.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dbb-muted">{emptyNote}</p>
      )}
    </section>
  )
}

function GraphStat({
  icon,
  label,
  value,
  index,
  onOpen,
  title,
}: {
  icon: IconName
  label: string
  value: React.ReactNode
  index: number
  onOpen?: () => void
  title?: string
}) {
  return (
    <Appear className="dbb-stat" index={index} y={4}>
      <span className="dbb-stat-icon">
        <Glyph name={icon} size="lg" />
      </span>
      <span className="dbb-stat-body">
        <span className="dbb-stat-label">{label}</span>
        {onOpen ? (
          <button type="button" className="dbb-stat-value dbb-link" onClick={onOpen} title={title}>
            {value}
          </button>
        ) : (
          <span className="dbb-stat-value" title={title}>
            {value}
          </span>
        )}
      </span>
    </Appear>
  )
}

export function CodeGraphBrowser({
  profile,
  service,
  onOpenTable,
  schema,
  onRefreshProfile,
}: CodeGraphBrowserProps) {
  const empty = profile.nodeCount === 0 && profile.edgeCount === 0
  const meta = Object.entries(profile.meta).filter(([k]) => !META_SHOWN_ELSEWHERE.has(k))

  return (
    <div className="dbb-graph">
      <div className="dbb-stats">
        <GraphStat
          index={0}
          icon="node"
          label="Nodes"
          value={profile.nodeCount.toLocaleString()}
          title="Open the nodes table"
          onOpen={() => onOpenTable({ schema, name: 'nodes' })}
        />
        <GraphStat
          index={1}
          icon="edge"
          label="Edges"
          value={profile.edgeCount.toLocaleString()}
          title="Open the edges table"
          onOpen={() => onOpenTable({ schema, name: 'edges' })}
        />
        {profile.communityCount !== null ? (
          <GraphStat
            index={2}
            icon="community"
            label="Communities"
            value={profile.communityCount.toLocaleString()}
            title="Open the communities table"
            onOpen={() => onOpenTable({ schema, name: 'communities' })}
          />
        ) : null}
        {profile.flowCount !== null ? (
          <GraphStat
            index={3}
            icon="edge"
            label="Flows"
            value={profile.flowCount.toLocaleString()}
            title="Open the flows table"
            onOpen={() => onOpenTable({ schema, name: 'flows' })}
          />
        ) : null}
        <GraphStat
          index={4}
          icon="graph"
          label="Schema version"
          value={profile.schemaVersion ?? <span className="dbb-muted">unknown</span>}
          title="metadata.schema_version — which build wrote this file"
        />
      </div>

      {empty ? (
        <Appear className="dbb-banner dbb-banner-info">
          <Glyph name="info" size="sm" />
          <span>
            <strong>This graph is empty.</strong> The schema exists (version{' '}
            {profile.schemaVersion ?? '?'}) but no nodes or edges have been written — the database was
            created and never populated, or the last build failed before its first write.
          </span>
        </Appear>
      ) : null}

      <div className="dbb-graph-grids">
        <Histogram
          title="Node kinds"
          hint="nodes.kind — what the extractor recognised"
          rows={profile.nodeKinds}
          emptyNote="No nodes."
        />
        <Histogram
          title="Edge kinds"
          hint="edges.kind — CALLS, IMPORTS_FROM, INHERITS, REFERENCES…"
          rows={profile.edgeKinds}
          emptyNote="No edges."
        />
      </div>

      {meta.length ? (
        <section className="dbb-meta">
          <h3>Build metadata</h3>
          <dl>
            {meta.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <footer className="dbb-vector-foot">
        <RebuildControl service={service} label="code graph" onCompleted={onRefreshProfile} />
      </footer>
    </div>
  )
}
