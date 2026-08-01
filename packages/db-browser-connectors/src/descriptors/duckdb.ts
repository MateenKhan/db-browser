/**
 * DuckDB — an in-process analytics engine, so a file like SQLite rather than a
 * server like Postgres.
 *
 * **No import of `@duckdb/node-api` appears here.** See `types.ts`.
 */

import type { ConnectorDescriptor } from '../types.js'
import type { NormalizedType } from '@jugaaadi/db-browser/core'
import { READ_ONLY_FIELD, fileField } from './fields.js'

/**
 * `information_schema.columns.data_type` values.
 *
 * DuckDB's catalog reports the full type including parameters and the nested
 * forms (`DECIMAL(18,3)`, `STRUCT(a INTEGER, b VARCHAR)`, `INTEGER[]`), and
 * `normalizedTypeFor()` strips the first two. The **nested** types cannot be
 * stripped into a base name and are mapped explicitly to `json`, because that
 * is what the driver hands back for them and it is what a grid can render.
 */
export const DUCKDB_TYPE_MAP: Record<string, NormalizedType> = {
  tinyint: 'integer', smallint: 'integer', integer: 'integer', bigint: 'integer',
  hugeint: 'integer', utinyint: 'integer', usmallint: 'integer',
  uinteger: 'integer', ubigint: 'integer', uhugeint: 'integer',
  int: 'integer', int1: 'integer', int2: 'integer', int4: 'integer', int8: 'integer',
  decimal: 'decimal', numeric: 'decimal',
  real: 'decimal', float: 'decimal', float4: 'decimal', float8: 'decimal', double: 'decimal',
  varchar: 'string', char: 'string', bpchar: 'string', string: 'text', text: 'text',
  boolean: 'boolean', bool: 'boolean', logical: 'boolean',
  date: 'date',
  time: 'time', timetz: 'time',
  timestamp: 'timestamp', timestamptz: 'timestamp',
  timestamp_s: 'timestamp', timestamp_ms: 'timestamp', timestamp_ns: 'timestamp',
  datetime: 'timestamp',
  interval: 'string',
  blob: 'binary', bytea: 'binary', bitstring: 'binary',
  uuid: 'uuid',
  json: 'json', struct: 'json', map: 'json', union: 'json',
  list: 'array',
  enum: 'enum',
  // DuckDB's fixed-size array is how its vector extension stores embeddings.
  array: 'array',
}

export const duckdbDescriptor: ConnectorDescriptor = {
  id: 'duckdb',
  label: 'DuckDB',
  description: 'In-process analytics over a local .duckdb file or an in-memory database.',
  driverPackage: '@duckdb/node-api',
  driverRange: '^1.1.0',
  dialect: 'duckdb',
  connectionFields: [
    fileField('Database file', '/path/to/analytics.duckdb  (or :memory:)'),
    READ_ONLY_FIELD,
  ],
  capabilities: {
    // DuckDB does have schemas, but everything lands in `main` in practice and
    // the sidebar grouping is the same noise it is on SQLite.
    schemas: false,
    transactions: true,
    keysetPagination: true,
    implicitRowId: false,
    // `duckdb.open(path, { access_mode: 'READ_ONLY' })`.
    readOnlySession: true,
    // ATTACH, and it is the normal way to work.
    multipleDatabases: true,
  },
  typeMap: DUCKDB_TYPE_MAP,
  // See the core guard's `duckdb` denylist: `read_csv`, `read_parquet` and
  // friends make an ordinary `SELECT` a filesystem read, and `INSTALL`/`LOAD`
  // fetch native code. A read-only DuckDB console is not automatically safe.
  extraDenylist: ['ATTACH', 'DETACH', 'EXPORT', 'IMPORT'],
  docsUrl: 'https://duckdb.org/docs/api/nodejs/overview',
}
