/**
 * The Download-driver button, its progress and its failure — one component,
 * rendered wherever a driver can be fetched.
 *
 * DBeaver's driver manager is the reference, and the part worth copying is not
 * the layout: it is that the download reports a **phase and a percentage**.
 * Fetching a driver is a multi-second, multi-step operation (resolve, download,
 * verify, link) and a spinner over it is indistinguishable from a hang. So the
 * progress the server streams is shown as it arrives — the phase name, the bar,
 * and the server's own message underneath.
 */

import { Glyph } from '../iconography.js'
import { motion, useMotionOK } from '../motion.js'
import type { ConnectorStatus } from './types.js'
import type { InstallState } from './useConnectorInstall.js'

export interface InstallControlProps {
  connector: ConnectorStatus
  state: InstallState
  onInstall: () => void
  /** Overrides the button's text. Default: "Download driver". */
  label?: string
}

export function InstallControl({ connector, state, onInstall, label }: InstallControlProps) {
  const { descriptor } = connector
  const busy = state.busy
  return (
    <button
      type="button"
      className="dbb-primary"
      onClick={onInstall}
      disabled={busy || !descriptor.driverPackage}
      title={
        descriptor.driverPackage
          ? `Download ${descriptor.driverPackage} ${descriptor.driverRange}`
          : 'This connector needs no driver'
      }
    >
      <Glyph name={busy ? 'busy' : 'install'} size="sm" spin={busy} tone="run" />
      {busy ? 'Downloading…' : (label ?? 'Download driver')}
    </button>
  )
}

/** The phase, the bar and the server's message. Rendered only while there is one. */
export function InstallProgressBar({ connector, state }: { connector: ConnectorStatus; state: InstallState }) {
  const ok = useMotionOK()
  const progress = state.progress
  if (!progress) return null
  const percent = Math.round(progress.percent)
  return (
    <span className="dbb-install">
      <span className="dbb-install-head">
        <span className="dbb-install-phase">{progress.phase}</span>
        <span className="dbb-install-pct">{percent}%</span>
      </span>
      <span
        className="dbb-progress"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Installing ${connector.descriptor.label}`}
      >
        {ok ? (
          <motion.span
            className="dbb-progress-fill dbb-progress-build"
            initial={false}
            animate={{ width: `${progress.percent}%` }}
            transition={{ duration: 0.25, ease: [0.2, 0, 0.13, 1] }}
          />
        ) : (
          <span className="dbb-progress-fill dbb-progress-build" style={{ width: `${progress.percent}%` }} />
        )}
      </span>
      {progress.message ? <span className="dbb-install-msg">{progress.message}</span> : null}
    </span>
  )
}

/** A failed install, in the server's own words. */
export function InstallError({ state }: { state: InstallState }) {
  if (!state.error) return null
  return (
    <span className="dbb-connector-error" role="alert">
      <Glyph name="failure" size="sm" />
      {state.error}
    </span>
  )
}
