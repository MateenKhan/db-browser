/**
 * Driving a rebuild that takes minutes.
 *
 * Four things make this harder than "call the endpoint and show a spinner",
 * and each one is a requirement rather than a nicety:
 *
 *  1. **It must not block the UI.** Everything here is a poll on a timer; no
 *     await ever sits in a render path, and the rest of the browser stays
 *     usable (you can read the stats, browse `chunk`, run SQL) while a build
 *     runs.
 *  2. **Progress must survive a re-render.** The poll loop lives in a ref-driven
 *     effect keyed only on the *service*, so a parent re-render — a keystroke
 *     in the search box, a table switch — does not restart it and does not
 *     reset the bar to zero.
 *  3. **It must survive a page reload.** The job id is persisted (see
 *     `vector/jobs.ts`); on mount the hook re-attaches to it and resumes
 *     polling. Progress itself is never persisted — it is server truth and is
 *     always re-read, so a reload can never show a stale percentage.
 *  4. **Failure must say what the server said.** `job.error` is rendered
 *     verbatim. "The build failed" is not a diagnosis.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { clearRebuildJob, loadRebuildJob, pollIntervalFor, saveRebuildJob } from '../vector/jobs.js'
import type { RebuildJob, VectorService } from '../types.js'

export interface RebuildState {
  /** The live job, or null when nothing is running and nothing just finished. */
  job: RebuildJob | null
  /** True while a build is in flight — the button is disabled on this. */
  running: boolean
  /** Why the last attempt failed: a start error, or the job's own error. */
  error: string | null
  /** True between "start" being clicked and the server answering. */
  starting: boolean
  start: () => void
  /** Clear a finished job's banner without touching the server. */
  dismiss: () => void
}

const message = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'The rebuild request failed'

export function useRebuildJob(service: VectorService | null | undefined): RebuildState {
  const [job, setJob] = useState<RebuildJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  /** The id currently being polled. A ref so changing it never re-renders. */
  const polling = useRef<string | null>(null)
  /** Bumped to (re)start the poll loop after a successful start. */
  const [attachNonce, setAttachNonce] = useState(0)
  const serviceId = service?.id ?? null

  // Re-attach on mount: if this browser started a build before the reload, the
  // server is very likely still running it.
  useEffect(() => {
    if (!serviceId) return
    const stored = loadRebuildJob(serviceId)
    if (stored) {
      polling.current = stored.jobId
      setAttachNonce((n) => n + 1)
    }
  }, [serviceId])

  // The poll loop. A self-rescheduling timeout rather than setInterval, so a
  // slow response can never queue up behind itself and hammer the server.
  useEffect(() => {
    const jobId = polling.current
    if (!service || !jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      if (cancelled) return
      try {
        const next = await service.rebuildStatus(jobId)
        if (cancelled) return
        setJob(next)
        if (next.status === 'running') {
          timer = setTimeout(tick, pollIntervalFor(next.phase))
          return
        }
        // Terminal. Stop polling and forget the id so a later mount does not
        // re-attach to a job that is already over.
        polling.current = null
        clearRebuildJob(service.id)
        if (next.status === 'failed') setError(next.error ?? 'The build failed')
      } catch (e) {
        if (cancelled) return
        // A transient poll failure is not a failed build — the build is
        // running in another process and does not care that one GET failed.
        // Keep polling, but say so, so a permanently-down service is visible.
        setError(message(e))
        timer = setTimeout(tick, 2000)
      }
    }
    void tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [service, attachNonce])

  const start = useCallback(() => {
    if (!service || starting || polling.current) return
    setStarting(true)
    setError(null)
    service
      .startRebuild()
      .then((started) => {
        polling.current = started.id
        saveRebuildJob(service.id, started.id)
        setJob(started)
        setAttachNonce((n) => n + 1)
      })
      .catch((e) => setError(message(e)))
      .finally(() => setStarting(false))
  }, [service, starting])

  const dismiss = useCallback(() => {
    if (polling.current) return // never hide a build that is still running
    setJob(null)
    setError(null)
  }, [])

  return {
    job,
    running: starting || job?.status === 'running',
    error,
    starting,
    start,
    dismiss,
  }
}
