/**
 * Every descriptor, in one list.
 *
 * This module is the *only* thing that has to change to add an engine to the
 * catalogue — and because a descriptor imports no driver, importing this list
 * is safe on a machine with nothing installed. That is what `GET
 * /api/connectors` depends on.
 */

import type { ConnectorDescriptor, EngineId } from '../types.js'
import { cockroachDescriptor, postgresDescriptor } from './postgres.js'
import { mariadbDescriptor, mysqlDescriptor } from './mysql.js'
import { sqliteDescriptor } from './sqlite.js'
import { mssqlDescriptor } from './mssql.js'
import { duckdbDescriptor } from './duckdb.js'
import { oracleDescriptor } from './oracle.js'

/**
 * Ordered for the picker: the engines with a verified adapter first, then the
 * rest. The order is presentation, not precedence — nothing resolves by
 * position.
 */
export const CONNECTOR_DESCRIPTORS: readonly ConnectorDescriptor[] = [
  postgresDescriptor,
  mysqlDescriptor,
  mariadbDescriptor,
  sqliteDescriptor,
  mssqlDescriptor,
  duckdbDescriptor,
  cockroachDescriptor,
  oracleDescriptor,
]

const BY_ID = new Map<EngineId, ConnectorDescriptor>(
  CONNECTOR_DESCRIPTORS.map((d) => [d.id, d]),
)

/** One descriptor, or `undefined` for a name that is not an engine. */
export function getDescriptor(id: string): ConnectorDescriptor | undefined {
  return BY_ID.get(id as EngineId)
}

export {
  postgresDescriptor,
  cockroachDescriptor,
  mysqlDescriptor,
  mariadbDescriptor,
  sqliteDescriptor,
  mssqlDescriptor,
  duckdbDescriptor,
  oracleDescriptor,
}
export { POSTGRES_TYPE_MAP } from './postgres.js'
export { MYSQL_TYPE_MAP } from './mysql.js'
export { SQLITE_TYPE_MAP } from './sqlite.js'
export { MSSQL_TYPE_MAP } from './mssql.js'
export { DUCKDB_TYPE_MAP } from './duckdb.js'
export { ORACLE_TYPE_MAP } from './oracle.js'
export { READ_ONLY_FIELD, SSL_MODE_FIELD, fileField, serverFields } from './fields.js'
