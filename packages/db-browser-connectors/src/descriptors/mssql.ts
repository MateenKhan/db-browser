/**
 * Microsoft SQL Server.
 *
 * **No import of `mssql` appears here.** See `types.ts`.
 */

import type { ConnectorDescriptor } from '../types.js'
import type { NormalizedType } from '@jugaaadi/db-browser/core'
import { READ_ONLY_FIELD, serverFields } from './fields.js'

/** `information_schema.columns.data_type` values, which are the base names. */
export const MSSQL_TYPE_MAP: Record<string, NormalizedType> = {
  tinyint: 'integer', smallint: 'integer', int: 'integer', bigint: 'integer',
  decimal: 'decimal', numeric: 'decimal', money: 'decimal', smallmoney: 'decimal',
  float: 'decimal', real: 'decimal',
  bit: 'boolean',
  char: 'string', nchar: 'string', varchar: 'string', nvarchar: 'string',
  text: 'text', ntext: 'text', xml: 'text',
  binary: 'binary', varbinary: 'binary', image: 'binary',
  date: 'date',
  time: 'time',
  datetime: 'timestamp', datetime2: 'timestamp', smalldatetime: 'timestamp',
  datetimeoffset: 'timestamp',
  uniqueidentifier: 'uuid',
  // `rowversion`/`timestamp` in SQL Server is an 8-byte counter, not a time —
  // one of the clearest reasons a type map beats a name heuristic. Note
  // `timestamp` above maps to a real timestamp because that is what
  // `information_schema` reports for `datetime`-family columns; SQL Server's
  // legacy `timestamp` alias reports as `timestamp` too, which is genuinely
  // ambiguous in the catalog, so `rowversion` is the spelling that is pinned.
  rowversion: 'binary',
  sql_variant: 'unknown',
  hierarchyid: 'binary', geography: 'binary', geometry: 'binary',
}

export const mssqlDescriptor: ConnectorDescriptor = {
  id: 'mssql',
  label: 'Microsoft SQL Server',
  description: 'SQL Server 2016+ and Azure SQL, through the tedious-based mssql driver.',
  driverPackage: 'mssql',
  driverRange: '^11.0.0',
  dialect: 'mssql',
  defaultPort: 1433,
  connectionFields: [
    ...serverFields({ defaultPort: 1433, userDefault: 'sa' }),
    {
      key: 'encrypt',
      label: 'Encrypt',
      kind: 'select',
      required: false,
      default: 'true',
      options: [
        { value: 'true', label: 'Encrypt the connection' },
        { value: 'false', label: 'Plaintext' },
      ],
      help: 'Azure SQL requires this. A local dev instance with a self-signed certificate needs “Trust the server certificate” below as well.',
    },
    {
      key: 'trustServerCertificate',
      label: 'Trust the server certificate',
      kind: 'boolean',
      required: false,
      default: false,
      help: 'Turns off certificate verification. Development only — it defeats the point of encryption against an active attacker.',
    },
    READ_ONLY_FIELD,
  ],
  capabilities: {
    // `dbo`, and it is genuinely user-facing.
    schemas: true,
    transactions: true,
    keysetPagination: true,
    implicitRowId: false,
    // `SET TRANSACTION ISOLATION LEVEL SNAPSHOT` is not read-only enforcement;
    // SQL Server has no session-level read-only switch short of a read-only
    // replica or a read-only database, so this is honestly false and the guard
    // plus a read-only login are the enforcement.
    readOnlySession: false,
    multipleDatabases: true,
  },
  typeMap: MSSQL_TYPE_MAP,
  docsUrl: 'https://github.com/tediousjs/node-mssql',
}
