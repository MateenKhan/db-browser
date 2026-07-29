/**
 * The transport-agnostic contract every db-browser front end talks to.
 *
 * A browser cannot open a TCP socket to Postgres, so the UI never knows *how*
 * rows arrive — it only knows this interface. Ship the reference Postgres
 * adapter in a Node process and the HTTP adapter in the browser, or implement
 * `DataSource` yourself over whatever transport you already have.
 */

export type Row = Record<string, unknown>

export interface TableRef {
  schema: string
  name: string
}

export type TableKind = 'table' | 'view' | 'matview' | 'foreign' | 'partitioned'

export interface TableMeta extends TableRef {
  kind: TableKind
  /**
   * Planner estimate (`pg_class.reltuples`), not a `COUNT(*)`. Counting every
   * row of every table just to render a sidebar is how a browser tool takes a
   * production database down; `-1` means "never analysed".
   */
  rowCountEstimate: number
  comment?: string | null
}

/**
 * The coarse bucket a column's SQL type falls into. Drives cell rendering,
 * the query-builder operator list and value coercion on commit.
 */
export type ValueCategory =
  | 'number'
  | 'string'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'interval'
  | 'json'
  | 'uuid'
  | 'array'
  | 'enum'
  | 'binary'
  | 'other'

export interface ForeignKeyRef {
  schema: string
  table: string
  column: string
  constraint?: string
}

export interface ColumnMeta {
  name: string
  /** Human SQL type as reported by the server, e.g. `character varying(255)`. */
  dataType: string
  /** Underlying type name, e.g. `varchar`, `int4`, `jsonb`, `_text`, `bytea`. */
  udtName: string
  category: ValueCategory
  nullable: boolean
  isPrimaryKey: boolean
  /** 1-based position within the primary key, for composite keys. */
  primaryKeyPosition?: number | null
  foreignKey?: ForeignKeyRef | null
  defaultValue?: string | null
  ordinal: number
  /** Labels for an enum column, in declaration order. */
  enumValues?: string[] | null
  /** True for `bytea`/large-object columns — never streamed inline. */
  isBinary?: boolean
  comment?: string | null
  /** True when the column is generated/identity and should not be written. */
  readOnly?: boolean
}

export interface TableSchema {
  table: TableRef
  columns: ColumnMeta[]
  /** Primary-key column names in key order; empty when the table has no PK. */
  primaryKey: string[]
  /** Views and PK-less tables cannot be safely updated row-by-row. */
  updatable: boolean
  /** Why `updatable` is false, shown verbatim in the UI. */
  notUpdatableReason?: string | null
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'isNotNull'
  | 'in'

export interface Filter {
  column: string
  op: FilterOperator
  value?: unknown
  values?: unknown[]
}

export type SortDirection = 'asc' | 'desc'

export interface SortSpec {
  column: string
  direction: SortDirection
}

/** Opaque to the UI: the ordering values of the last row of the previous page. */
export interface Cursor {
  /** Column name -> value, in ORDER BY order. */
  values: Array<{ column: string; value: unknown }>
  direction: 'after' | 'before'
}

export interface SelectQuery {
  table: TableRef
  /** Hard row cap. Adapters clamp this to their own maximum. */
  limit: number
  offset?: number
  sort?: SortSpec[]
  filters?: Filter[]
  cursor?: Cursor | null
  /** Restrict the projection; omit for every column. */
  columns?: string[]
}

export type PageStrategy = 'keyset' | 'offset'

export interface Page<R = Row> {
  rows: R[]
  columns: ColumnMeta[]
  limit: number
  strategy: PageStrategy
  /** True when the server had at least one more row than `limit`. */
  hasMore: boolean
  nextCursor?: Cursor | null
  prevCursor?: Cursor | null
  offset?: number
  /** Estimate only — never a blocking `COUNT(*)` unless `exactCount` was asked. */
  totalEstimate?: number | null
  durationMs?: number
}

export interface ResultColumn {
  name: string
  dataType?: string
  category?: ValueCategory
}

export interface QueryResult {
  columns: ResultColumn[]
  rows: Row[]
  rowCount: number
  /** True when the row cap kicked in and rows were withheld. */
  truncated: boolean
  limit: number
  durationMs: number
  /** `SELECT`, `INSERT`, … as reported by the server. */
  command?: string | null
  notices?: string[]
}

export interface RunQueryOptions {
  limit?: number
  /** Opt in to a write/DDL statement. Ignored when the adapter is read-only. */
  allowWrite?: boolean
  /** Opt in to `;`-separated statements. Off by default — see the README. */
  allowMultipleStatements?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

/** Primary-key column -> value. Every PK column must be present. */
export type PkValues = Record<string, unknown>

export interface BinaryCellMeta {
  /** Discriminator so the UI can tell a blob placeholder from a real value. */
  __dbbBinary: true
  bytes: number | null
  /** Sniffed content type when the adapter can tell, else null. */
  contentType?: string | null
}

export interface BinaryCellData extends BinaryCellMeta {
  /** base64 — only ever present on an explicit `fetchBinary` call. */
  base64: string
}

export interface DataSourceCapabilities {
  /** False when the connection is read-only; the UI hides every write path. */
  writes: boolean
  /** False when the adapter cannot do keyset pagination. */
  keyset: boolean
  /** True when `fetchBinary` is implemented. */
  binaryFetch: boolean
  /** Display label — never a connection string. */
  label?: string
}

export interface DataSource {
  /** Stable id for this connection, used to namespace client-side state. */
  readonly id: string
  capabilities(): DataSourceCapabilities

  listTables(): Promise<TableMeta[]>
  describeTable(table: TableRef): Promise<TableSchema>

  select(query: SelectQuery): Promise<Page>

  insert(table: TableRef, row: Row): Promise<Row>
  update(table: TableRef, pk: PkValues, patch: Row): Promise<Row>
  delete(table: TableRef, pk: PkValues): Promise<void>

  runQuery(sql: string, opts?: RunQueryOptions): Promise<QueryResult>

  /** Fetch one binary cell on demand. Optional. */
  fetchBinary?(table: TableRef, pk: PkValues, column: string): Promise<BinaryCellData>
}

export class DbBrowserError extends Error {
  readonly code: string
  readonly detail?: string
  constructor(code: string, message: string, detail?: string) {
    super(message)
    this.name = 'DbBrowserError'
    this.code = code
    this.detail = detail
  }
}
