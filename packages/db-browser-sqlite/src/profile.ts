/**
 * Deciding what kind of database a SQLite file actually is.
 *
 * Detection is **structural**: a file is an embedding store because it has the
 * `chunk` + `embedding` + `build_meta` tables with the agreed columns, and a
 * code graph because it has `nodes` + `edges` + `metadata`. Nothing is
 * configured, nothing is inferred from the filename — point the browser at an
 * unknown `.db` and it works out what it is looking at, which is the only
 * behaviour that survives someone renaming the file.
 *
 * The contract itself lives in `@jugaaadi/db-browser/core`
 * (`vector/contract.ts`) so it is shared, testable without a driver, and cannot
 * drift between the detector and the UI that consumes the result.
 *
 * **Every query here is cheap.** Detection runs on connect and again after a
 * rebuild, so it must not scan an 85 MB file: the counts are `COUNT(*)` over
 * two tables (SQLite answers that from the B-tree without reading rows) and one
 * `GROUP BY` over a small text column. The vectors themselves are never read.
 */

import {
  buildColumnIndex,
  matchesCodeGraph,
  matchesVectorStore,
} from '@jugaaadi/db-browser/core'
import type {
  CodeGraphProfile,
  DatabaseProfile,
  VectorStoreProfile,
} from '@jugaaadi/db-browser/core'
import { CODE_GRAPH_OPTIONAL_TABLES } from '@jugaaadi/db-browser/core'
import type { SqliteDb } from './driver.js'
import { describeColumns } from './introspect.js'
import type { SqliteTableMeta } from './introspect.js'

/** The blob column that holds a vector, so the grid can label it as one. */
export const VECTOR_COLUMN = 'vector'

function count(db: SqliteDb, table: string): number {
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g, '""')}"`).get()
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

function tableExists(tables: readonly SqliteTableMeta[], name: string): boolean {
  return tables.some((t) => t.name.toLowerCase() === name.toLowerCase())
}

/** Every row of a `key`/`value` table, as an object. */
function keyValueTable(db: SqliteDb, table: string, keyCol = 'key', valueCol = 'value'): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const rows = db
      .prepare(`SELECT "${keyCol}" AS k, "${valueCol}" AS v FROM "${table}"`)
      .all() as unknown as Array<{ k: unknown; v: unknown }>
    for (const r of rows) out[String(r.k)] = String(r.v ?? '')
  } catch {
    /* the table is missing or shaped differently — an empty map is honest */
  }
  return out
}

function histogram(db: SqliteDb, table: string, column: string): Array<{ kind: string; count: number }> {
  try {
    const rows = db
      .prepare(
        `SELECT "${column}" AS k, count(*) AS n FROM "${table}" GROUP BY "${column}" ORDER BY n DESC`,
      )
      .all() as unknown as Array<{ k: unknown; n: unknown }>
    return rows.map((r) => ({ kind: String(r.k ?? ''), count: Number(r.n ?? 0) }))
  } catch {
    return []
  }
}

const asInt = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function readVectorProfile(db: SqliteDb): VectorStoreProfile {
  const meta = keyValueTable(db, 'build_meta')
  const chunkCount = count(db, 'chunk')
  const embeddingCount = count(db, 'embedding')

  // `DISTINCT model` over the embedding table: more than one value means the
  // index was appended to with a different model, and similarity between
  // vectors from different models is not a meaningful number. Cheap even at
  // 13k rows, and it is the only way to detect a mixed index at all.
  let models: string[] = []
  try {
    const rows = db
      .prepare('SELECT DISTINCT model FROM embedding ORDER BY model')
      .all() as unknown as Array<{ model: unknown }>
    models = rows.map((r) => String(r.model ?? '')).filter(Boolean)
  } catch {
    models = []
  }

  // Dimensions: prefer what the rows actually say over what build_meta claims,
  // because build_meta is written once and the rows are the thing that will be
  // decoded. They agree in a healthy index; when they do not, the rows win.
  let dims = asInt(meta.dims)
  try {
    const row = db.prepare('SELECT dims FROM embedding LIMIT 1').get()
    const fromRow = row?.dims == null ? null : Number(row.dims)
    if (fromRow && Number.isFinite(fromRow)) dims = fromRow
  } catch {
    /* keep the build_meta value */
  }

  return {
    model: meta.model || models[0] || null,
    dims,
    chunkCount,
    embeddingCount,
    builtAt: meta.built_at || null,
    gitCommit: meta.git_commit || null,
    repoRootRelative: meta.repo_root_relative || null,
    toolVersion: meta.tool_version || null,
    meta,
    models,
    // Drives the kind filter's chips and counts, so the filter always offers
    // exactly the kinds this index contains rather than a hardcoded list.
    kinds: histogram(db, 'chunk', 'kind'),
  }
}

export function readCodeGraphProfile(db: SqliteDb, tables: readonly SqliteTableMeta[]): CodeGraphProfile {
  const meta = keyValueTable(db, 'metadata')
  return {
    schemaVersion: meta.schema_version || null,
    nodeCount: count(db, 'nodes'),
    edgeCount: count(db, 'edges'),
    nodeKinds: histogram(db, 'nodes', 'kind'),
    edgeKinds: histogram(db, 'edges', 'kind'),
    // `null` (not 0) when the table is absent: "this build did not run the
    // community pass" and "it ran and found none" are different facts.
    communityCount: tableExists(tables, 'communities') ? count(db, 'communities') : null,
    flowCount: tableExists(tables, 'flows') ? count(db, 'flows') : null,
    meta,
  }
}

/**
 * Classify the open database.
 *
 * Vector is checked before code graph only because the two contracts are
 * disjoint — a file cannot satisfy both — so the order is arbitrary and stated
 * here so nobody assumes a precedence rule exists.
 */
export function profileDatabase(db: SqliteDb, tables: readonly SqliteTableMeta[]): DatabaseProfile {
  const index = buildColumnIndex(
    tables.map((t) => ({
      name: t.name,
      columns: describeColumns(db, t).map((c) => c.name),
    })),
  )

  const vector = matchesVectorStore(index)
  if (vector.matched) {
    return {
      mode: 'vector',
      detectedBy: vector.reason,
      vector: readVectorProfile(db),
      backingTables: ['chunk', 'embedding', 'build_meta'],
    }
  }

  const graph = matchesCodeGraph(index)
  if (graph.matched) {
    return {
      mode: 'code-graph',
      detectedBy: graph.reason,
      graph: readCodeGraphProfile(db, tables),
      backingTables: [
        'nodes',
        'edges',
        'metadata',
        ...CODE_GRAPH_OPTIONAL_TABLES.filter((t) => tableExists(tables, t)),
      ],
    }
  }

  return {
    mode: 'relational',
    // Report the *nearer* miss, so "why is this not showing the search UI"
    // has an answer that names the missing table instead of saying nothing.
    detectedBy:
      vector.missing.length <= graph.missing.length ? vector.reason : graph.reason,
  }
}

/**
 * Which blob columns hold embedding vectors, keyed by table name. Feeds
 * `describeColumns` so the cell reads `768 dims · 3.0 KB` rather than
 * `[binary · 3.0 KB]`.
 */
export function vectorColumnsFor(mode: DatabaseProfile['mode'], table: string): Set<string> {
  if (mode !== 'vector') return new Set()
  return table.toLowerCase() === 'embedding' ? new Set([VECTOR_COLUMN]) : new Set()
}
