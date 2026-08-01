/**
 * Remembering an in-flight rebuild across a page reload.
 *
 * A build takes minutes. In that window the user will switch tabs, hot-reload
 * the dev server, or simply hit F5 — and a progress bar that starts over at
 * "not running" while the server is still working is worse than no progress
 * bar, because it invites a second build on top of the first.
 *
 * So the *job id* (never its progress — that is server truth, always re-read)
 * is written to `localStorage` under a key this package owns, and the UI
 * re-attaches by polling that id on mount. The record is dropped as soon as the
 * job reaches a terminal state, or if it is old enough that it cannot plausibly
 * still be running.
 */

export interface StoredRebuildJob {
  jobId: string
  /** `Date.now()` when the build was started from this browser. */
  startedAt: number
}

/**
 * After this long an unfinished record is discarded on read. It is a *garbage
 * collector*, not a timeout: the server is still the authority on whether the
 * job is running, and a status poll that says "running" is always believed.
 * This only stops a job id from a build that died weeks ago being polled
 * forever after the server forgot it.
 */
export const STALE_JOB_MS = 6 * 60 * 60 * 1000

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    // A sandboxed iframe throws on *access*, not just on use.
    return null
  }
}

const jobKey = (serviceId: string) => `dbb:${serviceId}:rebuild-job`

export function loadRebuildJob(serviceId: string, now = Date.now()): StoredRebuildJob | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(jobKey(serviceId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredRebuildJob>
    if (!parsed || typeof parsed.jobId !== 'string' || !parsed.jobId) return null
    const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
    if (now - startedAt > STALE_JOB_MS) {
      clearRebuildJob(serviceId)
      return null
    }
    return { jobId: parsed.jobId, startedAt }
  } catch {
    return null
  }
}

export function saveRebuildJob(serviceId: string, jobId: string, now = Date.now()): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(jobKey(serviceId), JSON.stringify({ jobId, startedAt: now } satisfies StoredRebuildJob))
  } catch {
    /* quota exceeded — losing the re-attach is survivable, failing is not */
  }
}

export function clearRebuildJob(serviceId: string): void {
  const s = storage()
  if (!s) return
  try {
    s.removeItem(jobKey(serviceId))
  } catch {
    /* ignore */
  }
}

/**
 * How often to poll, given how far along the build is.
 *
 * A tight loop for minutes is wasteful, and a slow loop makes the early phases
 * (which are fast) look frozen. Poll quickly while the numbers are moving in
 * the cheap phases and back off during `embed`, which is the long one and is
 * rate-limited by the model provider anyway.
 */
export function pollIntervalFor(phase: string): number {
  return phase === 'embed' ? 1500 : 700
}
