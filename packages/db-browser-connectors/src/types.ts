/**
 * The connector contract: what a database engine *is*, as data.
 *
 * ## The rule this file exists to enforce
 *
 * **A descriptor is pure data and must never import its driver.** Not at the
 * top of the file, not lazily inside a function, not through a type-only
 * import that a bundler might follow. That is what makes the registry
 * listable with nothing installed — which is the whole point of "give me a
 * list of database connectors and let me download the one I need". A
 * descriptor that imported `pg` would make `GET /api/connectors` fail on a
 * machine that has no Postgres driver, which is exactly the machine that most
 * needs the list.
 *
 * Drivers are reached one way only: `DriverLoader`, which resolves and imports
 * them at *connect* time and turns a missing module into an actionable message
 * naming the install command. See `driverLoader.ts`.
 *
 * ## What a descriptor is responsible for
 *
 * Everything that differs between engines and is not code:
 *
 *  - which npm package supplies the driver, and which version range;
 *  - which SQL grammar to highlight and format with;
 *  - **the connection form**, declaratively — the UI renders fields from
 *    `connectionFields` and has no per-engine branches of its own;
 *  - which capabilities the engine actually has, so the UI hides what it
 *    cannot do rather than offering it and failing;
 *  - the type map, which is how a raw type name becomes a grid editor.
 *
 * Everything that differs and *is* code lives in a `Dialect` strategy
 * (`dialects/`), which is deliberately small: identifier quoting, the
 * placeholder style, the pagination clause, the introspection queries, and any
 * extra guard denylist. Adding an engine is a descriptor plus one of those.
 */

import type { NormalizedType, SqlDialect } from '@jugaaadi/db-browser/core'

/**
 * The engines this registry describes.
 *
 * This is a *closed* union on purpose: it is the key of an API surface the UI
 * renders from and the connection store persists against, so an unrecognised
 * value arriving over the wire has to be rejectable. Adding an engine is a
 * one-line change here plus a descriptor — no branch anywhere else.
 */
export type EngineId =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'mssql'
  | 'oracle'
  | 'cockroach'
  | 'duckdb'

export const ENGINE_IDS: readonly EngineId[] = [
  'postgres',
  'mysql',
  'mariadb',
  'sqlite',
  'mssql',
  'oracle',
  'cockroach',
  'duckdb',
]

/**
 * One field of the connection form, declaratively.
 *
 * The UI renders these and nothing else — there is no `if (engine ===
 * 'sqlite') showFilePicker()` anywhere. That is why `kind` includes `file`
 * (SQLite and DuckDB are files, not servers) and `select` (SQL Server's
 * encryption mode, MySQL's SSL mode): the shapes a real connection form needs
 * are enumerated here once, so a new engine reuses them.
 */
export interface ConnectionField {
  key: string
  label: string
  kind: 'text' | 'number' | 'password' | 'file' | 'boolean' | 'select'
  required: boolean
  placeholder?: string
  default?: string | number | boolean
  options?: { value: string; label: string }[]
  /**
   * Write-only. A field marked `secret` is accepted on create/update, stored
   * encrypted-at-rest-adjacent (see `connections/store.ts`), and **never**
   * returned by any API — reads report only whether it is set. Marking a field
   * secret is the only thing that makes that true; there is no allowlist of
   * field names anywhere else.
   */
  secret?: boolean
  /** Shown under the field. Never contains a value, only guidance. */
  help?: string
}

/**
 * What an engine can actually do. The UI reads these to decide what to *show*,
 * so a false here is a hidden control rather than a control that errors.
 */
export interface ConnectorCapabilities {
  /** A real, user-facing second namespace level (`public`, `dbo`). */
  schemas: boolean
  /** `BEGIN`/`COMMIT`/`ROLLBACK` around a unit of work. */
  transactions: boolean
  /** Keyset (`WHERE (a,b) > (?,?)`) pagination is expressible and correct. */
  keysetPagination: boolean
  /** An implicit row key exists even with no declared PK (SQLite's `rowid`). */
  implicitRowId: boolean
  /** The session itself can be put in read-only mode, not just guarded. */
  readOnlySession: boolean
  /** One connection can see more than one database. */
  multipleDatabases: boolean
}

export interface ConnectorDescriptor {
  id: EngineId
  /** Product name, for the picker. `'PostgreSQL'`, not `'postgres'`. */
  label: string
  /** One line saying what this engine is, shown under the label. */
  description: string
  /**
   * The npm package that supplies the driver, or **null for a built-in**.
   * SQLite's driver is `node:sqlite`, which ships with Node 22.5+ — there is
   * nothing to install, so `installed` is resolved by probing the builtin
   * rather than by resolving a package. Modelling that as `null` instead of
   * as a fake package name is what keeps the install UI honest.
   */
  driverPackage: string | null
  /** The semver range the adapter is written against. */
  driverRange: string
  /** Which grammar drives CodeMirror and `sql-formatter`. */
  dialect: SqlDialect
  defaultPort?: number
  /** The connection form, rendered by the UI with no per-engine branches. */
  connectionFields: ConnectionField[]
  capabilities: ConnectorCapabilities
  /**
   * Raw database type (lower-cased, de-parameterised) → normalized type.
   *
   * Keys are the *base* name: `varchar`, not `varchar(255)`; `numeric`, not
   * `numeric(10,2)`. `normalizedTypeFor()` strips parameters, modifiers and
   * array decoration before the lookup, so one entry covers every width.
   * A type that is not here normalises to `'unknown'` and renders as text —
   * documented, tested, and never an exception.
   */
  typeMap: Record<string, NormalizedType>
  /**
   * Extra words the SQL guard must refuse for this engine on top of the
   * shared list. Empty when the engine's dangerous built-ins are already
   * covered by its `dialect`'s entry in the core guard.
   */
  extraDenylist?: string[]
  /** Documentation link, shown next to the install button. */
  docsUrl?: string
}

/**
 * A descriptor plus the answer to "can I use this right now?".
 *
 * `installed` is **always resolved by attempting resolution**, never assumed
 * from a lockfile, a `package.json` or a previous answer. A driver can be
 * removed between two requests, and a registry that says `installed: true`
 * about a package that is gone produces a `MODULE_NOT_FOUND` at connect time —
 * the exact error this whole mechanism exists to replace.
 */
export interface ConnectorStatus {
  descriptor: ConnectorDescriptor
  installed: boolean
  /** The version actually resolved on disk, when it could be read. */
  installedVersion?: string
  /** True when `installedVersion` is outside `driverRange`. */
  versionMismatch?: boolean
  /** Why it is not installed / not usable, in a form the user can act on. */
  error?: string
  /** The exact command to run. Present whenever `installed` is false. */
  installCommand?: string
  /** False when this build has no adapter for the engine yet. */
  supported: boolean
}
