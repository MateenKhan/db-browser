/**
 * Downloading a driver, as one behaviour shared by every place that offers it.
 *
 * A driver download is offered from **two** surfaces now — the Drivers tab, and
 * inline in the New-connection flow the moment you pick an engine whose driver
 * is missing. Being told to go to another tab to unblock the thing you just
 * clicked is the complaint this exists to answer, and the second surface must
 * not be a second implementation: two copies of "start a job, poll it, abort on
 * unmount" drift into one that leaks a poll loop and one that does not.
 *
 * So the job lifecycle lives here, keyed by connector id, and both surfaces
 * render {@link InstallControl} over the same state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { pollInstall } from './client.js'
import type { ConnectionsApi, InstallProgress } from './types.js'

export interface InstallState {
  progress: InstallProgress | null
  error: string | null
  /** True from the moment Download is pressed until the job settles. */
  busy: boolean
}

const IDLE: InstallState = { progress: null, error: null, busy: false }

export interface ConnectorInstalls {
  /** The job state for one connector. Never null — an untouched one is idle. */
  stateOf: (connectorId: string) => InstallState
  install: (connectorId: string) => void
  /** Drop a finished job's banner without touching the driver. */
  dismiss: (connectorId: string) => void
}

/**
 * @param onInstalled Called once a job finishes cleanly, so the caller can
 * re-read the connector list. It is **not** called on failure: a failed install
 * changed nothing, and re-reading would only replace the error the user needs
 * to read with an identical list.
 */
export function useConnectorInstall(api: ConnectionsApi, onInstalled: () => void): ConnectorInstalls {
  const [jobs, setJobs] = useState<Record<string, InstallState>>({})
  const aborts = useRef(new Map<string, AbortController>())

  useEffect(
    () => () => {
      for (const controller of aborts.current.values()) controller.abort()
      aborts.current.clear()
    },
    [],
  )

  const install = useCallback(
    (id: string) => {
      aborts.current.get(id)?.abort()
      const controller = new AbortController()
      aborts.current.set(id, controller)
      setJobs((j) => ({
        ...j,
        [id]: { progress: { phase: 'starting', percent: 0, done: false }, error: null, busy: true },
      }))
      void (async () => {
        try {
          const { jobId } = await api.installConnector(id, controller.signal)
          const final = await pollInstall(
            api,
            jobId,
            (p) => setJobs((j) => ({ ...j, [id]: { progress: p, error: null, busy: true } })),
            controller.signal,
          )
          if (final.error) {
            setJobs((j) => ({ ...j, [id]: { progress: final, error: final.error ?? 'Install failed', busy: false } }))
            return
          }
          setJobs((j) => ({ ...j, [id]: { progress: final, error: null, busy: false } }))
          onInstalled()
          // Leave the finished bar up for a beat so the completion is seen, then
          // drop it — the row now says "installed", which is the durable answer.
          setTimeout(() => setJobs((j) => ({ ...j, [id]: IDLE })), 1200)
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') return
          setJobs((j) => ({
            ...j,
            [id]: { progress: null, error: e instanceof Error ? e.message : 'Install failed', busy: false },
          }))
        } finally {
          aborts.current.delete(id)
        }
      })()
    },
    [api, onInstalled],
  )

  const dismiss = useCallback((id: string) => setJobs((j) => ({ ...j, [id]: IDLE })), [])
  const stateOf = useCallback((id: string) => jobs[id] ?? IDLE, [jobs])

  return { stateOf, install, dismiss }
}
