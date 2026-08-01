/**
 * Oracle Database.
 *
 * **No import of `oracledb` appears here.** See `types.ts`.
 *
 * Oracle is the one descriptor whose *install* story is more than an npm
 * package on some platforms: `oracledb` runs in Thin mode with no client
 * libraries since 6.x, which is what this descriptor targets, but Thick mode
 * additionally needs Oracle Instant Client on the host. That is stated in the
 * description rather than discovered at connect time.
 */

import type { ConnectorDescriptor } from '../types.js'
import type { NormalizedType } from '@jugaaadi/db-browser/core'
import { READ_ONLY_FIELD, serverFields } from './fields.js'

/**
 * `all_tab_columns.data_type` values.
 *
 * The interesting one is `NUMBER`: Oracle has a single numeric type whose
 * scale decides whether it is an integer, so `number` maps to `decimal` here
 * and the dialect's introspector refines it to `integer` when
 * `data_scale = 0`. Mapping it to `integer` in the map instead would silently
 * truncate every `NUMBER(10,2)` in the grid's editor.
 */
export const ORACLE_TYPE_MAP: Record<string, NormalizedType> = {
  number: 'decimal', float: 'decimal', 'binary_float': 'decimal', 'binary_double': 'decimal',
  integer: 'integer', int: 'integer', smallint: 'integer',
  varchar2: 'string', nvarchar2: 'string', char: 'string', nchar: 'string',
  varchar: 'string',
  clob: 'text', nclob: 'text', long: 'text',
  blob: 'binary', raw: 'binary', 'long raw': 'binary', bfile: 'binary',
  date: 'timestamp', // Oracle's DATE carries a time component. It is not a date.
  timestamp: 'timestamp',
  'timestamp with time zone': 'timestamp',
  'timestamp with local time zone': 'timestamp',
  json: 'json',
  xmltype: 'text',
  rowid: 'string', urowid: 'string',
  vector: 'vector',
}

export const oracleDescriptor: ConnectorDescriptor = {
  id: 'oracle',
  label: 'Oracle Database',
  description: 'Oracle 12c+ through node-oracledb in Thin mode (no Instant Client needed).',
  driverPackage: 'oracledb',
  driverRange: '^6.6.0',
  dialect: 'oracle',
  defaultPort: 1521,
  connectionFields: [
    ...serverFields({
      defaultPort: 1521,
      databaseLabel: 'Service name',
      databaseDefault: 'FREEPDB1',
      userLabel: 'Username',
    }),
    READ_ONLY_FIELD,
  ],
  capabilities: {
    // A schema *is* a user in Oracle, and it is very much user-facing.
    schemas: true,
    transactions: true,
    keysetPagination: true,
    // Oracle has a `ROWID` pseudo-column, but unlike SQLite's `rowid` it is a
    // physical address that changes on a row move — usable within one
    // statement, not as the key of an interactive edit made seconds later.
    implicitRowId: false,
    // `SET TRANSACTION READ ONLY`.
    readOnlySession: true,
    multipleDatabases: false,
  },
  typeMap: ORACLE_TYPE_MAP,
  docsUrl: 'https://node-oracledb.readthedocs.io/',
}
