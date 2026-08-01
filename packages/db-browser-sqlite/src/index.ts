/**
 * `@jugaaadi/db-browser-sqlite` — a SQLite adapter for `@jugaaadi/db-browser`,
 * plus a small HTTP server that exposes it to the browser. **Node only**; never
 * import this from client code (it would mean shipping a filesystem path, and a
 * browser cannot open a file handle anyway).
 *
 * ```ts
 * const dataSource = await createSqliteDataSource({
 *   filename: '.embeddings/code-embeddings.db',
 *   readOnly: true,          // the default, and enforced by SQLite itself
 * })
 * const api = createSqliteBrowserHandler({ dataSource, basePath: '/api/db' })
 * ```
 *
 * The driver is `node:sqlite` when the running Node has it (22.5+), else
 * `better-sqlite3` if installed — see `driver.ts` for why that order.
 */

export { createSqliteDataSource } from './sqliteDataSource.js'
export type { SqliteDataSource, SqliteDataSourceOptions } from './sqliteDataSource.js'
export { createSqliteBrowserHandler } from './server.js'
export type { SqliteServerOptions } from './server.js'

export { openSqlite, narrowValue, toSqliteError } from './driver.js'
export type { OpenOptions, SqliteDb, SqliteStatement } from './driver.js'

export { affinityOf, categoryForSqliteType, isBinaryCategory } from './affinity.js'
export type { SqliteAffinity } from './affinity.js'

export {
  describeColumns,
  listTables,
  rowIdentityFor,
  MAIN_SCHEMA,
  ROWID_ALIASES,
} from './introspect.js'
export type { RowIdentity, SqliteTableMeta } from './introspect.js'

export {
  profileDatabase,
  readCodeGraphProfile,
  readVectorProfile,
  vectorColumnsFor,
  VECTOR_COLUMN,
} from './profile.js'

export {
  Binder,
  buildBinaryFetch,
  buildDelete,
  buildFilter,
  buildInsert,
  buildPkPredicate,
  buildSelect,
  buildUpdate,
  projectionFor,
  quoteQualified,
  wrapWithLimit,
} from './sqlBuilder.js'
export type { BuiltQuery, SelectBuildInput, WriteBuildInput } from './sqlBuilder.js'
