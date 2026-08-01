/**
 * Dialect selection: formatting, the guard's per-engine denylist, and the
 * normalisation that stops an unknown value reaching CodeMirror.
 *
 * The regression this file guards against is the one the whole change exists to
 * fix: **three hardcoded `postgresql`/`PostgreSQL` constants**, which meant a
 * SQLite connection got Postgres highlighting, Postgres completion keywords,
 * Postgres formatting, and — worst — a denylist naming `pg_read_file` while
 * saying nothing about `writefile()`.
 */

import { describe, expect, it } from 'vitest'
import {
  asDialect,
  DEFAULT_DIALECT,
  defaultSchemaFor,
  DIALECT_LABEL,
  formatterLanguageFor,
  hasUserFacingSchemas,
  SQL_DIALECTS,
  codemirrorDialectName,
} from '../src/sql/dialect.js'
import { formatQuery } from '../src/sql/format.js'
import { analyzeSql, assertSqlAllowed, SqlGuardError } from '../src/sql/guard.js'
import type { GuardOptions } from '../src/sql/guard.js'

const sqliteReadOnly: GuardOptions = { mode: 'read-only', dialect: 'sqlite' }
const pgReadOnly: GuardOptions = { mode: 'read-only', dialect: 'postgres' }

function rejection(sql: string, options: GuardOptions): SqlGuardError {
  try {
    assertSqlAllowed(sql, options)
  } catch (e) {
    return e as SqlGuardError
  }
  throw new Error(`expected ${JSON.stringify(sql)} to be rejected, but it was allowed`)
}

describe('dialect mapping', () => {
  it('maps to sql-formatter’s own language ids, which are not our names', () => {
    expect(formatterLanguageFor('postgres')).toBe('postgresql')
    expect(formatterLanguageFor('sqlite')).toBe('sqlite')
  })

  it('defaults to postgres, preserving the behaviour from before dialects existed', () => {
    expect(DEFAULT_DIALECT).toBe('postgres')
    expect(formatterLanguageFor(undefined)).toBe('postgresql')
  })

  it('normalises anything unrecognised that arrives over the wire', () => {
    // The dialect is handed to CodeMirror and to the guard, so a value the
    // library does not know — `null`, an object, an engine nobody implemented
    // — must not reach either.
    //
    // NOTE: this assertion previously read `asDialect('mysql') === 'postgres'`,
    // because MySQL was not a dialect. It is now, so the case moved to a name
    // that genuinely is not one. Normalising a *known* dialect away would be
    // the bug, not the safety net.
    for (const known of SQL_DIALECTS) expect(asDialect(known)).toBe(known)
    expect(asDialect('db2')).toBe('postgres')
    expect(asDialect('informix')).toBe('postgres')
    expect(asDialect(undefined)).toBe('postgres')
    expect(asDialect(null)).toBe('postgres')
    expect(asDialect({ evil: true })).toBe('postgres')
    expect(asDialect(['sqlite'])).toBe('postgres')
  })

  it('knows which engines have user-facing schemas', () => {
    expect(hasUserFacingSchemas('postgres')).toBe(true)
    expect(hasUserFacingSchemas('sqlite')).toBe(false)
    // MySQL/MariaDB's "schema" *is* the connected database, so grouping by it
    // shows one group with everything in it — the same noise SQLite has.
    expect(hasUserFacingSchemas('mysql')).toBe(false)
    expect(hasUserFacingSchemas('mariadb')).toBe(false)
    expect(hasUserFacingSchemas('mssql')).toBe(true)
    expect(defaultSchemaFor('postgres')).toBe('public')
    expect(defaultSchemaFor('sqlite')).toBe('main')
    expect(defaultSchemaFor('mssql')).toBe('dbo')
    // MySQL has no default schema at all until a database is selected, and an
    // empty string is more honest than inventing one.
    expect(defaultSchemaFor('mysql')).toBe('')
  })

  it('has a label and a formatter language for every dialect', () => {
    expect(DIALECT_LABEL.postgres).toBe('PostgreSQL')
    expect(DIALECT_LABEL.sqlite).toBe('SQLite')
    for (const dialect of SQL_DIALECTS) {
      expect(DIALECT_LABEL[dialect], dialect).toBeTruthy()
      expect(formatterLanguageFor(dialect), dialect).toBeTruthy()
      // Every dialect must also name a CodeMirror grammar, or the editor
      // silently falls back to generic SQL for it.
      expect(codemirrorDialectName(dialect), dialect).toBeTruthy()
    }
  })

  it('maps the added engines onto the formatter’s real languages', () => {
    // These are `sql-formatter`'s own ids and they are not our names. A typo
    // here does not throw — the formatter falls back to generic SQL — so it is
    // asserted rather than trusted.
    expect(formatterLanguageFor('mysql')).toBe('mysql')
    expect(formatterLanguageFor('mariadb')).toBe('mariadb')
    expect(formatterLanguageFor('mssql')).toBe('transactsql')
    expect(formatterLanguageFor('oracle')).toBe('plsql')
    expect(formatterLanguageFor('duckdb')).toBe('duckdb')
  })
})

describe('formatQuery follows the dialect', () => {
  it('formats with the SQLite grammar without mangling `?` placeholders', () => {
    const out = formatQuery('select a,b from t where a=? and b=?', { dialect: 'sqlite' })
    expect(out).toMatch(/SELECT/)
    // Both placeholders survive, in order — the failure mode when the wrong
    // grammar is used is that they are renumbered or split.
    expect(out.match(/\?/g)).toHaveLength(2)
  })

  it('formats Postgres dollar placeholders with the Postgres grammar', () => {
    const out = formatQuery('select a from t where a=$1', { dialect: 'postgres' })
    expect(out).toContain('$1')
  })

  it('returns the original text when the formatter cannot parse it', () => {
    const nonsense = ')))not sql((('
    expect(formatQuery(nonsense, { dialect: 'sqlite' })).toBe(nonsense)
  })

  it('leaves blank input alone', () => {
    expect(formatQuery('   ', { dialect: 'sqlite' })).toBe('   ')
  })
})

describe('the guard’s per-dialect denylist', () => {
  it('reports which dialect it analysed with', () => {
    expect(analyzeSql('SELECT 1').dialect).toBe('postgres')
    expect(analyzeSql('SELECT 1', 'sqlite').dialect).toBe('sqlite')
  })

  it.each([
    ["SELECT writefile('/tmp/x', content) FROM chunk", 'WRITEFILE'],
    ["SELECT readfile('/etc/passwd') AS leak", 'READFILE'],
    ["SELECT load_extension('/tmp/evil.so')", 'LOAD_EXTENSION'],
    ['SELECT * FROM sqlite_dbpage', 'SQLITE_DBPAGE'],
    ["SELECT * FROM fsdir('/')", 'FSDIR'],
    ["SELECT * FROM zipfile('/tmp/x.zip')", 'ZIPFILE'],
    ["SELECT name FROM sqlar", 'SQLAR'],
  ])('blocks %s in SQLite read-only mode', (sql, keyword) => {
    const e = rejection(sql, sqliteReadOnly)
    expect(e.code).toBe('DISALLOWED_KEYWORD')
    expect(e.message).toContain(keyword)
    expect(analyzeSql(sql, 'sqlite').smuggledKeyword).toBe(keyword)
  })

  it('does not apply SQLite’s file built-ins to Postgres', () => {
    // A Postgres table legitimately called `readfile` must not be blocked by a
    // denylist entry that describes an extension Postgres does not have.
    expect(() => assertSqlAllowed('SELECT * FROM readfile', pgReadOnly)).not.toThrow()
    expect(analyzeSql('SELECT * FROM readfile', 'postgres').smuggledKeyword).toBeNull()
  })

  it('still applies Postgres’s own built-ins to Postgres', () => {
    expect(rejection("SELECT pg_read_file('/etc/passwd')", pgReadOnly).code).toBe(
      'DISALLOWED_KEYWORD',
    )
  })

  it.each([
    ["ATTACH DATABASE '/tmp/exfil.db' AS x", 'ATTACH'],
    ['DETACH DATABASE x', 'DETACH'],
    ['PRAGMA journal_mode = WAL', 'PRAGMA'],
    ['PRAGMA user_version = 9', 'PRAGMA'],
  ])('blocks %s — it is not a read', (sql) => {
    expect(rejection(sql, sqliteReadOnly).code).toBe('WRITE_IN_READ_ONLY')
  })

  it('blocks even a read-only PRAGMA, because the guard cannot tell them apart', () => {
    // `PRAGMA table_info(t)` reads and `PRAGMA journal_mode=WAL` writes, and
    // telling them apart needs a parser. Blocking the verb is the safe side of
    // that trade; introspection does not go through the console anyway.
    expect(rejection('PRAGMA table_info(chunk)', sqliteReadOnly).code).toBe('WRITE_IN_READ_ONLY')
  })

  it("blocks VACUUM INTO — a whole-database copy in one statement", () => {
    expect(rejection("VACUUM INTO '/tmp/copy.db'", sqliteReadOnly).code).toBe('DDL_IN_READ_ONLY')
  })

  it('blocks PRAGMA in read-WRITE mode too', () => {
    // Write mode allows an UPDATE, not a change to the database's own settings.
    expect(
      rejection('PRAGMA journal_mode = WAL', { mode: 'read-write', dialect: 'sqlite' }).code,
    ).toBe('UNSUPPORTED_STATEMENT')
  })

  it('keeps the existing multi-statement block for SQLite', () => {
    expect(rejection('SELECT 1; DROP TABLE chunk', sqliteReadOnly).code).toBe('MULTIPLE_STATEMENTS')
    expect(rejection("SELECT 1; ATTACH DATABASE '/tmp/x' AS y", sqliteReadOnly).code).toBe(
      'MULTIPLE_STATEMENTS',
    )
  })

  it('allows ordinary SQLite reads', () => {
    for (const sql of [
      'SELECT * FROM chunk LIMIT 10',
      "SELECT type, name FROM sqlite_master WHERE type = 'table'",
      'WITH t AS (SELECT kind, count(*) n FROM chunk GROUP BY kind) SELECT * FROM t',
      // A semicolon inside a literal is not a statement break.
      "SELECT ';' AS semi",
      // Must not false-positive on the denylist: `readfile` is a substring of
      // neither, and word boundaries are what stop `updated_at`.
      'SELECT updated_at, content_sha FROM chunk',
    ]) {
      expect(() => assertSqlAllowed(sql, sqliteReadOnly), sql).not.toThrow()
    }
  })
})
