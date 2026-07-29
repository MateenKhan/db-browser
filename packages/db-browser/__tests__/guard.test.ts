import { describe, expect, it } from 'vitest'
import type { GuardOptions } from '../src/sql/guard.js'
import {
  analyzeSql,
  assertSqlAllowed,
  classifyStatement,
  isWrappableSelect,
  maskSql,
  SqlGuardError,
  splitStatements,
  stripTrailingSemicolon,
} from '../src/sql/guard.js'

const readOnly: GuardOptions = { mode: 'read-only' }

function rejection(sql: string, options: GuardOptions = readOnly): SqlGuardError {
  try {
    assertSqlAllowed(sql, options)
  } catch (e) {
    return e as SqlGuardError
  }
  throw new Error(`expected ${JSON.stringify(sql)} to be rejected, but it was allowed`)
}

describe('read-only classification', () => {
  it.each([
    'SELECT 1',
    'select * from feature',
    '  SELECT * FROM feature WHERE app_id = $1  ',
    'SELECT * FROM feature;',
    'WITH t AS (SELECT 1 AS x) SELECT * FROM t',
    // "created_at" must not false-positive on the CREATE denylist entry
    'SELECT created_at FROM feature',
    // nor "update_seq" on UPDATE, nor "pg_settings" on SET
    'SELECT update_seq FROM t ORDER BY update_seq',
    'SELECT name FROM pg_settings',
    'TABLE feature',
    'VALUES (1), (2)',
    'EXPLAIN SELECT * FROM feature',
    'SHOW statement_timeout',
    // a semicolon inside a literal is not a statement break
    "SELECT ';' AS semi",
    "SELECT 'DROP TABLE feature' AS just_text",
  ])('allows %s', (sql) => {
    expect(() => assertSqlAllowed(sql, readOnly)).not.toThrow()
    expect(analyzeSql(sql).readOnly).toBe(true)
  })

  it('rejects blank sql', () => {
    expect(rejection('').code).toBe('EMPTY_SQL')
    expect(rejection('   ').code).toBe('EMPTY_SQL')
    expect(rejection('  ;  ').code).toBe('EMPTY_SQL')
  })

  it('rejects writes', () => {
    expect(rejection('UPDATE feature SET name = 1').code).toBe('WRITE_IN_READ_ONLY')
    expect(rejection("DELETE FROM feature WHERE code = 'x'").code).toBe('WRITE_IN_READ_ONLY')
    expect(rejection("INSERT INTO feature(code) VALUES ('x')").code).toBe('WRITE_IN_READ_ONLY')
    expect(rejection('MERGE INTO feature USING x ON true').code).toBe('WRITE_IN_READ_ONLY')
  })

  it('rejects DDL', () => {
    expect(rejection('DROP TABLE feature').code).toBe('DDL_IN_READ_ONLY')
    expect(rejection('ALTER TABLE feature ADD COLUMN x int').code).toBe('DDL_IN_READ_ONLY')
    expect(rejection('CREATE TABLE x (id int)').code).toBe('DDL_IN_READ_ONLY')
    expect(rejection('TRUNCATE TABLE feature').code).toBe('DDL_IN_READ_ONLY')
    expect(rejection('GRANT ALL ON feature TO public').code).toBe('DDL_IN_READ_ONLY')
  })

  it('rejects stacked statements — the classic read-only escape', () => {
    expect(rejection('SELECT 1; DROP TABLE feature').code).toBe('MULTIPLE_STATEMENTS')
    expect(rejection('SELECT 1; SELECT 2').code).toBe('MULTIPLE_STATEMENTS')
    expect(rejection("SELECT * FROM feature; DELETE FROM feature").code).toBe('MULTIPLE_STATEMENTS')
  })

  it('allows a single trailing semicolon and empty trailing statements', () => {
    expect(() => assertSqlAllowed('SELECT 1;', readOnly)).not.toThrow()
    expect(() => assertSqlAllowed('SELECT 1;;', readOnly)).not.toThrow()
    expect(() => assertSqlAllowed('SELECT 1;  \n  ', readOnly)).not.toThrow()
  })

  it('rejects a data-modifying CTE that starts with WITH', () => {
    const e = rejection('WITH d AS (DELETE FROM feature RETURNING *) SELECT * FROM d')
    expect(e.code).toBe('DISALLOWED_KEYWORD')
    expect(e.message).toContain('DELETE')
  })

  it('rejects EXPLAIN ANALYZE over a write, which really executes it', () => {
    expect(rejection('EXPLAIN ANALYZE UPDATE feature SET name = 1').code).toBe('DISALLOWED_KEYWORD')
  })

  it('rejects keywords smuggled through comments', () => {
    // The comment is masked, so this is a single statement …
    expect(splitStatements('SELECT 1 /* ; DROP TABLE feature */')).toHaveLength(1)
    // … and the masked text no longer contains DROP, so it is genuinely a read.
    expect(() => assertSqlAllowed('SELECT 1 /* ; DROP TABLE feature */', readOnly)).not.toThrow()
    // But an unmasked stacked statement after a line comment still trips.
    expect(rejection('SELECT 1 -- comment\n; DROP TABLE feature').code).toBe('MULTIPLE_STATEMENTS')
  })

  it('rejects procedural escapes', () => {
    expect(rejection('CALL do_something()').code).toBe('WRITE_IN_READ_ONLY')
    expect(rejection("DO $$ BEGIN PERFORM 1; END $$").code).toBe('WRITE_IN_READ_ONLY')
    expect(rejection('COPY feature TO PROGRAM \'sh -c evil\'').code).toBe('WRITE_IN_READ_ONLY')
    expect(rejection('SELECT pg_read_file(\'/etc/passwd\')').code).toBe('DISALLOWED_KEYWORD')
    expect(rejection('SELECT * FROM feature FOR UPDATE').code).toBe('DISALLOWED_KEYWORD')
    // `SELECT … INTO t` is a CREATE TABLE that begins with the word SELECT.
    expect(rejection('SELECT * INTO evil_copy FROM feature').code).toBe('DISALLOWED_KEYWORD')
  })
})

describe('read-write mode', () => {
  const rw: GuardOptions = { mode: 'read-write' }

  it('allows DML', () => {
    expect(() => assertSqlAllowed("UPDATE feature SET name='x' WHERE code='y'", rw)).not.toThrow()
    expect(() => assertSqlAllowed("DELETE FROM feature WHERE code='y'", rw)).not.toThrow()
  })

  it('still blocks DDL unless explicitly enabled', () => {
    expect(rejection('DROP TABLE feature', rw).code).toBe('DDL_NOT_ALLOWED')
    expect(() => assertSqlAllowed('DROP TABLE feature', { ...rw, allowDdl: true })).not.toThrow()
  })

  it('still blocks stacked statements unless explicitly enabled', () => {
    expect(rejection('SELECT 1; SELECT 2', rw).code).toBe('MULTIPLE_STATEMENTS')
    expect(() =>
      assertSqlAllowed('SELECT 1; SELECT 2', { ...rw, allowMultipleStatements: true }),
    ).not.toThrow()
  })

  it('requires confirmation for an unqualified UPDATE/DELETE', () => {
    expect(rejection('DELETE FROM feature', rw).code).toBe('UNQUALIFIED_WRITE')
    expect(rejection("UPDATE feature SET name='x'", rw).code).toBe('UNQUALIFIED_WRITE')
    expect(() =>
      assertSqlAllowed('DELETE FROM feature', { ...rw, confirmedUnqualified: true }),
    ).not.toThrow()
    // A WHERE clause needs no confirmation.
    expect(() => assertSqlAllowed("DELETE FROM feature WHERE code='x'", rw)).not.toThrow()
  })
})

describe('masking', () => {
  it('keeps length and blanks literal contents', () => {
    const sql = "SELECT 'a;b' FROM t -- ;x\n WHERE q = $$ ;y $$"
    const masked = maskSql(sql)
    expect(masked).toHaveLength(sql.length)
    expect(masked).not.toContain(';')
    expect(masked.startsWith('SELECT')).toBe(true)
  })

  it('handles escaped quotes', () => {
    expect(maskSql("SELECT 'it''s; fine'")).not.toContain(';')
  })

  it('handles nested block comments', () => {
    expect(maskSql('SELECT /* a /* b ; */ c */ 1')).not.toContain(';')
  })

  it('masks quoted identifiers so they are not read as keywords', () => {
    const info = classifyStatement('SELECT "drop" FROM t')
    expect(info.kind).toBe('read')
  })
})

describe('helpers', () => {
  it('strips exactly one trailing semicolon', () => {
    expect(stripTrailingSemicolon('SELECT 1;')).toBe('SELECT 1')
    expect(stripTrailingSemicolon('SELECT 1')).toBe('SELECT 1')
    expect(stripTrailingSemicolon('SELECT 1;;')).toBe('SELECT 1;')
  })

  it('marks wrappable selects', () => {
    expect(isWrappableSelect(classifyStatement('SELECT 1'))).toBe(true)
    expect(isWrappableSelect(classifyStatement('WITH t AS (SELECT 1) SELECT * FROM t'))).toBe(true)
    expect(isWrappableSelect(classifyStatement('EXPLAIN SELECT 1'))).toBe(false)
    expect(isWrappableSelect(classifyStatement('SHOW timezone'))).toBe(false)
  })

  it('reports missing WHERE clauses', () => {
    expect(analyzeSql('DELETE FROM t').missingWhere).toHaveLength(1)
    expect(analyzeSql('DELETE FROM t WHERE id = 1').missingWhere).toHaveLength(0)
  })
})
