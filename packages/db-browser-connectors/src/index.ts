/**
 * `@jugaaadi/db-browser-connectors` — the metadata-driven engine catalogue.
 *
 * The idea, in one line: **a database engine is a descriptor, not a code
 * branch.** Adding one is a `ConnectorDescriptor` (pure data — the driver
 * package, the connection form, the capabilities, the type map), a small
 * `Dialect` strategy (quoting, placeholders, pagination, three catalog
 * queries) and a driver binding. Nothing in `@jugaaadi/db-browser` changes.
 *
 * ```ts
 * import { connectorStatuses, openConnection } from '@jugaaadi/db-browser-connectors'
 *
 * connectorStatuses()          // works with no driver installed at all
 * // [{ descriptor: { id: 'mysql', … }, installed: false,
 * //    installCommand: 'npm install mysql2@^3.11.0', … }, …]
 *
 * const source = await openConnection(store.resolve(id))   // imports the driver here, and only here
 * ```
 *
 * **Node only.** Never import this from client code: it reads a key file,
 * spawns a package manager and holds decrypted credentials.
 */

export * from './types.js'
export {
  CONNECTOR_DESCRIPTORS,
  getDescriptor,
  postgresDescriptor,
  cockroachDescriptor,
  mysqlDescriptor,
  mariadbDescriptor,
  sqliteDescriptor,
  mssqlDescriptor,
  duckdbDescriptor,
  oracleDescriptor,
  POSTGRES_TYPE_MAP,
  MYSQL_TYPE_MAP,
  SQLITE_TYPE_MAP,
  MSSQL_TYPE_MAP,
  DUCKDB_TYPE_MAP,
  ORACLE_TYPE_MAP,
  READ_ONLY_FIELD,
  SSL_MODE_FIELD,
  fileField,
  serverFields,
} from './descriptors/index.js'

export {
  SUPPORTED_ENGINES,
  connectorStatus,
  connectorStatuses,
  listDescriptors,
  requireDescriptor,
  satisfiesRange,
} from './registry.js'
export type { ConnectorStatusOptions } from './registry.js'

export {
  detectPackageManager,
  forgetLoadedDrivers,
  installCommandFor,
  loadDriver,
  missingDriverError,
  resolveDriver,
} from './driverLoader.js'
export type { PackageManager, ResolvedDriver } from './driverLoader.js'

export { dialectFor, hasDialect } from './dialects/index.js'
export { createPostgresDialect } from './dialects/postgres.js'
export { createMysqlDialect, isMysqlBoolean, parseEnumLabels } from './dialects/mysql.js'
export {
  createNamedBinder,
  createNumberedBinder,
  createPositionalBinder,
  fetchFirstClause,
  likeLiteral,
  limitOffsetClause,
  normalizeDriverError,
  quoteBacktick,
  quoteBracket,
  quoteDoubleQuoted,
  wrapWithLimitSql,
} from './dialects/shared.js'
export type {
  Binder,
  Dialect,
  Exec,
  ExecResult,
  ListTablesOptions,
  PaginationClauseInput,
} from './dialects/types.js'

export {
  buildBinaryFetch,
  buildDelete,
  buildFilter,
  buildInsert,
  buildPkPredicate,
  buildSelect,
  buildUpdate,
  projectionFor,
  strictResolver,
} from './sqlBuilder.js'
export type {
  BuilderContext,
  BuiltQuery,
  ColumnResolver,
  SelectBuildInput,
  WriteBuildInput,
  WriteQuery,
} from './sqlBuilder.js'

export { createSqlDataSource } from './sqlDataSource.js'
export type {
  SqlConnection,
  SqlDataSourceHandle,
  SqlDataSourceOptions,
} from './sqlDataSource.js'

export { openPostgresConnection } from './engines/postgres.js'
export { openMysqlConnection } from './engines/mysql.js'

export {
  openConnection,
  registerSqliteOpener,
  scrubConnectionError,
  testConnection,
} from './openConnection.js'
export type {
  OpenConnectionOptions,
  SqliteOpener,
  TestConnectionResult,
} from './openConnection.js'

export { ConnectionStore } from './connections/store.js'
export type { ConnectionStoreOptions } from './connections/store.js'
export { toPublicConnection, validateConnectionInput } from './connections/config.js'
export type {
  ConnectionInput,
  PublicConnection,
  ResolvedConnectionConfig,
  StoredConnection,
  ValidatedInput,
} from './connections/config.js'
export { createSecretBox, loadSecretKey } from './connections/secretbox.js'
export type { SecretBox } from './connections/secretbox.js'
export {
  assertEditable,
  evaluateEditGate,
  isLoopbackAddress,
} from './connections/loopbackGate.js'
export type { BindingInfo, EditGate, EditableReason } from './connections/loopbackGate.js'

export { ConnectorInstaller, planSpawn, scrubInstallLine } from './installer.js'
export type {
  InstallJob,
  InstallPhase,
  InstallProgress,
  InstallerOptions,
  SpawnPlan,
} from './installer.js'
