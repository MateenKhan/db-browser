/**
 * End-to-end verification against real databases. Run with `node verify.mjs`.
 * Read-only throughout: it never writes to any file it opens.
 */
import { createSqliteDataSource } from '@jugaaadi/db-browser-sqlite'
import { decodeFloat32LE, dotProduct, isNormalized, l2Norm } from '@jugaaadi/db-browser/core'

const line = (t) => console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`)
const ok = (t) => console.log(`  PASS  ${t}`)
const fail = (t) => {
  console.log(`  FAIL  ${t}`)
  process.exitCode = 1
}
const assert = (cond, t) => (cond ? ok(t) : fail(t))

// ---------------------------------------------------------------------------
line('1. code-review-graph — base-app/.code-review-graph/graph.db')
// ---------------------------------------------------------------------------
const GRAPH_DB = process.env.CODE_GRAPH_DB ?? './data/graph.db'
const BIG_GRAPH_DB =
  process.env.BIG_GRAPH_DB ?? './data/graph-large.db'
const VECTOR_DB = process.env.EMBEDDINGS_DB ?? '/path/to/code-embeddings.db'

const graph = await createSqliteDataSource({ filename: GRAPH_DB })
const gTables = await graph.listTables()
console.log(`tables: ${gTables.length}`)
console.table(
  gTables.map((t) => ({ name: t.name, kind: t.kind, est: t.rowCountEstimate })),
)
const gSchema = await graph.describeTable({ schema: 'main', name: 'nodes' })
console.log('\nnodes columns:')
console.table(
  gSchema.columns.map((c) => ({
    name: c.name,
    type: c.dataType,
    cat: c.category,
    null: c.nullable,
    pk: c.isPrimaryKey,
    fk: c.foreignKey ? `${c.foreignKey.table}.${c.foreignKey.column}` : '',
  })),
)
console.log('primaryKey:', gSchema.primaryKey, '| rowIdentity:', gSchema.rowIdentity)
const gPage = await graph.select({ table: { schema: 'main', name: 'metadata' }, limit: 5 })
console.log('\nmetadata page:', JSON.stringify(gPage.rows), '| strategy:', gPage.strategy)
assert(gTables.length === 15, 'lists 15 objects')
assert(gPage.rows.length === 1, 'metadata has one row')
graph.close()

// ---------------------------------------------------------------------------
line('2. Populated code graph — remote_manufacturing (pagination)')
// ---------------------------------------------------------------------------
const big = await createSqliteDataSource({ filename: BIG_GRAPH_DB })
const nodes = { schema: 'main', name: 'nodes' }
const short = (s) => String(s ?? '').replace(/\\/g, '/').split('/').slice(-2).join('/')
const p1 = await big.select({ table: nodes, limit: 3 })
console.log(`page 1 (${p1.strategy}, hasMore=${p1.hasMore}):`)
console.table(p1.rows.map((r) => ({ id: r.id, kind: r.kind, name: short(r.name), file: short(r.file_path) })))
const p2 = await big.select({ table: nodes, limit: 3, cursor: p1.nextCursor })
console.log(`page 2 (${p2.strategy}, hasMore=${p2.hasMore}):`)
console.table(p2.rows.map((r) => ({ id: r.id, kind: r.kind, name: short(r.name), file: short(r.file_path) })))
const p3 = await big.select({ table: nodes, limit: 3, cursor: p2.nextCursor })
console.log(`page 3 (${p3.strategy}):`)
console.table(p3.rows.map((r) => ({ id: r.id, kind: r.kind, name: short(r.name) })))
assert(p1.strategy === 'keyset', 'nodes uses keyset pagination (INTEGER PRIMARY KEY)')
assert(p1.rows.length === 3 && p2.rows.length === 3, 'each page returns the requested rows')
const ids = new Set([...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id))
assert(ids.size === 9, 'three keyset pages return nine distinct rows (no overlap, no gap)')

// filter + sort
const filtered = await big.select({
  table: nodes,
  limit: 4,
  filters: [{ column: 'kind', op: 'eq', value: 'Class' }],
  sort: [{ column: 'name', direction: 'asc' }],
})
console.log('\nfiltered kind=Class, sorted by name:')
console.table(filtered.rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name })))
assert(
  filtered.rows.every((r) => r.kind === 'Class'),
  'the equality filter is applied',
)

// ---------------------------------------------------------------------------
line('3. rowid fallback — sqlite_sequence has no PRIMARY KEY')
// ---------------------------------------------------------------------------
const seq = await big.describeTable({ schema: 'main', name: 'sqlite_sequence' })
console.log('columns   :', seq.columns.map((c) => `${c.name}:${c.dataType}`).join(', '))
console.log('primaryKey:', seq.primaryKey)
console.log('updatable :', seq.updatable, '| rowIdentity:', seq.rowIdentity)
console.log('note      :', seq.identityNote)
assert(seq.updatable === true, 'a PK-less rowid table IS editable')
assert(seq.rowIdentity === 'implicit', 'identity is reported as implicit, not as a primary key')
assert(seq.primaryKey.join() === 'rowid', 'the key is rowid')
const seqPage = await big.select({ table: { schema: 'main', name: 'sqlite_sequence' }, limit: 3 })
console.log('rows      :', JSON.stringify(seqPage.rows))
assert(
  seqPage.rows.every((r) => typeof r.rowid === 'number'),
  'rowid is projected so the grid can key on it',
)

// A view has no rowid, so it must stay read-only.
line('3b. no-rowid tables stay read-only')
const graphViews = (await big.listTables()).filter((t) => t.kind === 'view' || t.kind === 'virtual')
for (const v of graphViews.slice(0, 3)) {
  const s = await big.describeTable(v)
  console.log(
    `${v.name.padEnd(24)} kind=${v.kind.padEnd(8)} updatable=${String(s.updatable).padEnd(5)} pk=[${s.primaryKey}] reason=${s.notUpdatableReason?.slice(0, 60) ?? ''}`,
  )
}
big.close()

// ---------------------------------------------------------------------------
line('4. Vector store — piranha/.embeddings/code-embeddings.db')
// ---------------------------------------------------------------------------
const vec = await createSqliteDataSource({ filename: VECTOR_DB })
const vProfile = await vec.describeDatabase()
console.log('mode      :', vProfile.mode)
console.log('detectedBy:', vProfile.detectedBy)
console.log('model     :', vProfile.vector.model, '| dims:', vProfile.vector.dims)
console.log('chunks    :', vProfile.vector.chunkCount, '| vectors:', vProfile.vector.embeddingCount)
console.log('builtAt   :', vProfile.vector.builtAt, '| commit:', vProfile.vector.gitCommit)
console.log('kinds     :', vProfile.vector.kinds.map((k) => `${k.kind}=${k.count}`).join(' '))
assert(vProfile.mode === 'vector', 'detected as a vector store')
assert(vProfile.vector.dims === 768, 'dims read as 768')

console.log('\nembedding schema:')
const eSchema = await vec.describeTable({ schema: 'main', name: 'embedding' })
console.table(
  eSchema.columns.map((c) => ({
    name: c.name,
    type: c.dataType,
    category: c.category,
    binary: !!c.isBinary,
    pk: c.isPrimaryKey,
  })),
)
const vecCol = eSchema.columns.find((c) => c.name === 'vector')
assert(vecCol.category === 'vector', 'the vector BLOB column is categorised as `vector`')
assert(vecCol.isBinary === true, 'it is binary, so it is never projected inline')

const ePage = await vec.select({ table: { schema: 'main', name: 'embedding' }, limit: 3 })
console.log('\nembedding rows (note: the vector cell is metadata, never floats):')
console.log(JSON.stringify(ePage.rows, null, 1))
assert(
  ePage.rows.every((r) => r.vector.__dbbBinary === true && r.vector.dims === 768),
  'the vector cell is a placeholder carrying dims=768, not 768 floats',
)

console.log('\nchunk page 1:')
const cPage = await vec.select({ table: { schema: 'main', name: 'chunk' }, limit: 3 })
console.table(
  cPage.rows.map((r) => ({ id: r.id, kind: r.kind, symbol: r.symbol, path: r.path, lines: `${r.start_line}-${r.end_line}` })),
)
const cPage2 = await vec.select({ table: { schema: 'main', name: 'chunk' }, limit: 3, cursor: cPage.nextCursor })
console.log('chunk page 2:')
console.table(cPage2.rows.map((r) => ({ id: r.id, kind: r.kind, symbol: r.symbol })))
assert(cPage.strategy === 'keyset' && cPage2.rows[0].id > cPage.rows[2].id, 'chunk paginates forward by keyset')

// ---------------------------------------------------------------------------
line('5. BLOB -> Float32Array decoding, against real stored vectors')
// ---------------------------------------------------------------------------
const blob = await vec.fetchBinary({ schema: 'main', name: 'embedding' }, { chunk_id: 1 }, 'vector')
console.log('bytes:', blob.bytes, '| dims:', blob.dims, '| base64 length:', blob.base64.length)
const buf = Buffer.from(blob.base64, 'base64')
const floats = decodeFloat32LE(buf, 768)
console.log('decoded:', floats.length, 'floats; first 6:', Array.from(floats.slice(0, 6)).map((f) => f.toFixed(6)).join(', '))
console.log('L2 norm:', l2Norm(floats).toFixed(8))
assert(blob.bytes === 3072, 'the stored blob is 768 * 4 = 3072 bytes')
assert(floats.length === 768, 'it decodes to exactly 768 float32s')
assert(isNormalized(floats), 'the stored vector is L2-normalised, as the contract states')

const blob2 = await vec.fetchBinary({ schema: 'main', name: 'embedding' }, { chunk_id: 2 }, 'vector')
const floats2 = decodeFloat32LE(Buffer.from(blob2.base64, 'base64'), 768)
const sim = dotProduct(floats, floats2)
console.log(`\ndot(chunk 1, chunk 2) = ${sim.toFixed(6)}  (== cosine, because both are unit vectors)`)
assert(sim >= -1.0001 && sim <= 1.0001, 'the dot product is a valid cosine in [-1, 1]')
assert(Math.abs(dotProduct(floats, floats) - 1) < 1e-3, 'dot(v, v) == 1 for a unit vector')

// ---------------------------------------------------------------------------
line('6. The SQL guard, on a real read-only connection')
// ---------------------------------------------------------------------------
const allowed = [
  "SELECT path, symbol FROM chunk WHERE kind = 'class' LIMIT 3",
  'SELECT count(*) AS n FROM embedding',
  "SELECT type, name FROM sqlite_master WHERE type = 'table'",
  'WITH t AS (SELECT kind, count(*) n FROM chunk GROUP BY kind) SELECT * FROM t',
]
for (const sql of allowed) {
  try {
    const r = await vec.runQuery(sql, { limit: 5 })
    ok(`ALLOWED  ${sql.slice(0, 58)}  ->  ${r.rowCount} row(s)`)
  } catch (e) {
    fail(`ALLOWED  ${sql}  ->  unexpectedly rejected: ${e.message}`)
  }
}

const blocked = [
  ["ATTACH DATABASE '/tmp/exfil.db' AS x", 'ATTACH'],
  ["DETACH DATABASE x", 'DETACH'],
  ['PRAGMA journal_mode=WAL', 'PRAGMA write'],
  ['PRAGMA user_version = 9', 'PRAGMA write'],
  ["VACUUM INTO '/tmp/copy.db'", 'VACUUM INTO'],
  ["SELECT writefile('/tmp/pwn', content) FROM chunk", 'writefile()'],
  ["SELECT readfile('/etc/passwd')", 'readfile()'],
  ["SELECT load_extension('evil.so')", 'load_extension()'],
  ['SELECT * FROM sqlite_dbpage', 'sqlite_dbpage'],
  ['SELECT 1; DROP TABLE chunk', 'stacked statements'],
  ["SELECT 1; ATTACH DATABASE '/tmp/x' AS y", 'stacked ATTACH'],
  ['DELETE FROM chunk', 'DELETE'],
  ['UPDATE chunk SET path = 1', 'UPDATE'],
  ['DROP TABLE chunk', 'DROP'],
  ["CREATE TABLE evil AS SELECT * FROM chunk", 'CREATE'],
  ["SELECT * INTO backup FROM chunk", 'SELECT INTO'],
]
for (const [sql, why] of blocked) {
  try {
    await vec.runQuery(sql, { limit: 5 })
    fail(`BLOCKED  ${why.padEnd(20)} ${sql.slice(0, 46)}  ->  WAS ALLOWED`)
  } catch (e) {
    ok(`BLOCKED  ${why.padEnd(20)} ${sql.slice(0, 44).padEnd(46)}  ${e.code}`)
  }
}

// ---------------------------------------------------------------------------
line('7. Driver-level read-only — the layer the guard cannot be talked out of')
// ---------------------------------------------------------------------------
// Bypass the guard entirely by going straight to the driver, proving that even
// a statement the regex somehow let through is refused by SQLite itself.
const { openSqlite } = await import('@jugaaadi/db-browser-sqlite')
const raw = await openSqlite({ filename: VECTOR_DB, readOnly: true })
for (const sql of ['DELETE FROM chunk', 'CREATE TABLE evil(a)', "PRAGMA journal_mode=WAL"]) {
  try {
    raw.prepare(sql).run()
    fail(`driver allowed: ${sql}`)
  } catch (e) {
    ok(`driver refused: ${sql.padEnd(26)} ${e.message.slice(0, 44)}`)
  }
}
raw.close()
vec.close()

console.log('\n' + '='.repeat(74))
console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED')
console.log('='.repeat(74))
