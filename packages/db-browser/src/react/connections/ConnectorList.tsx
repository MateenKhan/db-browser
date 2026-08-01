/**
 * Drivers: what is installed, what is available, and a real download.
 *
 * An uninstalled connector is listed, not hidden. "Which databases can this
 * tool talk to" is a question the panel should answer before you have installed
 * anything — and hiding what is missing turns "Postgres is not in the list"
 * into an unanswerable question.
 *
 * ## This tab is the overview, not the only route
 *
 * It used to be the *only* place a driver could be downloaded, which meant the
 * New-connection flow dead-ended in prose telling you to come here. It no
 * longer does: the engine picker offers the same download inline (see
 * `EnginePicker.tsx`), over the same {@link useConnectorInstall} state, so
 * pressing Download in either place is the same job and both surfaces show its
 * progress. This tab remains the place to survey the whole set.
 */

import { Glyph } from '../iconography.js'
import { Appear } from '../motion.js'
import { InstallControl, InstallError, InstallProgressBar } from './InstallControl.js'
import { connectorAvailability } from './types.js'
import type { ConnectorStatus } from './types.js'
import type { ConnectorInstalls } from './useConnectorInstall.js'

export interface ConnectorListProps {
  connectors: ConnectorStatus[]
  loading?: boolean
  /** The shared install machinery, owned by the manager. */
  installs: ConnectorInstalls
  /** Start a new connection with this connector. */
  onUse?: (connectorId: string) => void
  /** Shown instead of the list when the connector route could not be read. */
  error?: string | null
}

export function ConnectorList({ connectors, loading, installs, onUse, error }: ConnectorListProps) {
  if (error) {
    return (
      <div className="dbb-banner dbb-banner-error" role="alert">
        <Glyph name="failure" size="sm" />
        {error}
      </div>
    )
  }
  if (loading && !connectors.length) {
    return <p className="dbb-muted dbb-pad">Reading the connector registry…</p>
  }
  if (!connectors.length) {
    return <p className="dbb-muted dbb-pad">This server reports no connectors.</p>
  }

  return (
    <ul className="dbb-connector-list">
      {connectors.map((c, i) => {
        const state = installs.stateOf(c.descriptor.id)
        const { state: availability, reason } = connectorAvailability(c)
        return (
          <Appear as="li" key={c.descriptor.id} index={i} className="dbb-connector">
            <span className="dbb-connector-mark">
              <Glyph name={c.installed ? 'connectorInstalled' : 'connector'} size="lg" />
            </span>
            <span className="dbb-connector-body">
              <span className="dbb-connector-title">
                {c.descriptor.label}
                <span className="dbb-connector-dialect">{c.descriptor.dialect}</span>
                {c.installed ? (
                  <span className="dbb-badge dbb-badge-read">
                    installed{c.installedVersion ? ` ${c.installedVersion}` : ''}
                  </span>
                ) : (
                  <span className="dbb-badge dbb-badge-muted">not installed</span>
                )}
                {availability === 'unavailable' ? (
                  <span className="dbb-badge dbb-badge-muted">unsupported</span>
                ) : null}
              </span>
              {c.descriptor.description ? (
                <span className="dbb-connector-desc">{c.descriptor.description}</span>
              ) : null}
              <span className="dbb-connector-driver">
                {c.descriptor.driverPackage ? (
                  <>
                    <code>{c.descriptor.driverPackage}</code> {c.descriptor.driverRange}
                  </>
                ) : (
                  'built in — no driver to download'
                )}
                {c.descriptor.defaultPort ? ` · default port ${c.descriptor.defaultPort}` : ''}
              </span>
              {/* Two different facts, and an unsupported engine has both: the
                  server's own note (usually "not installed, run …") and the
                  reason installing it would not help. Showing only the first
                  sends the user off to run a command that changes nothing. */}
              {availability === 'unavailable' && reason ? (
                <span className="dbb-connector-error">
                  <Glyph name="failure" size="sm" />
                  {reason}
                </span>
              ) : null}
              {c.error ? (
                <span className="dbb-connector-driver">{c.error}</span>
              ) : null}

              <InstallProgressBar connector={c} state={state} />
              <InstallError state={state} />
            </span>

            <span className="dbb-connector-actions">
              {availability === 'ready' ? (
                onUse ? (
                  <button type="button" onClick={() => onUse(c.descriptor.id)}>
                    <Glyph name="add" size="sm" />
                    New connection
                  </button>
                ) : null
              ) : availability === 'installable' ? (
                <InstallControl
                  connector={c}
                  state={state}
                  label="Download"
                  onInstall={() => installs.install(c.descriptor.id)}
                />
              ) : null}
            </span>
          </Appear>
        )
      })}
    </ul>
  )
}
