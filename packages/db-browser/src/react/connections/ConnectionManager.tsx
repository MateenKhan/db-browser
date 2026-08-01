/**
 * The connection manager: add, edit, remove and test connections, and download
 * the drivers they need — replacing "edit `.env` and restart the server".
 *
 * ## Layout
 *
 * Two tabs, not two panes side by side. Connections and connectors are read at
 * different times — you set a driver up once and then never look at it again —
 * and a permanently visible driver list would cost half the dialog to something
 * that is usually finished business.
 *
 * ## New connection never dead-ends
 *
 * "New connection" opens a picker listing **every** engine the server knows,
 * not only the ones whose driver happens to be present, and picking one whose
 * driver is missing offers the download inline, above the form, over the same
 * job state the Drivers tab uses. What you have typed survives the install,
 * because the form is never unmounted for it. The Drivers tab is still the
 * overview; it is no longer the only route.
 *
 * ## Two routes, two independent failures
 *
 * `listConnections` and `listConnectors` are read together but settled
 * **separately**. Under `Promise.all` a failure of either produced one banner
 * and *two* empty lists — which is how a connector route that answered fine
 * could still render "Drivers 0/0". Each list now reports its own error and
 * keeps whatever the other route returned.
 *
 * ## Editing may legitimately be off
 *
 * A browser tool that can add a connection can reach anything the *server* can
 * reach, so the server only enables editing on a loopback bind. When it says
 * editing is off this dialog shows the reason and the (read-only) list, and
 * renders no form at all: a form whose submit is guaranteed to 403 teaches the
 * user that the tool is broken rather than that the deployment is deliberate.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog } from '../Dialog.js'
import { Glyph } from '../iconography.js'
import { Appear } from '../motion.js'
import { ConnectionForm } from './ConnectionForm.js'
import { ConnectorList } from './ConnectorList.js'
import { EnginePicker } from './EnginePicker.js'
import { InstallControl, InstallError, InstallProgressBar } from './InstallControl.js'
import { connectorAvailability, describeTest } from './types.js'
import { useConnectorInstall } from './useConnectorInstall.js'
import type {
  ConnectionDraft,
  ConnectionsApi,
  ConnectorStatus,
  EditPolicy,
  StoredConnection,
  TestResult,
} from './types.js'

export interface ConnectionManagerProps {
  open: boolean
  onClose: () => void
  api: ConnectionsApi
  /** Called after a create / update / delete, so the host can re-read sources. */
  onChanged?: () => void
  /** Switch the browser to this connection. */
  onOpenConnection?: (connection: StoredConnection) => void
  /** The connection currently being browsed, marked in the list. */
  activeConnectionId?: string | null
}

type Tab = 'connections' | 'connectors'
/** `connectorId: null` is the engine picker — the first step of "new". */
type Editing = { mode: 'new'; connectorId: string | null } | { mode: 'edit'; id: string } | null

const errorText = (e: unknown, fallback: string): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : fallback

export function ConnectionManager({
  open,
  onClose,
  api,
  onChanged,
  onOpenConnection,
  activeConnectionId,
}: ConnectionManagerProps) {
  const [tab, setTab] = useState<Tab>('connections')
  const [connections, setConnections] = useState<StoredConnection[]>([])
  const [policy, setPolicy] = useState<EditPolicy>({ editable: true })
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const [connectorsError, setConnectorsError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [formStatus, setFormStatus] = useState<React.ReactNode>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    const [snapshot, drivers] = await Promise.allSettled([api.listConnections(), api.listConnectors()])

    if (snapshot.status === 'fulfilled') {
      setConnections(snapshot.value.connections)
      setConnectionsError(null)
    } else {
      setConnectionsError(errorText(snapshot.reason, 'Could not read the saved connections.'))
    }

    if (drivers.status === 'fulfilled') {
      setConnectors(drivers.value.connectors)
      setConnectorsError(null)
    } else {
      // Loud, and specifically about the drivers: an unreadable connector
      // response used to render as a confident, wrong "0/0".
      setConnectorsError(errorText(drivers.reason, 'Could not read the driver list.'))
    }

    // Either route may carry the gate, and editing is only on when both agree —
    // a panel that offers "New connection" and then 403s on save is worse than
    // one that explains up front. A route that failed has no opinion.
    const policies = [
      snapshot.status === 'fulfilled' ? snapshot.value.policy : null,
      drivers.status === 'fulfilled' ? drivers.value.policy : null,
    ].filter((p): p is EditPolicy => p !== null)
    setPolicy(policies.find((p) => !p.editable) ?? policies[0] ?? { editable: true })

    setLoading(false)
  }, [api])

  useEffect(() => {
    if (open) void reload()
  }, [open, reload])

  useEffect(() => {
    if (!open) {
      setEditing(null)
      setFormStatus(null)
    }
  }, [open])

  const installs = useConnectorInstall(
    api,
    // Re-read after an install so the picked engine flips to "installed" and
    // the form's gate opens — in place, without unmounting the form.
    useCallback(() => void reload(), [reload]),
  )

  const installedCount = useMemo(() => connectors.filter((c) => c.installed).length, [connectors])

  const connectorOf = useCallback(
    (id: string) => connectors.find((c) => c.descriptor.id === id) ?? null,
    [connectors],
  )

  const editTarget = useMemo(() => {
    if (editing?.mode !== 'edit') return null
    return connections.find((c) => c.id === editing.id) ?? null
  }, [editing, connections])

  const editConnector = useMemo(() => {
    if (!editing) return null
    if (editing.mode === 'new') return editing.connectorId ? connectorOf(editing.connectorId) : null
    return editTarget ? connectorOf(editTarget.engine) : null
  }, [editing, editTarget, connectorOf])

  /** The driver gate for the engine currently in the form. */
  const formGate = useMemo(() => {
    if (!editConnector) return null
    const { state, reason } = connectorAvailability(editConnector)
    return { status: editConnector, state, reason }
  }, [editConnector])

  const driverMissing = formGate ? formGate.state !== 'ready' : false

  const save = useCallback(
    async (draft: ConnectionDraft) => {
      setSaving(true)
      setFormStatus(null)
      try {
        if (draft.id) await api.updateConnection(draft.id, draft)
        else await api.createConnection(draft)
        setEditing(null)
        await reload()
        onChanged?.()
      } catch (e) {
        setFormStatus(
          <p className="dbb-form-error" role="alert">
            <Glyph name="failure" size="sm" /> {errorText(e, 'Could not save')}
          </p>,
        )
      } finally {
        setSaving(false)
      }
    },
    [api, reload, onChanged],
  )

  const testSaved = useCallback(
    async (id: string) => {
      setTesting(id)
      try {
        const result = await api.testConnection(id)
        setResults((r) => ({ ...r, [id]: result }))
      } catch (e) {
        setResults((r) => ({ ...r, [id]: { ok: false, error: errorText(e, 'Test failed') } }))
      } finally {
        setTesting(null)
      }
    },
    [api],
  )

  const testDraft = useCallback(
    async (draft: ConnectionDraft) => {
      if (!api.testDraft) return
      setTesting('draft')
      setFormStatus(null)
      try {
        const result = await api.testDraft(draft)
        setFormStatus(<TestLine result={result} />)
      } catch (e) {
        setFormStatus(<TestLine result={{ ok: false, error: errorText(e, 'Test failed') }} />)
      } finally {
        setTesting(null)
      }
    },
    [api],
  )

  const remove = useCallback(
    async (c: StoredConnection) => {
      // A connection is configuration, not data: removing it deletes nothing in
      // the database it points at. One confirm is proportionate; a typed-name
      // ceremony would not be.
      if (!window.confirm(`Remove the connection “${c.name}”? The database itself is untouched.`)) return
      try {
        await api.deleteConnection(c.id)
        await reload()
        onChanged?.()
      } catch (e) {
        setConnectionsError(errorText(e, 'Could not remove the connection'))
      }
    },
    [api, reload, onChanged],
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connections"
      subtitle={api.describe?.() ? <code>{api.describe()}</code> : undefined}
      size="lg"
      className="dbb-conn-manager"
    >
      <div className="dbb-seg" role="tablist" aria-label="Connection manager sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'connections'}
          className={tab === 'connections' ? 'dbb-seg-btn dbb-seg-on' : 'dbb-seg-btn'}
          onClick={() => setTab('connections')}
        >
          <Glyph name="connection" size="sm" />
          Connections
          <span className="dbb-seg-count">{connectionsError ? '—' : connections.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'connectors'}
          className={tab === 'connectors' ? 'dbb-seg-btn dbb-seg-on' : 'dbb-seg-btn'}
          onClick={() => setTab('connectors')}
        >
          <Glyph name="connector" size="sm" />
          Drivers
          {/* An em dash, not "0/0": a count this client could not read must not
              be printed as a number the user will believe. */}
          <span className="dbb-seg-count">
            {connectorsError ? '—' : `${installedCount}/${connectors.length}`}
          </span>
        </button>
      </div>

      {connectionsError ? (
        <div className="dbb-banner dbb-banner-error" role="alert">
          <Glyph name="failure" size="sm" />
          {connectionsError}
        </div>
      ) : null}
      {connectorsError && tab !== 'connectors' ? (
        <div className="dbb-banner dbb-banner-error" role="alert">
          <Glyph name="failure" size="sm" />
          {connectorsError}
        </div>
      ) : null}

      {!policy.editable ? (
        <div className="dbb-banner dbb-banner-info">
          <Glyph name="readOnly" size="sm" />
          <span>
            <strong>Editing is disabled on this server.</strong>{' '}
            {policy.reason ??
              'Connection editing is only enabled when the server is bound to loopback.'}
          </span>
        </div>
      ) : null}

      {tab === 'connectors' ? (
        <ConnectorList
          connectors={connectors}
          loading={loading}
          error={connectorsError}
          installs={installs}
          onUse={
            policy.editable
              ? (connectorId) => {
                  setTab('connections')
                  setEditing({ mode: 'new', connectorId })
                }
              : undefined
          }
        />
      ) : editing?.mode === 'new' && !editing.connectorId ? (
        <EnginePicker
          connectors={connectors}
          loading={loading}
          error={connectorsError}
          onPick={(connectorId) => setEditing({ mode: 'new', connectorId })}
          onCancel={() => setEditing(null)}
        />
      ) : editing && editConnector ? (
        <>
          {formGate && driverMissing ? (
            <div className="dbb-driver-gate">
              <div className="dbb-driver-gate-head">
                <Glyph name={formGate.state === 'installable' ? 'install' : 'failure'} size="md" />
                <span>
                  <strong>
                    {formGate.state === 'installable'
                      ? `The ${editConnector.descriptor.label} driver is not installed yet.`
                      : `${editConnector.descriptor.label} is unavailable on this server.`}
                  </strong>{' '}
                  {formGate.state === 'installable'
                    ? 'Download it here — the form stays as you left it, and saving unlocks the moment it lands.'
                    : (formGate.reason ?? '')}
                </span>
                {formGate.state === 'installable' ? (
                  <InstallControl
                    connector={editConnector}
                    state={installs.stateOf(editConnector.descriptor.id)}
                    onInstall={() => installs.install(editConnector.descriptor.id)}
                  />
                ) : null}
              </div>
              <InstallProgressBar
                connector={editConnector}
                state={installs.stateOf(editConnector.descriptor.id)}
              />
              <InstallError state={installs.stateOf(editConnector.descriptor.id)} />
            </div>
          ) : null}
          <ConnectionForm
            connector={editConnector.descriptor}
            existing={editTarget}
            disabled={!policy.editable}
            submitBlockedReason={
              driverMissing
                ? formGate?.state === 'installable'
                  ? `Download the ${editConnector.descriptor.label} driver above to save this connection.`
                  : (formGate?.reason ?? 'This engine is unavailable on this server.')
                : undefined
            }
            saving={saving}
            testing={testing === 'draft'}
            onSubmit={save}
            onCancel={() => {
              setEditing(null)
              setFormStatus(null)
            }}
            onBack={editing.mode === 'new' ? () => setEditing({ mode: 'new', connectorId: null }) : undefined}
            onTest={api.testDraft ? testDraft : undefined}
            status={formStatus}
          />
        </>
      ) : (
        <>
          <ul className="dbb-conn-list">
            {connections.map((c, i) => {
              const descriptor = connectorOf(c.engine)?.descriptor ?? null
              const result = results[c.id]
              return (
                <Appear as="li" key={c.id} index={i} className="dbb-conn-item">
                  <span className="dbb-conn-mark">
                    <Glyph
                      name={c.id === activeConnectionId ? 'connection' : 'connectionOff'}
                      size="lg"
                    />
                  </span>
                  <span className="dbb-conn-body">
                    <span className="dbb-conn-title">
                      {c.name}
                      {c.id === activeConnectionId ? (
                        <span className="dbb-badge dbb-badge-read">open</span>
                      ) : null}
                      {c.readOnly ? <span className="dbb-badge dbb-badge-muted">read-only</span> : null}
                    </span>
                    <span className="dbb-conn-sub">
                      {descriptor?.label ?? c.engine}
                      {summarise(c) ? ` · ${summarise(c)}` : ''}
                    </span>
                    {result ? <TestLine result={result} /> : null}
                  </span>
                  <span className="dbb-conn-actions">
                    <button
                      type="button"
                      onClick={() => void testSaved(c.id)}
                      disabled={testing === c.id}
                      title="Open a connection and close it again"
                    >
                      <Glyph name={testing === c.id ? 'busy' : 'connection'} size="sm" spin={testing === c.id} />
                      {testing === c.id ? 'Testing…' : 'Test'}
                    </button>
                    {onOpenConnection ? (
                      <button type="button" onClick={() => onOpenConnection(c)}>
                        <Glyph name="database" size="sm" />
                        Open
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="dbb-icon-btn"
                      onClick={() => setEditing({ mode: 'edit', id: c.id })}
                      disabled={!policy.editable}
                      aria-label={`Edit ${c.name}`}
                      title="Edit"
                    >
                      <Glyph name="edit" size="sm" />
                    </button>
                    <button
                      type="button"
                      className="dbb-icon-btn"
                      onClick={() => void remove(c)}
                      disabled={!policy.editable}
                      aria-label={`Remove ${c.name}`}
                      title="Remove"
                    >
                      <Glyph name="remove" size="sm" />
                    </button>
                  </span>
                </Appear>
              )
            })}
          </ul>

          {!connections.length && !loading && !connectionsError ? (
            <p className="dbb-muted dbb-pad">
              No connections yet. {policy.editable ? 'Add one below.' : ''}
            </p>
          ) : null}

          {policy.editable ? (
            <div className="dbb-conn-new">
              {/* Always enabled. Whether a driver is installed is a question for
                  the next screen, which can answer it *and* fix it — it is not a
                  reason to refuse the click. */}
              <button
                type="button"
                className="dbb-primary"
                onClick={() => setEditing({ mode: 'new', connectorId: null })}
              >
                <Glyph name="add" size="sm" />
                New connection
              </button>
              <span className="dbb-muted">
                {connectorsError
                  ? 'The driver list could not be read — the engine picker will show the error.'
                  : `${connectors.length} engine${connectors.length === 1 ? '' : 's'}, ${installedCount} ready. Missing drivers download from the picker.`}
              </span>
            </div>
          ) : null}
        </>
      )}
    </Dialog>
  )
}

/** A one-line summary of where a connection points, from its non-secret values. */
function summarise(c: StoredConnection): string {
  const v = c.values ?? {}
  const host = v.host ?? v.server
  const port = v.port
  const database = v.database ?? v.db
  const file = v.file ?? v.filename ?? v.path
  if (file) return String(file)
  if (host) return `${host}${port ? `:${port}` : ''}${database ? `/${database}` : ''}`
  if (database) return String(database)
  return ''
}

function TestLine({ result }: { result: TestResult }) {
  const { text, ms } = describeTest(result)
  return (
    <span className={result.ok ? 'dbb-test-ok' : 'dbb-test-fail'} role="status">
      <Glyph name={result.ok ? 'success' : 'failure'} size="sm" />
      {text}
      {ms !== null ? <span className="dbb-muted"> · {Math.round(ms)} ms</span> : null}
    </span>
  )
}
