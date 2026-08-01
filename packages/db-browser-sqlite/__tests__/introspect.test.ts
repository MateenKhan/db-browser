/**
 * SQLite introspection, the rowid fallback, and the type-affinity mapping.
 *
 * These run against a **real in-memory SQLite database** rather than a mock,
 * because every rule under test is a rule about what SQLite actually does — and
 * a mock would only ever assert what we already believed. Several of the
 * assertions below encode behaviour that is genuinely surprising (a `TEXT
 * PRIMARY KEY` accepting NULL; `table_info` reporting `notnull: 0` for a column
 * that can never hold NULL), and the test is what proves the claim rather than
 * repeating it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { affinityOf, categoryForSqliteType } from '../src/affinity.js'
import { openSqlite } from '../src/driver.js'
import type { SqliteDb } from '../src/driver.js'
import { describeColumns, listTables, rowIdentityFor, ROWID_ALIASES } from '../src/introspect.js'
import type { SqliteTableMeta } from '../src/introspect.js'
import { createSqliteDataSource } from '../src/sqliteDataSource.js'
import { finalizeColumn } from '@jugaaadi/db-browser/core'
import type { ColumnMeta } from '@jugaaadi/db-browser/core'

let db: SqliteDb

const SCHEMA = `
  CREATE TABLE with_pk (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT);
  CREATE TABLE no_pk (a TEXT, b INTEGER);
  CREATE TABLE text_pk (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE composite (app_id INTEGER NOT NULL, code TEXT NOT NULL, v TEXT,
                          PRIMARY KEY (app_id, code));
  CREATE TABLE without_rowid (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
  CREATE TABLE shadows_rowid (rowid_ TEXT, rowid TEXT, v TEXT);
  CREATE TABLE typed (i INT, bi "UNSIGNED BIG INT", vc VARCHAR(255), cl CLOB, t TEXT,
                      bl BLOB, untyped, r REAL, dbl DOUBLE, num NUMERIC, dec DECIMAL(10,5),
                      bo BOOLEAN, dt DATETIME, d DATE, js JSON, uu UUID);
  CREATE TABLE fk_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES with_pk(id));
  CREATE VIEW a_view AS SELECT id, name FROM with_pk;
  INSERT INTO with_pk (name, note) VALUES ('one', NULL), ('two', 'x');
  INSERT INTO no_pk (a, b) VALUES ('x', 1), ('y', 2), ('y', 2);
`

beforeAll(async () => {
  // `:memory:` cannot be opened read-only (there is nothing to read), so the
  // fixture is built read-write and the read-only assertions live in the
  // separate suite below that opens a file.
  db = await openSqlite({ filename: ':memory:', readOnly: false })
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    db.prepare(stmt).run()
  }
})

afterAll(() => db?.close())

const table = (name: string): SqliteTableMeta =>
  listTables(db).find((t) => t.name === name) as SqliteTableMeta

describe('affinityOf — SQLite’s five rules, in order', () => {
  it.each([
    ['INTEGER', 'INTEGER'],
    ['INT', 'INTEGER'],
    ['BIGINT', 'INTEGER'],
    ['UNSIGNED BIG INT', 'INTEGER'],
    // Rule 1 (contains INT) beats rule 2 (contains CHAR): both match, INT wins.
    ['INTCHAR', 'INTEGER'],
    ['VARCHAR(255)', 'TEXT'],
    ['NVARCHAR(80)', 'TEXT'],
    ['CLOB', 'TEXT'],
    ['TEXT', 'TEXT'],
    ['BLOB', 'BLOB'],
    ['', 'BLOB'],
    ['REAL', 'REAL'],
    ['DOUBLE', 'REAL'],
    ['FLOAT', 'REAL'],
    ['NUMERIC', 'NUMERIC'],
    ['DECIMAL(10,5)', 'NUMERIC'],
    ['BOOLEAN', 'NUMERIC'],
    ['DATE', 'NUMERIC'],
  ])('%s -> %s', (declared, expected) => {
    expect(affinityOf(declared)).toBe(expected)
  })
})

describe('categoryForSqliteType', () => {
  it.each([
    ['INTEGER', 'number'],
    ['BIGINT', 'number'],
    ['REAL', 'number'],
    ['DECIMAL(10,5)', 'number'],
    ['VARCHAR(255)', 'string'],
    ['TEXT', 'string'],
    ['BLOB', 'binary'],
    ['BOOLEAN', 'boolean'],
    ['DATETIME', 'timestamp'],
    ['TIMESTAMP', 'timestamp'],
    ['DATE', 'date'],
    ['JSON', 'json'],
    ['UUID', 'uuid'],
  ])('%s -> %s', (declared, expected) => {
    expect(categoryForSqliteType(declared)).toBe(expected)
  })

  it('treats an EMPTY declared type as untyped, not as binary', () => {
    // `CREATE TABLE t(a)` has BLOB affinity by the letter of the rules, but the
    // column is untyped rather than binary. Calling it binary made
    // `sqlite_sequence.name` render as `[binary · 5 B]` instead of `chunk` — a
    // wrong display, not a cautious one.
    expect(affinityOf('')).toBe('BLOB')
    expect(categoryForSqliteType('')).toBe('other')
    expect(categoryForSqliteType('BLOB')).toBe('binary')
  })

  it('honours an explicit vector hint over the affinity', () => {
    expect(categoryForSqliteType('BLOB', { isVector: true })).toBe('vector')
  })
})

describe('listTables', () => {
  it('lists tables and views with their kind', () => {
    const names = listTables(db).map((t) => t.name)
    expect(names).toContain('with_pk')
    expect(names).toContain('a_view')
    expect(table('a_view').kind).toBe('view')
    expect(table('with_pk').kind).toBe('table')
  })

  it('flags WITHOUT ROWID tables', () => {
    expect(table('without_rowid').withoutRowid).toBe(true)
    expect(table('with_pk').withoutRowid).toBe(false)
  })

  it('reports -1 for a never-ANALYZEd table rather than a fabricated count', () => {
    expect(table('with_pk').rowCountEstimate).toBe(-1)
  })
})

describe('describeColumns', () => {
  it('maps declared types, nullability, keys and foreign keys', () => {
    const cols = describeColumns(db, table('with_pk'))
    expect(cols.map((c) => c.name)).toEqual(['id', 'name', 'note'])
    expect(cols[0]).toMatchObject({ dataType: 'INTEGER', category: 'number', isPrimaryKey: true })
    expect(cols[1]).toMatchObject({ nullable: false, category: 'string' })
    expect(cols[2]).toMatchObject({ nullable: true })

    const fk = describeColumns(db, table('fk_child')).find((c) => c.name === 'parent')
    expect(fk?.foreignKey).toMatchObject({ table: 'with_pk', column: 'id' })
  })

  it('orders a composite key by its declared position', () => {
    const cols = describeColumns(db, table('composite'))
    const pk = cols.filter((c) => c.isPrimaryKey).sort((a, b) => a.primaryKeyPosition! - b.primaryKeyPosition!)
    expect(pk.map((c) => c.name)).toEqual(['app_id', 'code'])
  })

  it('does NOT infer NOT NULL from PRIMARY KEY — SQLite genuinely allows a NULL text key', () => {
    // The 2001 bug that was never fixed. `pragma table_info` reports
    // `notnull: 0`, and it means it: the insert below succeeds.
    const cols = describeColumns(db, table('text_pk'))
    const k = cols.find((c) => c.name === 'k')!
    expect(k.isPrimaryKey).toBe(true)
    expect(k.nullable).toBe(true)

    db.prepare("INSERT INTO text_pk (k, v) VALUES (NULL, 'proof')").run()
    const row = db.prepare('SELECT k, v FROM text_pk WHERE v = ?').get('proof')
    expect(row?.k).toBeNull()
    db.prepare("DELETE FROM text_pk WHERE v = 'proof'").run()
  })

  it('DOES treat a single-column INTEGER PRIMARY KEY as NOT NULL — it is the rowid', () => {
    // `table_info` says `notnull: 0` here too, but inserting NULL allocates the
    // next id rather than storing a NULL, so the column can never hold one.
    // Taking the pragma literally forced every such table onto OFFSET paging.
    const id = describeColumns(db, table('with_pk')).find((c) => c.name === 'id')!
    expect(id.isPrimaryKey).toBe(true)
    expect(id.nullable).toBe(false)

    db.prepare("INSERT INTO with_pk (id, name) VALUES (NULL, 'auto')").run()
    const row = db.prepare("SELECT id FROM with_pk WHERE name = 'auto'").get()
    expect(typeof row?.id).toBe('number')
    db.prepare("DELETE FROM with_pk WHERE name = 'auto'").run()
  })

  it('does not extend that exception to a composite key containing an INTEGER column', () => {
    const appId = describeColumns(db, table('composite')).find((c) => c.name === 'app_id')!
    // NOT NULL here comes from the explicit declaration, not from `pk`.
    expect(appId.nullable).toBe(false)
    const code = describeColumns(db, table('composite')).find((c) => c.name === 'code')!
    expect(code.isPrimaryKey).toBe(true)
  })
})

describe('rowid fallback', () => {
  it('uses the declared primary key when there is one', () => {
    const cols = describeColumns(db, table('with_pk'))
    const identity = rowIdentityFor(table('with_pk'), cols)
    expect(identity).toMatchObject({ kind: 'primary-key', primaryKey: ['id'], rowidAlias: null })
  })

  it('falls back to rowid for a PK-less rowid table, so it stays EDITABLE', () => {
    // Without this, every PK-less SQLite table would be read-only — and PK-less
    // tables are ordinary in SQLite in a way they are not in Postgres.
    const cols = describeColumns(db, table('no_pk')).filter((c) => c.ordinal > 0)
    const identity = rowIdentityFor(table('no_pk'), cols)
    expect(identity.kind).toBe('implicit')
    expect(identity.primaryKey).toEqual(['rowid'])
    expect(identity.rowidAlias).toBe('rowid')
    expect(identity.note).toMatch(/VACUUM/)
  })

  it('adds the rowid as a synthetic, read-only key column', () => {
    const cols = describeColumns(db, table('no_pk'))
    expect(cols[0]).toMatchObject({
      name: 'rowid',
      isPrimaryKey: true,
      // Read-only because changing a rowid moves the row rather than editing
      // it — exactly like editing a PK column.
      readOnly: true,
      ordinal: 0,
    })
  })

  it('refuses the fallback for a WITHOUT ROWID table', () => {
    const cols = describeColumns(db, table('without_rowid'))
    // SQLite *requires* a PRIMARY KEY on a WITHOUT ROWID table, so this one
    // has a real key and never needs the fallback.
    expect(rowIdentityFor(table('without_rowid'), cols).kind).toBe('primary-key')

    // The unreachable-in-practice case, tested on the pure function: a
    // WITHOUT ROWID table with no usable key. SQLite refuses to *create* one
    // ("PRIMARY KEY missing on table"), which is asserted below — so this
    // branch can only be reached through a malformed schema, and when it is,
    // there must be no fallback because there is no rowid to fall back to.
    const synthetic: SqliteTableMeta = {
      schema: 'main',
      name: 'hypothetical',
      kind: 'table',
      rowCountEstimate: -1,
      comment: null,
      withoutRowid: true,
      ddl: null,
    }
    const keyless: ColumnMeta[] = [
      finalizeColumn({ name: 'a', dataType: 'TEXT', udtName: 'text', category: 'string', nullable: true, isPrimaryKey: false, ordinal: 1 }),
    ]
    expect(rowIdentityFor(synthetic, keyless)).toMatchObject({ kind: 'none', primaryKey: [], rowidAlias: null })
  })

  it('SQLite itself refuses to create a WITHOUT ROWID table with no PRIMARY KEY', () => {
    expect(() => db.prepare('CREATE TABLE nope (a TEXT) WITHOUT ROWID').run()).toThrow(
      /PRIMARY KEY missing/i,
    )
  })

  it('refuses the fallback for a view — a view has no rowid', () => {
    const cols = describeColumns(db, table('a_view'))
    expect(rowIdentityFor(table('a_view'), cols).kind).toBe('none')
  })

  it('picks another alias when a real column shadows `rowid`', () => {
    // A column literally named `rowid` shadows the implicit one, so selecting
    // `rowid` would silently address that column instead of the key.
    const cols = describeColumns(db, table('shadows_rowid')).filter((c) => c.ordinal > 0)
    const identity = rowIdentityFor(table('shadows_rowid'), cols)
    expect(identity.kind).toBe('implicit')
    expect(identity.rowidAlias).toBe('_rowid_')
    expect(ROWID_ALIASES).toContain(identity.rowidAlias!)
  })

  it('gives up when all three aliases are taken', () => {
    const synthetic: SqliteTableMeta = {
      schema: 'main',
      name: 'all_taken',
      kind: 'table',
      rowCountEstimate: -1,
      comment: null,
      withoutRowid: false,
      ddl: null,
    }
    const cols: ColumnMeta[] = ROWID_ALIASES.map((name, i) =>
      finalizeColumn({
        name,
        dataType: 'TEXT',
        udtName: 'text',
        category: 'string' as const,
        nullable: true,
        isPrimaryKey: false,
        ordinal: i + 1,
      }),
    )
    expect(rowIdentityFor(synthetic, cols).kind).toBe('none')
  })
})

describe('TableSchema assembled by the data source', () => {
  it('marks a PK-less rowid table updatable, with the identity labelled', async () => {
    // `allowDdl` is required even in read-write mode — the guard refuses a
    // CREATE without it, which is itself the behaviour under test elsewhere.
    const ds = await createSqliteDataSource({
      filename: ':memory:',
      readOnly: false,
      allowDdl: true,
    })
    // Rebuild a minimal fixture in this connection's own memory database.
    await ds.runQuery('CREATE TABLE loose (a TEXT, b INTEGER)', { allowWrite: true })
    const schema = await ds.describeTable({ schema: 'main', name: 'loose' })
    expect(schema.updatable).toBe(true)
    expect(schema.rowIdentity).toBe('implicit')
    expect(schema.primaryKey).toEqual(['rowid'])
    expect(schema.identityNote).toMatch(/no PRIMARY KEY/)
    ds.close()
  })

  it('marks a view read-only with the shared rule’s reason', async () => {
    // `allowDdl` is required even in read-write mode — the guard refuses a
    // CREATE without it, which is itself the behaviour under test elsewhere.
    const ds = await createSqliteDataSource({
      filename: ':memory:',
      readOnly: false,
      allowDdl: true,
    })
    await ds.runQuery('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', { allowWrite: true })
    await ds.runQuery('CREATE VIEW v AS SELECT id FROM t', { allowWrite: true })
    const schema = await ds.describeTable({ schema: 'main', name: 'v' })
    expect(schema.updatable).toBe(false)
    expect(schema.rowIdentity).toBe('none')
    expect(schema.notUpdatableReason).toMatch(/view/i)
    ds.close()
  })
})
