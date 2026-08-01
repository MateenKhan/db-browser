/**
 * The transport-agnostic contract every db-browser front end talks to.
 *
 * A browser cannot open a TCP socket to Postgres, so the UI never knows *how*
 * rows arrive — it only knows this interface. Ship the reference Postgres
 * adapter in a Node process and the HTTP adapter in the browser, or implement
 * `DataSource` yourself over whatever transport you already have.
 */

import type { SqlDialect } from './sql/dialect.js'
import type { NormalizedType } from './metadata/normalizedTypes.js'

export type Row = Record<string, unknown>

export interface TableRef {
  schema: string
  name: string
}

/**
 * `virtual` covers SQLite's virtual tables (FTS5, R*Tree, and their `shadow`
 * backing tables). They are surfaced so they can be *browsed*, but never
 * written to: a virtual table's rows are produced by a module, so "update this
 * row" is not a statement the engine is obliged to honour the way it is for a
 * real B-tree.
 */
export type TableKind = 'table' | 'view' | 'matview' | 'foreign' | 'partitioned' | 'virtual'

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
  /**
   * A blob the adapter has identified as an embedding vector. A *sub-case* of
   * `binary` rather than a replacement, so every binary safeguard still
   * applies (never projected inline, never editable as text); it exists only so
   * the cell can read `768 dims · 3.0 KB` instead of `[binary · 3.0 KB]`.
   */
  | 'vector'
  | 'other'

export interface ForeignKeyRef {
  schema: string
  table: string
  column: string
  constraint?: string
}

/**
 * One column, as every engine's introspection is normalised into.
 *
 * ## The two vocabularies, and why both are here
 *
 * `dbType`/`normalizedType` are the **metadata-driven** pair introduced with
 * the connector registry: `dbType` is whatever the engine called it, and
 * `normalizedType` is that name resolved through the connector descriptor's
 * `typeMap` into a closed, engine-agnostic vocabulary. This is the pair the
 * grid and the UI read, and it is what makes "add an engine" a descriptor
 * rather than a code change.
 *
 * `dataType`/`udtName`/`category` are the **original** Postgres-shaped trio.
 * They are kept, not deprecated into uselessness, for two concrete reasons:
 * `category` carries distinctions `normalizedType` deliberately does not
 * (`interval`, and `other`), and `udtName` is what the existing SQL builders
 * and the vector-store detection already resolve against. Every adapter
 * populates all six through `finalizeColumn()`, so neither vocabulary can go
 * stale relative to the other.
 */
export interface ColumnMeta {
  name: string
  /** Human SQL type as reported by the server, e.g. `character varying(255)`. */
  dataType: string
  /** Underlying type name, e.g. `varchar`, `int4`, `jsonb`, `_text`, `bytea`. */
  udtName: string
  /**
   * The raw type name the engine reported, verbatim and lower-cased — the key
   * a descriptor's `typeMap` is looked up with. Usually equal to `udtName`;
   * they differ where an engine reports two spellings (Postgres's `_text` vs
   * `text[]`) and the more literal one is the better map key.
   */
  dbType: string
  /**
   * `dbType` resolved through the connector descriptor's `typeMap`. Unknown
   * types normalise to `'unknown'` and render as read-only text — never an
   * exception. See `metadata/normalizedTypes.ts`.
   */
  normalizedType: NormalizedType
  category: ValueCategory
  nullable: boolean
  isPrimaryKey: boolean
  /**
   * Whether this column participates in a foreign key. Redundant with
   * `foreignKey != null` and kept in step by `finalizeColumn()`; it exists
   * because "is this a link?" is a boolean the UI asks on every cell render
   * and should not have to null-check a nested object for.
   */
  isForeignKey: boolean
  /** 1-based position within the primary key, for composite keys. */
  primaryKeyPosition?: number | null
  /**
   * The referenced table and column, engine-agnostically. `foreignKey` carries
   * the same fact plus the schema and constraint name, which not every engine
   * reports; `references` is the subset every engine can answer.
   */
  references?: { table: string; column: string } | null
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

/**
 * How a single row is addressed for an `UPDATE`/`DELETE`.
 *
 *  - `primary-key` — a declared `PRIMARY KEY`. The only case Postgres offers.
 *  - `implicit` — a key the engine maintains but never declared as a column,
 *    i.e. SQLite's `rowid`. Just as unique as a PK for addressing one row, but
 *    **not stable across a `VACUUM`**, so it is labelled in the UI rather than
 *    quietly passed off as a primary key.
 *  - `none` — no key. Editing is refused; see `describeUpdatability`.
 */
export type RowIdentityKind = 'primary-key' | 'implicit' | 'none'

export interface TableSchema {
  table: TableRef
  columns: ColumnMeta[]
  /**
   * The columns that address one row, in key order. Normally the declared
   * primary key; for a SQLite rowid table with no PK it is `['rowid']` and
   * `rowIdentity` is `implicit`.
   */
  primaryKey: string[]
  /** Views and key-less tables cannot be safely updated row-by-row. */
  updatable: boolean
  /** Why `updatable` is false, shown verbatim in the UI. */
  notUpdatableReason?: string | null
  /** What `primaryKey` actually is. Absent means `primary-key`/`none`. */
  rowIdentity?: RowIdentityKind
  /**
   * Shown in the UI whenever the identity is not a declared primary key, so
   * "this table is editable" is never an unexplained claim.
   */
  identityNote?: string | null
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
  /**
   * Set when the adapter knows the blob is an embedding vector, so the cell can
   * read `768 dims · 3.0 KB` instead of `[binary · 3.0 KB]`. Rendering the
   * floats themselves is never an option — 768 numbers in a grid cell is not
   * information, it is a wall.
   */
  dims?: number | null
  /** The model that produced the vector, when the row carries one. */
  model?: string | null
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
  /**
   * Which SQL dialect the far end speaks. Drives editor highlighting and
   * completion, formatting, and which extra denylist the guard applies.
   * Defaults to `postgres` when an adapter does not declare one.
   */
  dialect?: SqlDialect
  /** True when `describeDatabase` is implemented. */
  profile?: boolean
}

// ---------------------------------------------------------------------------
// Database profiles: not every SQLite file is relational data
// ---------------------------------------------------------------------------

/**
 * What *kind* of database this is, decided by looking at the schema rather than
 * by configuration — a file either has the tables that make it an embedding
 * store or it does not.
 */
export type DatabaseMode = 'relational' | 'vector' | 'code-graph'

/**
 * An embedding store, recognised by the `chunk` + `embedding` + `build_meta`
 * contract. The numbers come from `build_meta` (which the builder writes) and
 * from cheap `COUNT(*)`s over two small tables — not from reading vectors.
 */
export interface VectorStoreProfile {
  /** Embedding model id, e.g. `text-embedding-3-small`. */
  model: string | null
  /** Vector width. Every row in `embedding` must agree with this. */
  dims: number | null
  chunkCount: number
  embeddingCount: number
  /** ISO timestamp from `build_meta.built_at`. */
  builtAt: string | null
  /** The commit the index was built from, so staleness is visible. */
  gitCommit: string | null
  /** Path the stored `chunk.path` values are relative to. */
  repoRootRelative: string | null
  toolVersion: string | null
  /** Every `build_meta` key/value, so nothing the builder wrote is hidden. */
  meta: Record<string, string>
  /** Distinct `embedding.model` values — more than one means a mixed index. */
  models: string[]
  /**
   * `chunk.kind` histogram, biggest first. Drives the kind filter's options and
   * their counts, so the filter always offers exactly the kinds this index
   * actually contains rather than a hardcoded list that silently goes stale.
   */
  kinds: Array<{ kind: string; count: number }>
}

/** A `code-review-graph` database: symbols and the edges between them. */
export interface CodeGraphProfile {
  schemaVersion: string | null
  nodeCount: number
  edgeCount: number
  /** `nodes.kind` histogram, biggest first. */
  nodeKinds: Array<{ kind: string; count: number }>
  /** `edges.kind` histogram, biggest first. */
  edgeKinds: Array<{ kind: string; count: number }>
  /** Optional analysis tables, present only in richer builds. */
  communityCount: number | null
  flowCount: number | null
  /** Every `metadata` key/value row. */
  meta: Record<string, string>
}

export interface DatabaseProfile {
  mode: DatabaseMode
  /** Why `mode` is what it is — shown in the UI so detection is never magic. */
  detectedBy: string
  vector?: VectorStoreProfile | null
  graph?: CodeGraphProfile | null
  /**
   * Tables that back the special mode (`chunk`, `embedding`, …). The grid can
   * still open them — this list only drives which ones get a badge.
   */
  backingTables?: string[]
}

// ---------------------------------------------------------------------------
// Semantic search + rebuild: served by the indexer, not by the SQL connection
// ---------------------------------------------------------------------------

export interface VectorSearchHit {
  path: string
  startLine: number
  endLine: number
  symbol?: string | null
  kind?: string | null
  /** Cosine similarity. Vectors are L2-normalised, so this is a dot product. */
  score: number
  snippet?: string | null
  chunkId?: string | number | null
}

/**
 * Narrowing applied to a search.
 *
 * These exist because of a measured failure, not a hunch. Against Piranha's
 * real index (13,482 chunks: 6,139 `function`, 2,623 `file`, 2,473 `class`,
 * 2,247 `doc`) the query *"how are secrets encrypted before being stored"*
 * returned **five documentation chunks and zero code**, even though the file
 * that actually does it is indexed with function-level chunks. The reason is
 * structural rather than a ranking bug: **prose matches prose.** A paragraph
 * describing encryption is a closer neighbour to an English question than the
 * function performing it, so on any conceptual query docs beat code — and docs
 * are only 17% of the index, so the effect is invisible from the totals.
 *
 * A `kind` filter is the fix, because the user always knows which they want:
 * "where is this implemented" wants `function`+`class`, "how does this work"
 * wants `doc`. Making that one click turns a search that looks broken into one
 * that answers the question.
 */
export interface VectorSearchFilters {
  /** Chunk kinds to keep. Empty or absent means every kind. */
  kinds?: string[]
  /** Keep only hits whose `path` starts with this, e.g. `backend/`. */
  pathPrefix?: string
}

export interface VectorSearchResult {
  hits: VectorSearchHit[]
  durationMs?: number
  /** Echoed back so a stale response cannot be painted over a newer query. */
  query: string
  /**
   * True when the index service ignored the filter parameters and the hits had
   * to be narrowed here instead. Surfaced in the UI because it changes what the
   * results mean: client-side filtering can only narrow what one over-fetched
   * page happened to contain, so a filtered result is a *subset of the top N*,
   * not the top N of that kind.
   */
  filteredClientSide?: boolean
  /** How many hits came back before filtering. */
  fetched?: number
}

/** The phases the builder reports. `done`/`failed` are terminal. */
export type RebuildPhase = 'queued' | 'scan' | 'chunk' | 'embed' | 'write' | 'done' | 'failed'

export interface RebuildProgress {
  phase: RebuildPhase
  processed: number
  total: number
  /** 0–100. Recomputed from processed/total when the server omits it. */
  percent: number
  message?: string | null
}

export interface RebuildJob extends RebuildProgress {
  id: string
  status: 'running' | 'succeeded' | 'failed'
  /** The server's own failure message — never replaced with a generic one. */
  error?: string | null
  startedAt?: string | null
  finishedAt?: string | null
}

/**
 * Search and rebuild do not belong on `DataSource`: they are served by the
 * *indexer* (Piranha's db-server), which is a different process from the one
 * holding the SQL connection and may not be running at all. Keeping them on a
 * separate, optional interface is what lets the browser degrade to "the index
 * service is unavailable" instead of failing the whole page.
 */
export interface VectorService {
  /** Stable id, used to namespace the in-flight-job record. */
  readonly id: string
  search(
    query: string,
    limit: number,
    signal?: AbortSignal,
    filters?: VectorSearchFilters,
  ): Promise<VectorSearchResult>
  /** Starts a build and returns immediately with a job id. */
  startRebuild(): Promise<RebuildJob>
  /** Poll one job. Should resolve even for a finished job. */
  rebuildStatus(jobId: string): Promise<RebuildJob>
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

  /**
   * What kind of database this is. Optional: an adapter that does not
   * implement it is treated as `relational`, which is what every Postgres
   * connection is.
   */
  describeDatabase?(): Promise<DatabaseProfile>
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
