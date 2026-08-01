/**
 * The schema contracts that make a database "not just tables".
 *
 * These live in the engine-agnostic package for one reason: **detection has to
 * be a shared, testable definition rather than a condition buried in one
 * adapter.** An embedding store is an embedding store because it has these
 * tables with these columns — not because someone passed a flag. Any adapter
 * that can list tables and columns can apply `matchesVectorStore` and get the
 * same answer, and the rule can be unit-tested without opening a file.
 *
 * The vector contract below is **fixed by agreement with the indexer** that
 * writes these files. Do not "improve" a column name here; it would silently
 * stop recognising every store already on disk.
 */

/** Tables a vector store must have, with the columns each must contain. */
export const VECTOR_STORE_CONTRACT = {
  chunk: [
    'id', 'path', 'start_line', 'end_line', 'kind',
    'symbol', 'content', 'token_count', 'content_sha', 'updated_at',
  ],
  embedding: ['chunk_id', 'model', 'dims', 'vector'],
  build_meta: ['key', 'value'],
} as const

/** `build_meta` keys the builder writes. Absent keys render as "unknown". */
export const BUILD_META_KEYS = {
  model: 'model',
  dims: 'dims',
  builtAt: 'built_at',
  chunkCount: 'chunk_count',
  repoRootRelative: 'repo_root_relative',
  toolVersion: 'tool_version',
  gitCommit: 'git_commit',
} as const

/**
 * A `code-review-graph` database. Read off the real file rather than invented:
 * `nodes` and `edges` are the two tables every build has, `metadata` carries
 * `schema_version`, and `communities`/`flows`/`risk_index` appear only once the
 * richer analysis passes have run — so they are *not* part of the match.
 */
export const CODE_GRAPH_CONTRACT = {
  nodes: ['id', 'kind', 'name', 'qualified_name', 'file_path'],
  edges: ['id', 'kind', 'source_qualified', 'target_qualified', 'file_path'],
  metadata: ['key', 'value'],
} as const

/** Optional tables that make the graph richer, if the build produced them. */
export const CODE_GRAPH_OPTIONAL_TABLES = [
  'communities',
  'community_summaries',
  'flows',
  'flow_memberships',
  'flow_snapshots',
  'risk_index',
] as const

/** Column names, lower-cased, for one table. */
export type ColumnIndex = ReadonlyMap<string, ReadonlySet<string>>

/** Build the lookup `matchesContract` wants from any introspection result. */
export function buildColumnIndex(
  tables: ReadonlyArray<{ name: string; columns: readonly string[] }>,
): ColumnIndex {
  const map = new Map<string, ReadonlySet<string>>()
  for (const t of tables) {
    map.set(t.name.toLowerCase(), new Set(t.columns.map((c) => c.toLowerCase())))
  }
  return map
}

export interface ContractMatch {
  matched: boolean
  /** Human-readable reason, shown in the UI so detection is never magic. */
  reason: string
  /** `table.column` entries the contract wanted and the database lacks. */
  missing: string[]
}

/**
 * Match a column index against a contract. **A superset passes**: a store that
 * has added a column since the contract was written is still a store, and
 * refusing to recognise it would turn every schema addition into an outage.
 * A *missing* column fails, because the UI would then read a column that is
 * not there.
 */
export function matchesContract(
  index: ColumnIndex,
  contract: Readonly<Record<string, readonly string[]>>,
  label: string,
): ContractMatch {
  const missing: string[] = []
  for (const [table, columns] of Object.entries(contract)) {
    const found = index.get(table.toLowerCase())
    if (!found) {
      missing.push(`${table} (table)`)
      continue
    }
    for (const column of columns) {
      if (!found.has(column.toLowerCase())) missing.push(`${table}.${column}`)
    }
  }
  return missing.length
    ? { matched: false, reason: `not a ${label}: missing ${missing.slice(0, 3).join(', ')}`, missing }
    : {
        matched: true,
        reason: `${label}: found ${Object.keys(contract).join(', ')} with the expected columns`,
        missing: [],
      }
}

export function matchesVectorStore(index: ColumnIndex): ContractMatch {
  return matchesContract(index, VECTOR_STORE_CONTRACT, 'embedding store')
}

export function matchesCodeGraph(index: ColumnIndex): ContractMatch {
  return matchesContract(index, CODE_GRAPH_CONTRACT, 'code graph')
}
