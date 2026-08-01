/**
 * Live schema introspection for SQLite.
 *
 * Same contract as the Postgres adapter's `introspect.ts` — and for the same
 * reason: every identifier that ever reaches a statement is resolved against
 * *these* results first, so a name the database never reported cannot be
 * interpolated. See `@jugaaadi/db-browser/core`'s `identifiers.ts` for the
 * other half of that rule.
 *
 * What is genuinely different from Postgres, and why each mattered:
 *
 *  - **`pragma`, not catalog tables.** `sqlite_master` gives the object list
 *    and its DDL; `pragma table_info` / `foreign_key_list` / `index_list` give
 *    the columns and constraints. `pragma table_list` (SQLite 3.37+) is used
 *    where available because it is the only source for the **`WITHOUT ROWID`**
 *    flag, which decides whether the rowid fallback below is even legal.
 *  - **`PRIMARY KEY` does not imply `NOT NULL`.** In SQLite — for
 *    compatibility with an early bug that was never fixed because too much data
 *    depended on it — only an `INTEGER PRIMARY KEY` is implicitly `NOT NULL`.
 *    `CREATE TABLE t(k TEXT PRIMARY KEY)` genuinely accepts a NULL `k`. So
 *    nullability comes from `table_info.notnull` **only**, never inferred from
 *    `pk`, and the pagination planner is handed that truth (a nullable ordering
 *    column silently drops rows from a keyset page).
 *  - **`rowid` is a real, usable key.** See `rowIdentityFor`.
 */

import { finalizeColumn } from '@jugaaadi/db-browser/core'
import type { ColumnMeta, TableKind, TableMeta } from '@jugaaadi/db-browser/core'
import { SQLITE_TYPE_MAP } from '@jugaaadi/db-browser-connectors'
import { categoryForSqliteType, isBinaryCategory } from './affinity.js'
import type { SqliteDb } from './driver.js'

/**
 * SQLite's one namespace-ish concept. `main` is the opened file; `temp` holds
 * session-scoped objects. Both are real and both are browsable, so `schema` in
 * a `TableRef` carries the database name.
 */
export const MAIN_SCHEMA = 'main'

/**
 * The three names SQLite accepts for the implicit rowid, in preference order.
 * All three are *only* available when the table has not shadowed them with a
 * real column of that name — which is why `rowIdentityFor` checks.
 */
export const ROWID_ALIASES = ['rowid', '_rowid_', 'oid'] as const

interface MasterRow {
  type: string
  name: string
  sql: string | null
}

interface TableListRow {
  schema: string
  name: string
  type: string
  ncol: number
  /** 1 when the table is `WITHOUT ROWID`. */
  wr: number
  strict: number
}

interface TableInfoRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  /** 0, or the 1-based position in the primary key. */
  pk: number
}

interface ForeignKeyRow {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
}

const KIND_BY_TYPE: Record<string, TableKind> = {
  table: 'table',
  view: 'view',
  virtual: 'virtual',
  // A `shadow` table is FTS5/R*Tree internal storage. It is a real B-tree and
  // is perfectly readable, but writing to one corrupts the index it backs, so
  // it is surfaced as `virtual` — which this library already treats read-only.
  shadow: 'virtual',
}

/**
 * Objects SQLite maintains for itself. `sqlite_sequence` is deliberately *not*
 * hidden: it is the AUTOINCREMENT counter, it is genuinely interesting when
 * debugging an id sequence, and it is the clearest real-world example of a
 * PK-less rowid table this library can offer.
 */
function isInternal(name: string): boolean {
  return name.startsWith('sqlite_') && name !== 'sqlite_sequence'
}

export interface SqliteTableMeta extends TableMeta {
  /** `WITHOUT ROWID` — no implicit key exists, so no rowid fallback. */
  withoutRowid: boolean
  /** The `CREATE` statement, shown as the table's comment. */
  ddl: string | null
}

/**
 * List every table and view.
 *
 * Row counts are **estimates read from `sqlite_stat1`**, the table `ANALYZE`
 * writes. Running `COUNT(*)` per table to fill a sidebar is a full scan of the
 * whole database on every page load — on an 85 MB embedding store that is real
 * work for a number nobody asked for. `-1` means "never analysed", which the
 * UI renders as `—` rather than as zero.
 */
export function listTables(db: SqliteDb): SqliteTableMeta[] {
  const master = db.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE type IN ('table','view') ORDER BY type, name`,
  ).all() as unknown as MasterRow[]

  const byName = new Map<string, MasterRow>()
  for (const r of master) byName.set(r.name, r)

  // `pragma table_list` is the only source of the WITHOUT ROWID flag and of the
  // virtual/shadow distinction. It needs SQLite 3.37+; older builds fall back
  // to sqlite_master alone, which loses those two facts but still lists tables.
  let list: TableListRow[] = []
  try {
    list = db.prepare('SELECT * FROM pragma_table_list').all() as unknown as TableListRow[]
  } catch {
    list = []
  }
  const listByName = new Map<string, TableListRow>()
  for (const r of list) {
    if (r.schema === MAIN_SCHEMA || r.schema === 'temp') listByName.set(r.name, r)
  }

  const estimates = rowEstimates(db)
  const names = new Set<string>([...byName.keys(), ...listByName.keys()])

  const out: SqliteTableMeta[] = []
  for (const name of names) {
    if (isInternal(name)) continue
    const info = listByName.get(name)
    const m = byName.get(name)
    const type = info?.type ?? m?.type ?? 'table'
    out.push({
      schema: info?.schema ?? MAIN_SCHEMA,
      name,
      kind: KIND_BY_TYPE[type] ?? 'table',
      rowCountEstimate: estimates.get(name) ?? -1,
      comment: m?.sql ?? null,
      withoutRowid: info?.wr === 1,
      ddl: m?.sql ?? null,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * `sqlite_stat1.stat` is a space-separated list whose **first** field is the
 * estimated row count of the table. Absent until someone runs `ANALYZE`, which
 * is why this is best-effort and the result is labelled an estimate.
 */
function rowEstimates(db: SqliteDb): Map<string, number> {
  const out = new Map<string, number>()
  try {
    const rows = db.prepare('SELECT tbl, stat FROM sqlite_stat1').all() as unknown as Array<{
      tbl: string
      stat: string
    }>
    for (const r of rows) {
      const n = Number(String(r.stat ?? '').split(/\s+/)[0])
      if (Number.isFinite(n) && !out.has(r.tbl)) out.set(r.tbl, n)
    }
  } catch {
    // No sqlite_stat1 — the database has never been ANALYZEd. Not an error.
  }
  return out
}

export interface RowIdentity {
  /** Key columns in order. `['rowid']` for the implicit fallback. */
  primaryKey: string[]
  kind: 'primary-key' | 'implicit' | 'none'
  /** The alias to project, when `kind` is `implicit`. */
  rowidAlias: string | null
  note: string | null
}

/**
 * Decide how a row in this table is addressed.
 *
 * **This is the rowid fallback, and it is the difference between a usable
 * browser and a read-only one.** Unlike Postgres, an ordinary SQLite table
 * *always* has a unique 64-bit key whether or not anyone declared one:
 * `rowid`. Under the strict PK rule inherited from the Postgres adapter, every
 * PK-less SQLite table would be read-only — and PK-less tables are ordinary in
 * SQLite in a way they are not in Postgres, because the language never made you
 * declare one to get a key.
 *
 * So a rowid table with no declared PK is editable **via `rowid`**, with three
 * caveats that the UI is told about rather than left to discover:
 *
 *  1. **`WITHOUT ROWID` tables have no rowid at all.** They must declare a
 *     `PRIMARY KEY` (SQLite refuses to create one otherwise), so in practice
 *     they always have a real key — but if one ever reaches here without a
 *     usable PK, there is no fallback and it stays read-only.
 *  2. **Views have no rowid**, so they stay read-only, as they should.
 *  3. **A rowid is not stable across `VACUUM`** when the table has no
 *     `INTEGER PRIMARY KEY`. That is fine for an interactive edit — read a row,
 *     change a cell, `UPDATE … WHERE rowid = ?` within seconds — and it is *not*
 *     fine as a durable identifier. `note` says so, and `DataGrid` shows it.
 */
export function rowIdentityFor(
  table: SqliteTableMeta,
  columns: readonly ColumnMeta[],
): RowIdentity {
  const declared = columns
    .filter((c) => c.isPrimaryKey)
    .slice()
    .sort((a, b) => (a.primaryKeyPosition ?? 0) - (b.primaryKeyPosition ?? 0))
    .map((c) => c.name)

  if (declared.length) {
    return { primaryKey: declared, kind: 'primary-key', rowidAlias: null, note: null }
  }

  if (table.kind === 'view') {
    return { primaryKey: [], kind: 'none', rowidAlias: null, note: null }
  }
  if (table.withoutRowid) {
    return { primaryKey: [], kind: 'none', rowidAlias: null, note: null }
  }
  // A virtual table's rowid is the module's business, not a stable key.
  if (table.kind === 'virtual') {
    return { primaryKey: [], kind: 'none', rowidAlias: null, note: null }
  }

  // A real column named `rowid` shadows the implicit one, and then the alias
  // selects that column instead — silently addressing the wrong thing. Pick the
  // first alias the table has not taken; if it has taken all three, there is no
  // way to name the implicit key and the table is read-only.
  const taken = new Set(columns.map((c) => c.name.toLowerCase()))
  const alias = ROWID_ALIASES.find((a) => !taken.has(a))
  if (!alias) {
    return { primaryKey: [], kind: 'none', rowidAlias: null, note: null }
  }

  return {
    primaryKey: [alias],
    kind: 'implicit',
    rowidAlias: alias,
    note:
      `This table has no PRIMARY KEY, so rows are addressed by SQLite's implicit ` +
      `${alias}. That identifies exactly one row, so editing is safe — but a ` +
      `${alias} is not stable across VACUUM, so do not store it as a durable reference.`,
  }
}

/**
 * Columns for one table, including the synthetic rowid column when that is what
 * addresses the row.
 *
 * `vectorColumns` marks blob columns known to hold embeddings, so the grid can
 * render `768 dims · 3.0 KB` instead of `[binary · 3.0 KB]`.
 */
export function describeColumns(
  db: SqliteDb,
  table: SqliteTableMeta,
  vectorColumns: ReadonlySet<string> = new Set(),
): ColumnMeta[] {
  // `pragma_table_info` as a table-valued function takes the table name as a
  // **bound parameter**, so the name is not concatenated into SQL even though
  // pragmas have no placeholder syntax of their own.
  const info = db
    .prepare('SELECT * FROM pragma_table_info(?)')
    .all(table.name) as unknown as TableInfoRow[]

  const fks = db
    .prepare('SELECT * FROM pragma_foreign_key_list(?)')
    .all(table.name) as unknown as ForeignKeyRow[]

  const fkByColumn = new Map<string, { schema: string; table: string; column: string }>()
  for (const fk of fks) {
    fkByColumn.set(fk.from, {
      schema: table.schema,
      table: fk.table,
      // A null `to` means the FK targets the parent's primary key implicitly.
      column: fk.to ?? 'rowid',
    })
  }

  // A single-column `INTEGER PRIMARY KEY` on a rowid table is not an ordinary
  // primary key — it *is* the rowid, under another name.
  const pkColumns = info.filter((r) => r.pk > 0)
  const isRowidAlias = (r: TableInfoRow): boolean =>
    !table.withoutRowid &&
    pkColumns.length === 1 &&
    r.pk === 1 &&
    (r.type ?? '').trim().toUpperCase() === 'INTEGER'

  const columns: ColumnMeta[] = info.map((r) => {
    const declared = r.type ?? ''
    const category = categoryForSqliteType(declared, {
      isVector: vectorColumns.has(r.name.toLowerCase()),
    })
    return finalizeColumn({
      name: r.name,
      // The declared type verbatim; `(no type)` rather than an empty header,
      // because a type-less column is a real and meaningful SQLite construct.
      dataType: declared || '(no type)',
      udtName: declared.toLowerCase() || 'blob',
      dbType: declared.toLowerCase(),
      /**
       * The normalized type comes from **affinity**, not from the type map.
       *
       * SQLite's declared types are free text and its five-rule substring
       * algorithm is what the database itself applies — a dictionary lookup
       * cannot get `nvarchar(80)` or `unsigned big int` right, and rule order
       * (`INT` before `CHAR`) is the algorithm. `categoryForSqliteType` has
       * already run it, so the category is the more informed answer and
       * `finalizeColumn` is handed it directly rather than a map to guess
       * with. `SQLITE_TYPE_MAP` is still passed so an exact spelling it knows
       * (`json`, `uuid`, `vector`) can win where affinity is silent.
       */
      category,
      /**
       * Nullability comes from `notnull`, with **exactly one** exception.
       *
       * `PRIMARY KEY` does not imply `NOT NULL` in SQLite — a bug from 2001
       * that was never fixed because too much data depended on it — so
       * `CREATE TABLE t(k TEXT PRIMARY KEY)` genuinely accepts a NULL `k`
       * (verified: the insert succeeds and the row reads back with `k: null`).
       * Inferring NOT NULL from `pk` would therefore be wrong, and would tell
       * the pagination planner a nullable ordering column cannot be null,
       * which silently drops rows from a keyset page.
       *
       * The exception is a single-column `INTEGER PRIMARY KEY` on a rowid
       * table: that column *is* the rowid, so inserting NULL does not store a
       * NULL, it allocates the next id (verified: `INSERT (id) VALUES (NULL)`
       * yields `id: 1`). `table_info` still reports `notnull: 0`, so taking it
       * literally would force every such table — which is most of them — onto
       * OFFSET pagination, throwing away the constant-cost paging that the
       * table's own key was there to provide.
       */
      nullable: r.notnull === 0 && !isRowidAlias(r),
      isPrimaryKey: r.pk > 0,
      primaryKeyPosition: r.pk > 0 ? r.pk : null,
      foreignKey: fkByColumn.get(r.name) ?? null,
      defaultValue: r.dflt_value ?? null,
      ordinal: r.cid + 1,
      enumValues: null,
      isBinary: isBinaryCategory(category),
      comment: null,
      readOnly: false,
    }, SQLITE_TYPE_MAP)
  })

  const identity = rowIdentityFor(table, columns)
  if (identity.kind === 'implicit' && identity.rowidAlias) {
    // Prepended, not appended: it is the key, and a key belongs first. Marked
    // `readOnly` so the grid refuses an edit — changing a rowid moves the row
    // rather than changing it, exactly like editing a PK column.
    columns.unshift(
      finalizeColumn({
        name: identity.rowidAlias,
        dataType: 'INTEGER (implicit rowid)',
        udtName: 'integer',
        dbType: 'integer',
        normalizedType: 'integer',
        category: 'number',
        nullable: false,
        isPrimaryKey: true,
        primaryKeyPosition: 1,
        foreignKey: null,
        defaultValue: null,
        ordinal: 0,
        enumValues: null,
        isBinary: false,
        comment: identity.note,
        readOnly: true,
      }),
    )
  }

  return columns
}
