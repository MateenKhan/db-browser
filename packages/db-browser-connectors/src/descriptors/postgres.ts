/**
 * PostgreSQL, and CockroachDB which speaks its wire protocol.
 *
 * **No import of `pg` appears in this file, deliberately.** See `types.ts`.
 */

import type { ConnectorDescriptor } from '../types.js'
import type { NormalizedType } from '@jugaaadi/db-browser/core'
import { READ_ONLY_FIELD, SSL_MODE_FIELD, serverFields } from './fields.js'

/**
 * Postgres type names as `pg_type.typname` reports them, plus the
 * `format_type()` spellings that differ.
 *
 * The keys are base names: `normalizedTypeFor()` strips `(255)`, `without time
 * zone` and array decoration before looking anything up, so `varchar` covers
 * `character varying(255)` and `_text` never needs an entry of its own.
 *
 * `vector` is here because pgvector is common enough that treating its columns
 * as `unknown` — and therefore as editable text — would be actively wrong.
 */
export const POSTGRES_TYPE_MAP: Record<string, NormalizedType> = {
  // integers
  int2: 'integer', int4: 'integer', int8: 'integer',
  smallint: 'integer', integer: 'integer', int: 'integer', bigint: 'integer',
  smallserial: 'integer', serial: 'integer', bigserial: 'integer',
  serial2: 'integer', serial4: 'integer', serial8: 'integer',
  oid: 'integer', xid: 'integer', cid: 'integer',
  // approximate + exact decimals
  numeric: 'decimal', decimal: 'decimal', money: 'decimal',
  real: 'decimal', float4: 'decimal', float8: 'decimal',
  double: 'decimal', 'double precision': 'decimal',
  // strings
  varchar: 'string', bpchar: 'string', char: 'string', character: 'string',
  'character varying': 'string',
  name: 'string', citext: 'string',
  text: 'text', xml: 'text',
  // booleans
  bool: 'boolean', boolean: 'boolean',
  // temporal
  date: 'date',
  time: 'time', timetz: 'time',
  timestamp: 'timestamp', timestamptz: 'timestamp',
  // `interval` has no counterpart in the vocabulary and is rendered as its
  // text form (`1 day 02:00:00`), which is what every driver hands back.
  interval: 'string',
  // structured
  json: 'json', jsonb: 'json',
  uuid: 'uuid',
  bytea: 'binary',
  // extensions worth knowing about, because getting these wrong is visible
  vector: 'vector', halfvec: 'vector', sparsevec: 'vector',
  // network / range / geometric types have no vocabulary entry and are
  // rendered as their text form, which is exactly what `unknown` does. They
  // are listed as `string` rather than left out only where the text form is
  // genuinely the value (inet, cidr) rather than a lossy summary.
  inet: 'string', cidr: 'string', macaddr: 'string', macaddr8: 'string',
  tsvector: 'text', tsquery: 'text',
}

const CONNECTION_FIELDS = [
  ...serverFields({ defaultPort: 5432, databaseDefault: 'postgres', userDefault: 'postgres' }),
  SSL_MODE_FIELD,
  {
    key: 'schemas',
    label: 'Schemas',
    kind: 'text' as const,
    required: false,
    placeholder: 'public, app  (blank = every non-system schema)',
    help: 'Comma-separated. Restricting this is the cheapest way to make a large database navigable.',
  },
  READ_ONLY_FIELD,
]

export const postgresDescriptor: ConnectorDescriptor = {
  id: 'postgres',
  label: 'PostgreSQL',
  description: 'The reference engine for this browser. Full introspection, real transactions.',
  driverPackage: 'pg',
  driverRange: '^8.11.0',
  dialect: 'postgres',
  defaultPort: 5432,
  connectionFields: CONNECTION_FIELDS,
  capabilities: {
    schemas: true,
    transactions: true,
    keysetPagination: true,
    implicitRowId: false,
    // `BEGIN … READ ONLY` — the layer that cannot be regexed around.
    readOnlySession: true,
    // One connection sees one database; `\c` is a reconnect, not a query.
    multipleDatabases: false,
  },
  typeMap: POSTGRES_TYPE_MAP,
  docsUrl: 'https://node-postgres.com/',
}

/**
 * CockroachDB.
 *
 * Same driver, same grammar, same catalog — so the descriptor differs in
 * exactly the two places the *product* differs: it has no `ctid`-style
 * implicit row identity worth using, and its planner does not maintain
 * `reltuples`, so row-count estimates come back as -1 rather than as numbers.
 * Modelling it as its own engine rather than as "Postgres with a different
 * label" is what lets those differences be stated instead of discovered.
 */
export const cockroachDescriptor: ConnectorDescriptor = {
  id: 'cockroach',
  label: 'CockroachDB',
  description: 'Distributed SQL that speaks the Postgres wire protocol and grammar.',
  driverPackage: 'pg',
  driverRange: '^8.11.0',
  dialect: 'postgres',
  defaultPort: 26257,
  connectionFields: [
    ...serverFields({ defaultPort: 26257, databaseDefault: 'defaultdb', userDefault: 'root' }),
    SSL_MODE_FIELD,
    READ_ONLY_FIELD,
  ],
  capabilities: {
    schemas: true,
    transactions: true,
    keysetPagination: true,
    implicitRowId: false,
    readOnlySession: true,
    multipleDatabases: false,
  },
  typeMap: POSTGRES_TYPE_MAP,
  docsUrl: 'https://www.cockroachlabs.com/docs/stable/connect-to-the-database',
}
