/**
 * The rebuild button and its progress readout.
 *
 * **This control only ever renders for a vector store or a code graph.** A
 * relational database has nothing to rebuild, and a "Rebuild index" button next
 * to a production `customer` table is an invitation to find out what it does.
 * `DbBrowser` decides; this component is never mounted in relational mode.
 *
 * A spinner alone would be wrong here. A build runs for minutes across four
 * phases with wildly different costs, so "working…" gives the user no way to
 * tell progress from a hang. The bar therefore shows a **real percentage**, the
 * **current phase**, and **processed/total** — all three, because a percentage
 * with no counts hides a total that jumped, and counts with no phase hide the
 * fact that the slow part has not started yet.
 */

import { useEffect, useRef } from 'react'
import { Glyph } from './iconography.js'
import { motion, useMotionOK } from './motion.js'
import { useRebuildJob } from './useRebuildJob.js'
import type { RebuildPhase, VectorService } from '../types.js'

export interface RebuildControlProps {
  /** Null when no index service is configured — the button explains itself. */
  service: VectorService | null
  /** What is being rebuilt, for the button label. */
  label?: string
  /** Called once a build finishes successfully, so stats can be re-read. */
  onCompleted?: () => void
}

/**
 * Phase order and labels. Shown as a stepper so the user can see *which* stage
 * is running and how many are left — a percentage alone cannot express that
 * `embed` is about to take ninety times longer than `scan` did.
 */
const PHASES: Array<{ id: RebuildPhase; label: string; hint: string }> = [
  { id: 'scan', label: 'Scan', hint: 'walking the repository for files to index' },
  { id: 'chunk', label: 'Chunk', hint: 'splitting files into symbol-sized pieces' },
  { id: 'embed', label: 'Embed', hint: 'calling the embedding model — the slow phase' },
  { id: 'write', label: 'Write', hint: 'writing vectors into the store' },
]

function phaseIndex(phase: RebuildPhase): number {
  const i = PHASES.findIndex((p) => p.id === phase)
  if (i >= 0) return i
  return phase === 'done' ? PHASES.length : -1
}

export function RebuildControl({ service, label = 'index', onCompleted }: RebuildControlProps) {
  const state = useRebuildJob(service)
  const motionOK = useMotionOK()
  const job = state.job
  const succeeded = job?.status === 'succeeded'

  // Re-read the stats when a build finishes — the chunk count and `built_at`
  // in the header are now wrong. Keyed on the job *id* so this fires once per
  // build, not once per poll that happens to arrive after it succeeded.
  const notified = useRef<string | null>(null)
  useEffect(() => {
    if (!succeeded || !job || notified.current === job.id) return
    notified.current = job.id
    onCompleted?.()
  }, [succeeded, job, onCompleted])

  if (!service) {
    return (
      <div className="dbb-rebuild dbb-rebuild-unavailable">
        <button type="button" disabled title="No index service is configured for this source">
          <Glyph name="unavailable" size="sm" />
          Rebuild {label}
        </button>
        <span className="dbb-muted">
          No index service configured — browsing is read-only.
        </span>
      </div>
    )
  }

  const active = phaseIndex(job?.phase ?? 'queued')

  return (
    <div className="dbb-rebuild">
      <div className="dbb-rebuild-bar">
        <button
          type="button"
          className="dbb-primary"
          onClick={state.start}
          // Disabled for the whole life of a build, not just the request: a
          // second POST would start a second indexer over the same file.
          disabled={state.running}
          title={
            state.running
              ? 'A build is already running — starting another would index the same files twice'
              : `Re-index and rewrite the ${label}`
          }
        >
          <Glyph name={state.running ? 'busy' : 'rebuild'} size="sm" spin={state.running} tone="run" />
          {state.starting ? 'Starting…' : state.running ? 'Rebuilding…' : `Rebuild ${label}`}
        </button>

        {job && state.running ? (
          <span className="dbb-rebuild-pct" aria-live="polite">
            {job.percent.toFixed(job.percent < 10 ? 1 : 0)}%
          </span>
        ) : null}

        {job && job.total > 0 ? (
          <span className="dbb-muted dbb-rebuild-counts">
            <Glyph name="rows" size="sm" />
            {job.processed.toLocaleString()} / {job.total.toLocaleString()}
          </span>
        ) : null}

        {succeeded ? (
          <span className="dbb-badge dbb-badge-read">
            <Glyph name="success" size="sm" /> build finished
          </span>
        ) : null}

        {!state.running && (succeeded || job?.status === 'failed') ? (
          <button type="button" className="dbb-link" onClick={state.dismiss}>
            dismiss
          </button>
        ) : null}
      </div>

      {state.running ? (
        <>
          <div
            className="dbb-progress"
            role="progressbar"
            aria-valuenow={Math.round(job?.percent ?? 0)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Rebuilding the ${label}`}
          >
            {motionOK ? (
              <motion.div
                className="dbb-progress-fill"
                initial={false}
                animate={{ width: `${job?.percent ?? 0}%` }}
                transition={{ duration: 0.3, ease: [0.2, 0, 0.13, 1] }}
              />
            ) : (
              <div className="dbb-progress-fill" style={{ width: `${job?.percent ?? 0}%` }} />
            )}
          </div>
          <ol className="dbb-phases">
            {PHASES.map((p, i) => (
              <li
                key={p.id}
                className={
                  i < active
                    ? 'dbb-phase dbb-phase-done'
                    : i === active
                      ? 'dbb-phase dbb-phase-active'
                      : 'dbb-phase'
                }
                title={p.hint}
              >
                {p.label}
              </li>
            ))}
          </ol>
          {job?.message ? <div className="dbb-rebuild-msg">{job.message}</div> : null}
        </>
      ) : null}

      {/* The server's own words. A build fails for reasons only it knows —
          "no API key", "rate limited", "repo path does not exist" — and
          replacing that with a generic string throws away the fix. */}
      {state.error ? (
        <div className="dbb-banner dbb-banner-error" role="alert">
          <Glyph name="failure" size="sm" />
          <span>
            <strong>Rebuild failed.</strong> {state.error}
          </span>
        </div>
      ) : null}
    </div>
  )
}
