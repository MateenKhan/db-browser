/**
 * SQLite — the one built-in.
 *
 * `driverPackage: null` is load-bearing rather than cosmetic. SQLite's driver
 * is `node:sqlite`, which ships with Node 22.5+, so there is nothing to
 * install and an "Install" button would be a lie. The registry resolves
 * `installed` for a null-package descriptor by probing the *builtin* instead
 * of resolving a package — see `driverLoader.ts` — which also means a user on
 * Node 20 correctly sees `installed: false` with a message naming the Node
 * version rather than an npm command that would not help.
 */

import type { ConnectorDescriptor } from '../types.js'
import type { NormalizedType } from '@jugaaadi/db-browser/core'
import { READ_ONLY_FIELD, fileField } from './fields.js'

/**
 * SQLite's declared types are **free text** and its typing is dynamic, so this
 * map is a convenience over the common spellings, not the mechanism.
 *
 * The real mechanism is SQLite's own five-rule affinity algorithm, which the
 * dialect's introspector applies first (`@jugaaadi/db-browser-sqlite`'s
 * `affinity.ts`) — a lookup table cannot get `nvarchar(80)` or `unsigned big
 * int` right, and the rule order (`INT` before `CHAR`) *is* the algorithm.
 * This map exists so the descriptor is complete and so the shared normaliser
 * has something to answer with; where the two disagree, affinity wins because
 * it is what the database itself does.
 */
export const SQLITE_TYPE_MAP: Record<string, NormalizedType> = {
  integer: 'integer', int: 'integer', bigint: 'integer', smallint: 'integer',
  tinyint: 'integer', mediumint: 'integer', 'unsigned big int': 'integer',
  int2: 'integer', int8: 'integer',
  real: 'decimal', double: 'decimal', float: 'decimal',
  numeric: 'decimal', decimal: 'decimal',
  text: 'text', clob: 'text',
  varchar: 'string', 'varying character': 'string', nchar: 'string',
  'native character': 'string', nvarchar: 'string', char: 'string', character: 'string',
  blob: 'binary',
  boolean: 'boolean', bool: 'boolean',
  date: 'date',
  datetime: 'timestamp', timestamp: 'timestamp',
  time: 'time',
  json: 'json',
  uuid: 'uuid', guid: 'uuid',
  vector: 'vector', embedding: 'vector',
}

export const sqliteDescriptor: ConnectorDescriptor = {
  id: 'sqlite',
  label: 'SQLite',
  description: 'A local .db file. No server, no driver to install on Node 22.5+.',
  driverPackage: null,
  // The *Node* range, not an npm range — `node:sqlite` landed in 22.5.0.
  driverRange: '>=22.5.0',
  dialect: 'sqlite',
  connectionFields: [
    fileField('Database file', '/path/to/database.db'),
    READ_ONLY_FIELD,
  ],
  capabilities: {
    // `main`/`temp` are databases, not schemas anyone groups by.
    schemas: false,
    transactions: true,
    keysetPagination: true,
    // The `rowid` fallback — the difference between a usable browser and a
    // read-only one on the very many SQLite tables with no declared key.
    implicitRowId: true,
    // The file handle itself is opened read-only; SQLite answers "attempt to
    // write a readonly database" to anything the guard missed.
    readOnlySession: true,
    multipleDatabases: false,
  },
  typeMap: SQLITE_TYPE_MAP,
  docsUrl: 'https://nodejs.org/api/sqlite.html',
}
