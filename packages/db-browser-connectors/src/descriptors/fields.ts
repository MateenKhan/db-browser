/**
 * Reusable pieces of a connection form.
 *
 * Most engines ask the same five questions (host, port, database, user,
 * password) and differ only in the defaults and in one or two extras. Building
 * those five here means a new descriptor states its *differences*, and it
 * means a change to how passwords are handled — the `secret: true` flag that
 * makes a field write-only — happens in one place rather than in eight.
 */

import type { ConnectionField } from '../types.js'

export interface ServerFieldOptions {
  defaultPort: number
  /** `'Database'` for most, `'Service name'` for Oracle. */
  databaseLabel?: string
  databaseRequired?: boolean
  userLabel?: string
  userDefault?: string
  databaseDefault?: string
}

/**
 * The host/port/database/user/password block.
 *
 * `password` is the only `secret` field any built-in descriptor declares, and
 * it is declared here rather than per-engine so no descriptor can forget it.
 * A forgotten `secret: true` would mean the password is returned by
 * `GET /api/connections` — which is the single worst bug this file could have,
 * so the safe form is the shared one.
 */
export function serverFields(options: ServerFieldOptions): ConnectionField[] {
  return [
    {
      key: 'host',
      label: 'Host',
      kind: 'text',
      required: true,
      default: 'localhost',
      placeholder: 'localhost',
    },
    {
      key: 'port',
      label: 'Port',
      kind: 'number',
      required: true,
      default: options.defaultPort,
    },
    {
      key: 'database',
      label: options.databaseLabel ?? 'Database',
      kind: 'text',
      required: options.databaseRequired ?? true,
      ...(options.databaseDefault === undefined ? {} : { default: options.databaseDefault }),
    },
    {
      key: 'user',
      label: options.userLabel ?? 'User',
      kind: 'text',
      required: true,
      ...(options.userDefault === undefined ? {} : { default: options.userDefault }),
    },
    {
      key: 'password',
      label: 'Password',
      kind: 'password',
      required: false,
      secret: true,
      help: 'Stored on the server only. It is never returned by the API once saved.',
    },
  ]
}

/**
 * The read-only switch every connection has.
 *
 * Default **true**, everywhere, with no per-engine override. A database
 * browser that opens read-write by default is one misclick from an unqualified
 * `UPDATE`, and the cost of the other default is one checkbox.
 */
export const READ_ONLY_FIELD: ConnectionField = {
  key: 'readOnly',
  label: 'Read-only',
  kind: 'boolean',
  required: false,
  default: true,
  help: 'Blocks every write at the session level, not only in the SQL guard. Leave this on unless you mean to edit.',
}

/** TLS, for the engines whose drivers express it as a simple mode. */
export const SSL_MODE_FIELD: ConnectionField = {
  key: 'sslMode',
  label: 'TLS',
  kind: 'select',
  required: false,
  default: 'prefer',
  options: [
    { value: 'disable', label: 'Disabled' },
    { value: 'prefer', label: 'Preferred (fall back to plaintext)' },
    { value: 'require', label: 'Required (do not verify the certificate)' },
    { value: 'verify-full', label: 'Required, verify the certificate' },
  ],
  help: '“Required” encrypts but does not authenticate the server; only “verify” stops an active attacker.',
}

/** A path to a database file, for the file-backed engines. */
export function fileField(label: string, placeholder: string): ConnectionField {
  return {
    key: 'file',
    label,
    kind: 'file',
    required: true,
    placeholder,
    help: 'Resolved on the server. The path is never sent to the browser.',
  }
}
