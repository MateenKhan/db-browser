/**
 * MySQL and MariaDB.
 *
 * **This is the descriptor that proves the abstraction.** It was written
 * *after* the shared `SqlDataSource` existed, and adding it required no change
 * to `@jugaaadi/db-browser` at all: this file, a `Dialect` strategy
 * (`dialects/mysql.ts` — quoting, `LIMIT`/`OFFSET`, three `information_schema`
 * queries) and a driver binding. If a future engine needs more than those
 * three files, the abstraction has a hole and the hole is the bug.
 *
 * **No import of `mysql2` appears here.** See `types.ts`.
 */

import type { ConnectorDescriptor } from '../types.js'
import type { NormalizedType } from '@jugaaadi/db-browser/core'
import { READ_ONLY_FIELD, serverFields } from './fields.js'

/**
 * `information_schema.columns.data_type` values.
 *
 * MySQL reports the *base* type there (`varchar`, not `varchar(255)`; that
 * lives in `column_type`), so most of these are already the map key. The ones
 * that are not — `int unsigned`, `decimal(10,2)` — are handled by
 * `normalizedTypeFor`'s stripping, which is why there is no `int unsigned`
 * entry.
 *
 * Two entries are deliberate judgement calls:
 *
 *  - **`tinyint` is `integer`, not `boolean`.** MySQL's `BOOLEAN` is an alias
 *    for `TINYINT(1)` and the two are indistinguishable in
 *    `information_schema.data_type` — both report `tinyint`. Rendering every
 *    `tinyint` as a boolean would turn a legitimate 0–255 status column into
 *    `true`/`false`, which is a data-losing display. The dialect's introspector
 *    refines this using `column_type`, where `tinyint(1)` *is* distinguishable,
 *    and only then reports `boolean`.
 *  - **`json` is `json`** even though MariaDB implements it as `longtext` with
 *    a check constraint. MariaDB's `information_schema` reports `longtext`, so
 *    a MariaDB JSON column shows as text — accurate to what the engine stores,
 *    and better than guessing from the contents.
 */
export const MYSQL_TYPE_MAP: Record<string, NormalizedType> = {
  tinyint: 'integer', smallint: 'integer', mediumint: 'integer',
  int: 'integer', integer: 'integer', bigint: 'integer', year: 'integer',
  bit: 'integer',
  decimal: 'decimal', dec: 'decimal', numeric: 'decimal', fixed: 'decimal',
  float: 'decimal', double: 'decimal', real: 'decimal',
  char: 'string', varchar: 'string', binary: 'binary', varbinary: 'binary',
  tinytext: 'text', text: 'text', mediumtext: 'text', longtext: 'text',
  tinyblob: 'binary', blob: 'binary', mediumblob: 'binary', longblob: 'binary',
  bool: 'boolean', boolean: 'boolean',
  date: 'date',
  time: 'time',
  datetime: 'timestamp', timestamp: 'timestamp',
  json: 'json',
  enum: 'enum',
  // A SET is a multi-valued enum; it comes back as a comma-joined string, and
  // `array` is the closest honest description of that.
  set: 'array',
  uuid: 'uuid',
  geometry: 'binary', point: 'binary', linestring: 'binary', polygon: 'binary',
  multipoint: 'binary', multilinestring: 'binary', multipolygon: 'binary',
  geometrycollection: 'binary',
  // MariaDB 11.7 vector type.
  vector: 'vector',
}

function mysqlFields(defaultPort: number) {
  return [
    ...serverFields({ defaultPort, userDefault: 'root' }),
    {
      key: 'ssl',
      label: 'TLS',
      kind: 'select' as const,
      required: false,
      default: 'disable',
      options: [
        { value: 'disable', label: 'Disabled' },
        { value: 'require', label: 'Required (do not verify the certificate)' },
        { value: 'verify-full', label: 'Required, verify the certificate' },
      ],
    },
    READ_ONLY_FIELD,
  ]
}

/**
 * MySQL and MariaDB share `mysql2`, and that is not a shortcut — `mysql2`
 * speaks both protocols and the two engines' `information_schema` is
 * compatible for everything this browser reads. They stay two engines because
 * their *grammars* differ enough to matter to the formatter and the editor
 * (MariaDB has `RETURNING`, sequences, and its own `SHOW` surface), and
 * because a user picking a connector should see the product they run.
 */
export const mysqlDescriptor: ConnectorDescriptor = {
  id: 'mysql',
  label: 'MySQL',
  description: 'MySQL 5.7+ / 8.x, through the pure-JavaScript mysql2 driver.',
  driverPackage: 'mysql2',
  driverRange: '^3.11.0',
  dialect: 'mysql',
  defaultPort: 3306,
  connectionFields: mysqlFields(3306),
  capabilities: {
    // MySQL's "schema" *is* its database — `information_schema.table_schema`
    // holds the database name — so a connection sees exactly one and grouping
    // by it is noise. Stated here rather than inferred anywhere.
    schemas: false,
    transactions: true,
    keysetPagination: true,
    implicitRowId: false,
    // `SET SESSION TRANSACTION READ ONLY` / `START TRANSACTION READ ONLY`.
    readOnlySession: true,
    // One connection can `USE` another database, and can qualify across them.
    multipleDatabases: true,
  },
  typeMap: MYSQL_TYPE_MAP,
  docsUrl: 'https://sidorares.github.io/node-mysql2/docs',
}

export const mariadbDescriptor: ConnectorDescriptor = {
  id: 'mariadb',
  label: 'MariaDB',
  description: 'MariaDB 10.x / 11.x. Uses the same mysql2 driver as MySQL.',
  driverPackage: 'mysql2',
  driverRange: '^3.11.0',
  dialect: 'mariadb',
  defaultPort: 3306,
  connectionFields: mysqlFields(3306),
  capabilities: {
    schemas: false,
    transactions: true,
    keysetPagination: true,
    implicitRowId: false,
    readOnlySession: true,
    multipleDatabases: true,
  },
  typeMap: MYSQL_TYPE_MAP,
  docsUrl: 'https://mariadb.com/kb/en/nodejs-connector/',
}
