/**
 * Step one of "New connection": **which engine**, from all of them.
 *
 * ## The complaint this answers
 *
 * The flow used to offer only the engines whose driver was already installed,
 * and — when none were — a sentence telling you to open the Drivers tab and
 * come back. Being sent somewhere else to unblock the thing you just clicked is
 * the whole of the complaint: *"let me download drivers even from here."*
 *
 * So every engine the server knows is listed, and a missing driver is not a
 * dead end but a button. Picking an engine whose driver is absent opens the
 * form anyway, with the download offered inline above it — the descriptor
 * carries the field metadata whether or not the driver is on disk, so there is
 * nothing to wait for before you start typing.
 *
 * ## Three states, and only one of them is a wall
 *
 * `connectorAvailability()` (in `types.ts`, so the rule is stated once) sorts
 * every engine into ready / installable / unavailable. Only **unavailable** is
 * non-selectable — the server saying this build has no adapter for the engine,
 * which no download from this panel can change — and it says so in the server's
 * own words rather than being silently greyed out. "Not installed" is never a
 * wall.
 */

import { Glyph } from '../iconography.js'
import { Appear } from '../motion.js'
import { connectorAvailability } from './types.js'
import type { ConnectorStatus } from './types.js'

export interface EnginePickerProps {
  connectors: ConnectorStatus[]
  onPick: (connectorId: string) => void
  onCancel: () => void
  /** Shown when the connector route could not be read at all. */
  error?: string | null
  loading?: boolean
}

export function EnginePicker({ connectors, onPick, onCancel, error, loading }: EnginePickerProps) {
  const installed = connectors.filter((c) => c.installed).length

  return (
    <div className="dbb-engine-pick">
      <div className="dbb-engine-pick-head">
        <span className="dbb-form-label">
          <Glyph name="add" size="sm" /> New connection · choose an engine
        </span>
        <span className="dbb-muted">
          {connectors.length
            ? `${installed} of ${connectors.length} drivers installed. The rest can be downloaded from here.`
            : ''}
        </span>
      </div>

      {error ? (
        <div className="dbb-banner dbb-banner-error" role="alert">
          <Glyph name="failure" size="sm" />
          {error}
        </div>
      ) : null}

      {loading && !connectors.length ? <p className="dbb-muted dbb-pad">Reading the connector registry…</p> : null}
      {!loading && !connectors.length && !error ? (
        <p className="dbb-muted dbb-pad">This server reports no connectors.</p>
      ) : null}

      <ul className="dbb-engine-grid">
        {connectors.map((c, i) => {
          const { state, reason } = connectorAvailability(c)
          const blocked = state === 'unavailable'
          return (
            <Appear as="li" key={c.descriptor.id} index={Math.min(i, 10)}>
              <button
                type="button"
                className={blocked ? 'dbb-engine-card dbb-engine-card-off' : 'dbb-engine-card'}
                onClick={() => onPick(c.descriptor.id)}
                disabled={blocked}
                title={blocked ? reason : `Set up a ${c.descriptor.label} connection`}
                aria-describedby={blocked ? `dbb-engine-why-${c.descriptor.id}` : undefined}
              >
                <span className="dbb-engine-card-head">
                  <Glyph name={c.installed ? 'connectorInstalled' : 'connector'} size="lg" />
                  <span className="dbb-engine-card-name">{c.descriptor.label}</span>
                  {c.installed ? (
                    <span className="dbb-badge dbb-badge-read">installed</span>
                  ) : blocked ? (
                    <span className="dbb-badge dbb-badge-muted">unavailable</span>
                  ) : (
                    <span className="dbb-badge dbb-badge-muted">driver needed</span>
                  )}
                </span>
                <span className="dbb-engine-card-sub">
                  {c.descriptor.description ?? c.descriptor.dialect}
                </span>
                {blocked && reason ? (
                  <span className="dbb-engine-card-why" id={`dbb-engine-why-${c.descriptor.id}`}>
                    {reason}
                  </span>
                ) : !c.installed && c.descriptor.driverPackage ? (
                  <span className="dbb-engine-card-why">
                    <Glyph name="install" size="sm" />
                    Downloads <code>{c.descriptor.driverPackage}</code> when you pick it — you stay here.
                  </span>
                ) : null}
              </button>
            </Appear>
          )
        })}
      </ul>

      <div className="dbb-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
