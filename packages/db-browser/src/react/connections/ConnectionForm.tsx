/**
 * The connection form — **generated entirely from
 * `ConnectorDescriptor.connectionFields`.**
 *
 * There is not one `if (connectorId === …)` in this file, and there must never
 * be: the reason the server ships field metadata is so that adding MySQL is a
 * descriptor, not a React component. If a field cannot be rendered from its
 * `kind`, the fix is a new `kind` in the contract — shared by every engine —
 * rather than a special case here.
 *
 * ## Two field kinds that are not what they look like
 *
 * - **`file`** renders a *text* input, not `<input type="file">`. The path
 *   names a file on the **server**, and a browser file picker cannot produce a
 *   server path — it produces a sandboxed handle and a bare filename. Offering
 *   the picker would look friendlier and be unusable, so the input is a path
 *   with a hint saying whose filesystem it is.
 * - **`password`** (and any field marked `secret`) is write-only. It renders as
 *   "set" / "not set" plus an empty input: typing replaces the stored value,
 *   leaving it empty keeps it. Clearing is a separate, explicit button, because
 *   "I did not retype my password" and "I want no password" are different
 *   intentions and a blank field cannot mean both.
 */

import { useEffect, useMemo, useState } from 'react'
import { Glyph } from '../iconography.js'
import { Appear } from '../motion.js'
import type {
  ConnectionDraft,
  ConnectionField,
  ConnectionValues,
  ConnectorDescriptor,
  StoredConnection,
} from './types.js'

export interface ConnectionFormProps {
  connector: ConnectorDescriptor
  /** Editing an existing connection, or null to create one. */
  existing: StoredConnection | null
  disabled?: boolean
  onSubmit: (draft: ConnectionDraft) => void
  onCancel: () => void
  /** Back to the engine picker. Absent when there is nothing to go back to. */
  onBack?: () => void
  /**
   * Why Save and Test cannot fire *yet* — a missing driver, typically, which is
   * being downloaded from a banner above this form. Distinct from `disabled`:
   * the fields stay live, so what you type survives the fix.
   */
  submitBlockedReason?: string
  /** Rendered under the actions: the test result, the save error. */
  status?: React.ReactNode
  onTest?: (draft: ConnectionDraft) => void
  testing?: boolean
  saving?: boolean
}

/** Every field's starting value: the stored one, else the declared default. */
function initialValues(fields: ConnectionField[], existing: StoredConnection | null): ConnectionValues {
  const out: ConnectionValues = {}
  for (const f of fields) {
    if (isSecret(f)) continue
    const stored = existing?.values?.[f.key]
    if (stored !== undefined) out[f.key] = stored
    else if (f.default !== undefined) out[f.key] = f.default
    else out[f.key] = f.kind === 'boolean' ? false : ''
  }
  return out
}

const isSecret = (f: ConnectionField): boolean => f.secret === true || f.kind === 'password'

export function ConnectionForm({
  connector,
  existing,
  disabled,
  onSubmit,
  onCancel,
  onBack,
  submitBlockedReason,
  status,
  onTest,
  testing,
  saving,
}: ConnectionFormProps) {
  const fields = connector.connectionFields
  const [label, setLabel] = useState(existing?.name ?? '')
  const [values, setValues] = useState<ConnectionValues>(() => initialValues(fields, existing))
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [cleared, setCleared] = useState<Record<string, boolean>>({})
  const [touched, setTouched] = useState(false)

  /**
   * What the form is *about*: this connection, on this engine, with these
   * fields. Re-seeding is keyed on this string rather than on the identity of
   * the `existing` object and the `fields` array — because both are rebuilt
   * every time the manager re-reads the server, and a driver download does
   * exactly that. Keyed on identity, finishing an install would silently blank
   * everything the user had typed while waiting for it, which is precisely the
   * "no losing what was typed" this flow promises.
   */
  const identity = `${existing?.id ?? 'new'}|${connector.id}|${fields.map((f) => f.key).join(',')}`

  // Re-seed when the *target* changes — the same form instance is reused for
  // "edit this one", "edit that one" and "new", and carrying a host name from
  // one connection into another is how a user overwrites the wrong database.
  useEffect(() => {
    setLabel(existing?.name ?? '')
    setValues(initialValues(fields, existing))
    setSecrets({})
    setCleared({})
    setTouched(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  const secretsSet = useMemo(() => new Set(existing?.secretsSet ?? []), [existing])

  const missing = useMemo(() => {
    const out: string[] = []
    if (!label.trim()) out.push('Name')
    for (const f of fields) {
      if (!f.required) continue
      if (isSecret(f)) {
        const alreadySet = secretsSet.has(f.key) && !cleared[f.key]
        if (!alreadySet && !secrets[f.key]) out.push(f.label)
        continue
      }
      const v = values[f.key]
      if (v === '' || v === undefined || v === null) out.push(f.label)
    }
    return out
  }, [fields, values, secrets, cleared, label, secretsSet])

  /**
   * Secrets are merged into `values`, under their own field key, because that
   * is what a secret *is* to the server: a field whose descriptor says so. The
   * three cases the server distinguishes are produced here:
   *
   *  - **absent** — the user did not touch it; the stored value survives;
   *  - **`''`** — the user pressed Clear; the stored value is removed;
   *  - **a string** — a replacement.
   */
  const draft = (): ConnectionDraft => {
    const payload: Record<string, string | number | boolean | null> = { ...values }
    for (const [k, v] of Object.entries(secrets)) if (v) payload[k] = v
    for (const k of Object.keys(cleared)) if (cleared[k] && !secrets[k]) payload[k] = ''
    return {
      id: existing?.id,
      name: label.trim(),
      engine: connector.id,
      values: payload,
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (missing.length || submitBlockedReason) return
    onSubmit(draft())
  }

  return (
    <form className="dbb-conn-form" onSubmit={submit}>
      <Appear index={0}>
        <label className="dbb-form-row">
          <span className="dbb-form-label">
            Name<span className="dbb-req" aria-hidden>*</span>
          </span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={`${connector.label} connection`}
            disabled={disabled}
            required
            aria-invalid={touched && !label.trim() ? true : undefined}
          />
          <span className="dbb-form-hint">
            A display label. It is the only thing about this connection the browser is ever told.
          </span>
        </label>
      </Appear>

      {fields.map((f, i) => (
        <Appear key={f.key} index={i + 1}>
          <Field
            field={f}
            value={values[f.key]}
            secretValue={secrets[f.key] ?? ''}
            secretStored={secretsSet.has(f.key) && !cleared[f.key]}
            disabled={disabled}
            invalid={touched && missing.includes(f.label)}
            onValue={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
            onSecret={(v) => {
              setSecrets((prev) => ({ ...prev, [f.key]: v }))
              if (v) setCleared((prev) => ({ ...prev, [f.key]: false }))
            }}
            onClearSecret={() => {
              setSecrets((prev) => ({ ...prev, [f.key]: '' }))
              setCleared((prev) => ({ ...prev, [f.key]: true }))
            }}
          />
        </Appear>
      ))}

      <CapabilityNote connector={connector} />

      {touched && missing.length ? (
        <p className="dbb-form-error" role="alert">
          Still needed: {missing.join(', ')}.
        </p>
      ) : null}

      {status}

      <div className="dbb-form-actions">
        {onBack ? (
          <button type="button" onClick={onBack} disabled={saving} title="Pick a different engine">
            <Glyph name="prev" size="sm" />
            Engines
          </button>
        ) : null}
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {onTest ? (
          <button
            type="button"
            onClick={() => {
              setTouched(true)
              if (!missing.length && !submitBlockedReason) onTest(draft())
            }}
            disabled={disabled || testing || saving || !!submitBlockedReason}
            title={submitBlockedReason ?? 'Open a connection with these settings and close it again'}
          >
            <Glyph name={testing ? 'busy' : 'connection'} size="sm" spin={testing} />
            {testing ? 'Testing…' : 'Test'}
          </button>
        ) : null}
        <button
          type="submit"
          className="dbb-primary"
          disabled={disabled || saving || !!submitBlockedReason}
          title={submitBlockedReason}
        >
          <Glyph name={saving ? 'busy' : 'success'} size="sm" spin={saving} tone="run" />
          {saving ? 'Saving…' : existing ? 'Save changes' : 'Add connection'}
        </button>
      </div>
      {submitBlockedReason ? (
        <p className="dbb-form-hint dbb-form-blocked" role="status">
          <Glyph name="info" size="sm" /> {submitBlockedReason}
        </p>
      ) : null}
    </form>
  )
}

/** What this engine can and cannot do, straight from the descriptor. */
function CapabilityNote({ connector }: { connector: ConnectorDescriptor }) {
  const caps = connector.capabilities
  const on = Object.entries(caps)
    .filter(([, v]) => v)
    .map(([k]) => k)
  if (!on.length) return null
  const LABELS: Record<string, string> = {
    schemas: 'schemas',
    transactions: 'transactions',
    keysetPagination: 'keyset paging',
    implicitRowId: 'implicit row id',
    readOnlySession: 'read-only sessions',
    multipleDatabases: 'multiple databases',
  }
  return (
    <p className="dbb-form-caps">
      <Glyph name="info" size="sm" />
      <span>
        {connector.label} supports {on.map((k) => LABELS[k] ?? k).join(', ')}. Driver:{' '}
        <code>{connector.driverPackage ?? 'built in'}</code>
        {connector.driverPackage ? ` ${connector.driverRange}` : ''}.
      </span>
    </p>
  )
}

interface FieldProps {
  field: ConnectionField
  value: string | number | boolean | undefined
  secretValue: string
  secretStored: boolean
  disabled?: boolean
  invalid?: boolean
  onValue: (v: string | number | boolean) => void
  onSecret: (v: string) => void
  onClearSecret: () => void
}

function Field({
  field,
  value,
  secretValue,
  secretStored,
  disabled,
  invalid,
  onValue,
  onSecret,
  onClearSecret,
}: FieldProps) {
  const required = field.required ? (
    <span className="dbb-req" aria-hidden>
      *
    </span>
  ) : null

  if (isSecret(field)) {
    return (
      <label className="dbb-form-row">
        <span className="dbb-form-label">
          {field.label}
          {required}
          <span className={secretStored ? 'dbb-secret-on' : 'dbb-secret-off'}>
            <Glyph name={secretStored ? 'readOnly' : 'unavailable'} size="sm" />
            {secretStored ? 'set' : 'not set'}
          </span>
        </span>
        <span className="dbb-secret-row">
          <input
            type="password"
            value={secretValue}
            autoComplete="new-password"
            onChange={(e) => onSecret(e.target.value)}
            placeholder={secretStored ? '••••••  (leave blank to keep)' : field.placeholder ?? ''}
            disabled={disabled}
            aria-invalid={invalid || undefined}
          />
          {secretStored ? (
            <button type="button" onClick={onClearSecret} disabled={disabled} title="Remove the stored value">
              Clear
            </button>
          ) : null}
        </span>
        <span className="dbb-form-hint">
          {field.help ?? 'Write-only. The server never sends it back, and it is never put in a URL.'}
        </span>
      </label>
    )
  }

  if (field.kind === 'boolean') {
    return (
      <label className="dbb-form-row dbb-form-row-inline">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onValue(e.target.checked)}
          disabled={disabled}
        />
        <span className="dbb-form-label">
          {field.label}
          {required}
        </span>
        {field.help ? <span className="dbb-form-hint">{field.help}</span> : null}
      </label>
    )
  }

  if (field.kind === 'select') {
    return (
      <label className="dbb-form-row">
        <span className="dbb-form-label">
          {field.label}
          {required}
        </span>
        <select
          value={String(value ?? '')}
          onChange={(e) => onValue(e.target.value)}
          disabled={disabled}
          aria-invalid={invalid || undefined}
        >
          {!field.required ? <option value="">(unset)</option> : null}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field.help ? <span className="dbb-form-hint">{field.help}</span> : null}
      </label>
    )
  }

  return (
    <label className="dbb-form-row">
      <span className="dbb-form-label">
        {field.label}
        {required}
      </span>
      <input
        type={field.kind === 'number' ? 'number' : 'text'}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => onValue(field.kind === 'number' ? e.target.valueAsNumber || '' : e.target.value)}
        placeholder={field.placeholder ?? ''}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        spellCheck={false}
      />
      {field.help ? <span className="dbb-form-hint">{field.help}</span> : null}
      {field.kind === 'file' ? (
        <span className="dbb-form-hint">
          A path on the <strong>server’s</strong> filesystem — not this machine’s.
        </span>
      ) : null}
    </label>
  )
}
