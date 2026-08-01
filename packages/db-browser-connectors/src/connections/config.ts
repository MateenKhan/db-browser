/**
 * The shape a stored connection has, and the validation that turns untrusted
 * JSON into it.
 *
 * ## Why secrets are a separate map, not just some fields
 *
 * `StoredConnection.values` holds everything the API may return.
 * `StoredConnection.secrets` holds the ciphertext of everything it may not.
 * They are separate *containers*, not a flag on a field, because the
 * write-only property then holds by construction: the serialiser that answers
 * `GET /api/connections` returns `values` and a `Set<string>` of secret keys —
 * it does not have the plaintext to leak even if it wanted to. A single map
 * with a `secret: true` marker would put the plaintext one forgotten filter
 * away from a response body, and that filter would be a line of code somebody
 * eventually refactors.
 *
 * Only `ResolvedConnectionConfig` — produced at connect time, held in memory,
 * never serialised — carries decrypted secrets.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'
import type { ConnectorDescriptor, EngineId } from '../types.js'

/** A connection as it sits in the store. `secrets` values are ciphertext. */
export interface StoredConnection {
  id: string
  name: string
  engine: EngineId
  /** Non-secret field values, keyed by `ConnectionField.key`. */
  values: Record<string, string | number | boolean>
  /** Ciphertext, keyed by `ConnectionField.key`. Never leaves this process. */
  secrets: Record<string, string>
  readOnly: boolean
  createdAt: string
  updatedAt: string
}

/**
 * A connection as the API returns it.
 *
 * Note what is *absent*: there is no `secrets` field at all, encrypted or
 * otherwise. `secretsSet` says which secrets exist, which is everything a
 * form needs to render "Password: ••••• (set) [Replace]" — and is the most a
 * caller is ever told.
 */
export interface PublicConnection {
  id: string
  name: string
  engine: EngineId
  values: Record<string, string | number | boolean>
  /** Keys of the secrets that have a value stored. Never the values. */
  secretsSet: string[]
  readOnly: boolean
  createdAt: string
  updatedAt: string
}

/** Decrypted, in-memory, connect-time only. Never serialised, never logged. */
export interface ResolvedConnectionConfig {
  id: string
  engine: EngineId
  values: Record<string, string | number | boolean>
  secrets: Record<string, string | undefined>
  readOnly: boolean
  statementTimeoutMs: number
  schemas?: string[]
}

/** Strip a stored connection down to what may cross the wire. */
export function toPublicConnection(stored: StoredConnection): PublicConnection {
  return {
    id: stored.id,
    name: stored.name,
    engine: stored.engine,
    values: { ...stored.values },
    secretsSet: Object.keys(stored.secrets).filter((k) => !!stored.secrets[k]),
    readOnly: stored.readOnly,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  }
}

export interface ConnectionInput {
  name?: unknown
  engine?: unknown
  values?: unknown
  readOnly?: unknown
}

export interface ValidatedInput {
  name: string
  values: Record<string, string | number | boolean>
  /** Plaintext secrets the caller supplied *this time*, to be encrypted. */
  secrets: Record<string, string>
  /** Secret keys the caller explicitly asked to clear. */
  clearedSecrets: string[]
  readOnly: boolean
}

/**
 * Validate a create/update body against the descriptor's declared fields.
 *
 * Field-driven rather than engine-branched, which is the whole point of a
 * declarative form spec: an unknown key is dropped rather than stored, a
 * missing required field is a 400 naming the field, and a value is coerced to
 * the field's `kind` so a string `"5432"` from a form does not become a string
 * port in a driver config.
 *
 * **A secret whose key is absent from the body is left alone**, not cleared.
 * That is what makes "edit the host without retyping the password" work, and
 * it is why clearing one needs the explicit `null`.
 */
export function validateConnectionInput(
  descriptor: ConnectorDescriptor,
  input: ConnectionInput,
  options: { partial?: boolean } = {},
): ValidatedInput {
  const raw = (input.values ?? {}) as Record<string, unknown>
  const values: Record<string, string | number | boolean> = {}
  const secrets: Record<string, string> = {}
  const clearedSecrets: string[] = []

  for (const field of descriptor.connectionFields) {
    const supplied = Object.prototype.hasOwnProperty.call(raw, field.key)
    const value = raw[field.key]

    if (field.secret) {
      if (!supplied) continue
      // `null` is "forget it"; `''` is a user clearing the box, which is the
      // same intent; anything else is a new value.
      if (value === null || value === '') {
        clearedSecrets.push(field.key)
        continue
      }
      if (typeof value !== 'string') {
        throw badRequest(`"${field.label}" must be a string`)
      }
      secrets[field.key] = value
      continue
    }

    if (!supplied || value === null || value === undefined || value === '') {
      if (field.default !== undefined) {
        values[field.key] = field.default
        continue
      }
      if (field.required && !options.partial) {
        throw badRequest(`"${field.label}" is required`)
      }
      continue
    }

    values[field.key] = coerce(field.kind, value, field.label)
  }

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : ''
  if (!name && !options.partial) throw badRequest('A connection name is required')
  if (name.length > 120) throw badRequest('The connection name is too long')

  // Default true, and it takes an explicit `false` to turn it off. `!== false`
  // rather than `=== true` so a body that omits the flag entirely — an older
  // client, a curl without it — gets the safe answer rather than the
  // permissive one.
  const readOnly =
    input.readOnly === undefined
      ? readOnlyFromValues(values)
      : input.readOnly !== false

  return { name, values, secrets, clearedSecrets, readOnly }
}

/**
 * The `readOnly` connection field and the top-level flag are the same switch
 * shown two ways (in the form, and on the connection). The form wins when it
 * is present, because that is what the user just touched.
 */
function readOnlyFromValues(values: Record<string, string | number | boolean>): boolean {
  return values.readOnly === undefined ? true : values.readOnly !== false
}

function coerce(
  kind: string,
  value: unknown,
  label: string,
): string | number | boolean {
  switch (kind) {
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n)) throw badRequest(`"${label}" must be a number`)
      return n
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 'true') return true
      if (value === 'false') return false
      throw badRequest(`"${label}" must be true or false`)
    default: {
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      throw badRequest(`"${label}" must be text`)
    }
  }
}

function badRequest(message: string): DbBrowserError {
  return new DbBrowserError('INVALID_CONNECTION', message)
}
