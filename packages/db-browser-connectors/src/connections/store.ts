/**
 * The connection registry — server-owned, file-backed.
 *
 * ## Why the browser never holds this
 *
 * A connection is a host, a user and a password. Putting any of it in
 * `localStorage` means it is readable by every script on the origin, survives
 * in a browser profile that gets synced, and is one XSS away from being
 * exfiltrated wholesale. It also cannot work: the browser cannot open a TCP
 * socket to Postgres, so the *server* needs the credentials regardless — and
 * once the server needs them, a copy in the browser is a second attack surface
 * that buys nothing.
 *
 * So the store is a JSON file the server owns. Secrets in it are ciphertext
 * (`secretbox.ts`), and the only shape that ever crosses the wire is
 * `PublicConnection`, which has no secret field at all.
 *
 * ## Why a JSON file rather than SQLite
 *
 * The store holds tens of records, is read on startup and written on edit, and
 * has no query needs beyond "by id". A file that a human can open, read and
 * fix is worth more here than an index nobody will use — and it keeps this
 * package dependency-free, which is what lets it be imported by a server that
 * has no database driver installed at all.
 *
 * Writes are atomic (write a temp file, then rename), so an interrupted write
 * cannot leave a truncated store — losing every saved connection to a
 * mistimed Ctrl-C is not an acceptable failure mode for a file this small.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DbBrowserError } from '@jugaaadi/db-browser/core'
import { requireDescriptor } from '../registry.js'
import type { ConnectorDescriptor, EngineId } from '../types.js'
import { createSecretBox, loadSecretKey } from './secretbox.js'
import type { SecretBox } from './secretbox.js'
import {
  toPublicConnection,
  validateConnectionInput,
} from './config.js'
import type {
  ConnectionInput,
  PublicConnection,
  ResolvedConnectionConfig,
  StoredConnection,
} from './config.js'

export interface ConnectionStoreOptions {
  /** Directory the store and its key live in. Created if absent. */
  directory: string
  /** File name inside `directory`. Default `connections.json`. */
  fileName?: string
  /** Default per-statement timeout handed to every connection. */
  statementTimeoutMs?: number
}

interface StoreFile {
  version: 1
  connections: StoredConnection[]
}

export class ConnectionStore {
  private readonly path: string
  private readonly box: SecretBox
  private readonly statementTimeoutMs: number
  private connections: StoredConnection[] = []

  constructor(options: ConnectionStoreOptions) {
    mkdirSync(options.directory, { recursive: true })
    this.path = join(options.directory, options.fileName ?? 'connections.json')
    this.box = createSecretBox(loadSecretKey(join(options.directory, '.connections.key')))
    this.statementTimeoutMs = options.statementTimeoutMs ?? 15_000
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.connections = []
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile
      this.connections = Array.isArray(parsed?.connections) ? parsed.connections : []
    } catch {
      // A corrupt store must not take the server down — the rest of the
      // browser (already-configured sources, the connector list) still works,
      // and a thrown error at construction time would make the whole process
      // unstartable over one bad file.
      this.connections = []
    }
  }

  private persist(): void {
    const payload: StoreFile = { version: 1, connections: this.connections }
    const tmp = `${this.path}.${process.pid}.tmp`
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(tmp, this.path)
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {
        /* nothing left to clean up */
      }
      throw e
    }
  }

  /** Every connection, secrets stripped. The body of `GET /api/connections`. */
  list(): PublicConnection[] {
    return this.connections.map(toPublicConnection)
  }

  /** One connection, secrets stripped. */
  get(id: string): PublicConnection | undefined {
    const found = this.connections.find((c) => c.id === id)
    return found ? toPublicConnection(found) : undefined
  }

  private require(id: string): StoredConnection {
    const found = this.connections.find((c) => c.id === id)
    if (!found) {
      throw new DbBrowserError('CONNECTION_NOT_FOUND', `No connection with id "${id}"`)
    }
    return found
  }

  create(input: ConnectionInput): PublicConnection {
    const descriptor = descriptorFor(input.engine)
    const validated = validateConnectionInput(descriptor, input)
    const now = new Date().toISOString()
    const stored: StoredConnection = {
      id: randomUUID(),
      name: validated.name,
      engine: descriptor.id,
      values: validated.values,
      secrets: Object.fromEntries(
        Object.entries(validated.secrets).map(([k, v]) => [k, this.box.encrypt(v)]),
      ),
      readOnly: validated.readOnly,
      createdAt: now,
      updatedAt: now,
    }
    this.connections.push(stored)
    this.persist()
    return toPublicConnection(stored)
  }

  /**
   * Update in place.
   *
   * A secret key absent from the body is **kept**, not cleared — that is what
   * makes "change the host without retyping the password" work, and it is why
   * `validateConnectionInput` distinguishes absent from explicit-null.
   */
  update(id: string, input: ConnectionInput): PublicConnection {
    const existing = this.require(id)
    const descriptor = descriptorFor(input.engine ?? existing.engine)
    if (descriptor.id !== existing.engine) {
      throw new DbBrowserError(
        'ENGINE_IMMUTABLE',
        `A connection's engine cannot be changed (${existing.engine} → ${descriptor.id}). ` +
          'Create a new connection instead — the stored fields belong to the old engine.',
      )
    }
    const validated = validateConnectionInput(descriptor, input, { partial: true })

    existing.name = validated.name || existing.name
    existing.values = { ...existing.values, ...validated.values }
    for (const [key, value] of Object.entries(validated.secrets)) {
      existing.secrets[key] = this.box.encrypt(value)
    }
    for (const key of validated.clearedSecrets) delete existing.secrets[key]
    if (input.readOnly !== undefined || validated.values.readOnly !== undefined) {
      existing.readOnly = validated.readOnly
    }
    existing.updatedAt = new Date().toISOString()
    this.persist()
    return toPublicConnection(existing)
  }

  remove(id: string): void {
    const before = this.connections.length
    this.connections = this.connections.filter((c) => c.id !== id)
    if (this.connections.length === before) {
      throw new DbBrowserError('CONNECTION_NOT_FOUND', `No connection with id "${id}"`)
    }
    this.persist()
  }

  /**
   * Decrypt one connection for a connect attempt.
   *
   * The **only** method that produces plaintext secrets, and the result is
   * never returned by a route — it goes straight into a driver config and is
   * dropped. Anything that wants to log a connection logs `list()`'s output.
   */
  resolve(id: string): ResolvedConnectionConfig {
    const stored = this.require(id)
    const secrets: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(stored.secrets)) {
      secrets[key] = value ? this.box.decrypt(value) : undefined
    }
    const schemas = String(stored.values.schemas ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return {
      id: stored.id,
      engine: stored.engine,
      values: { ...stored.values },
      secrets,
      readOnly: stored.readOnly,
      statementTimeoutMs: this.statementTimeoutMs,
      ...(schemas.length ? { schemas } : {}),
    }
  }

  /**
   * Resolve a *transient* config that was never stored — the "Test" button on
   * a form that has not been saved yet.
   *
   * It exists so testing a connection does not require creating one, which
   * would otherwise leave a trail of half-configured records behind every
   * failed attempt. The config is built, used and dropped; nothing is written.
   */
  resolveTransient(input: ConnectionInput): ResolvedConnectionConfig {
    const descriptor = descriptorFor(input.engine)
    const validated = validateConnectionInput(descriptor, input)
    const schemas = String(validated.values.schemas ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return {
      id: 'transient',
      engine: descriptor.id,
      values: validated.values,
      secrets: validated.secrets,
      readOnly: validated.readOnly,
      statementTimeoutMs: this.statementTimeoutMs,
      ...(schemas.length ? { schemas } : {}),
    }
  }

  /**
   * Merge a stored connection with the fields a form is currently showing.
   *
   * This is what makes "Test" work on an *edited but unsaved* connection whose
   * password the form does not have — the browser was never given it, so it
   * cannot send it back. The stored secret fills the gap.
   */
  resolveMerged(id: string, input: ConnectionInput): ResolvedConnectionConfig {
    const stored = this.resolve(id)
    const descriptor = descriptorFor(input.engine ?? stored.engine)
    const validated = validateConnectionInput(descriptor, input, { partial: true })
    return {
      ...stored,
      values: { ...stored.values, ...validated.values },
      secrets: { ...stored.secrets, ...validated.secrets },
      readOnly: input.readOnly === undefined ? stored.readOnly : validated.readOnly,
    }
  }
}

function descriptorFor(engine: unknown): ConnectorDescriptor {
  if (typeof engine !== 'string') {
    throw new DbBrowserError('INVALID_CONNECTION', 'A connection must name an engine')
  }
  return requireDescriptor(engine as EngineId)
}
