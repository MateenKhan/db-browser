/**
 * `@jugaaadi/db-browser-pg` — the reference Postgres adapter and a small HTTP
 * server that exposes it to the browser. Node only; never import this from
 * client code (it would mean shipping database credentials to the browser).
 */

export { createPgDataSource } from './pgDataSource.js'
export type { PgDataSource, PgDataSourceOptions } from './pgDataSource.js'
export { createDbBrowserHandler } from './server.js'
export type { DbBrowserServerOptions } from './server.js'
export { describeColumns, listTables, regclassLiteral } from './introspect.js'
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
  wrapWithLimit,
} from './sqlBuilder.js'
export type { BuiltQuery, SelectBuildInput, WriteBuildInput } from './sqlBuilder.js'
export { categoryForOid, udtNameForOid } from './typeOids.js'
