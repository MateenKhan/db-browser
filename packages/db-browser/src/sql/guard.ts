/**
 * Statement guard for a SQL console.
 *
 * Ported from the Java `ReadOnlySqlGuard` that ships in Piranha's code-editor
 * service (`modules/dbconsole/ReadOnlySqlGuard.java`), and hardened in four
 * places where the original was tuned for a narrower surface:
 *
 *  1. **Comments and string literals are masked before analysis.** The Java
 *     guard rejects any embedded `;`, which is safe but also rejects
 *     `SELECT ';'`. Masking first means a semicolon inside a literal or a
 *     `-- comment` cannot fake a statement break *and* cannot smuggle a
 *     keyword past the denylist (`SELECT 1 /*;DROP TABLE x*\/`).
 *  2. **Dollar-quoted bodies** (`$$ … $$`, `$tag$ … $tag$`) are masked too —
 *     that is the standard way to hide a whole procedure body in one statement.
 *  3. **Data-modifying CTEs** (`WITH d AS (DELETE … RETURNING *) SELECT …`)
 *     start with `WITH` and would pass a naive first-word check; the denylist
 *     scan over the masked text is what stops them.
 *  4. It classifies rather than only validating, so the UI can show what a
 *     statement *is* before you run it, and so write mode can allow an
 *     `UPDATE` while still refusing `DROP`.
 *
 * This is the *first* gate, not the only one. The reference Postgres adapter
 * additionally runs read-only work inside a `BEGIN … READ ONLY` transaction,
 * and the SQLite adapter opens the file `readOnly` at the driver level, so the
 * database itself refuses a write the regex somehow missed.
 *
 * ## Dialects
 *
 * Dangerous built-ins are engine-specific. Postgres has `pg_read_file()` and
 * `COPY … TO PROGRAM`; SQLite's equivalents are entirely different —
 * `writefile()`/`readfile()` from the fileio extension, `load_extension()`,
 * `VACUUM INTO 'somewhere.db'` (a whole-database exfiltration in one
 * statement), and the `sqlite_dbpage`/`sqlar`/`zipfile` virtual tables. The
 * shared `DENYLIST` holds what is dangerous *everywhere*; `DIALECT_DENYLIST`
 * adds the rest per engine. This file still imports nothing engine-specific —
 * a dialect here is a name, not a driver.
 */

import { DEFAULT_DIALECT } from './dialect.js'
import type { SqlDialect } from './dialect.js'

export type StatementKind = 'read' | 'write' | 'ddl' | 'transaction' | 'other' | 'empty'

export interface StatementInfo {
  /** The original text of this statement, trimmed, without its terminator. */
  sql: string
  /** First keyword, upper-cased (`SELECT`, `UPDATE`, …), or `''` when empty. */
  command: string
  kind: StatementKind
  /** True for `UPDATE`/`DELETE` with no `WHERE` clause. */
  missingWhere: boolean
}

export interface SqlAnalysis {
  statements: StatementInfo[]
  /** Most dangerous kind across all statements. */
  kind: StatementKind
  multiple: boolean
  /** True when every statement is a read and nothing tripped the denylist. */
  readOnly: boolean
  /** Denylisted keyword found inside a statement that otherwise reads. */
  smuggledKeyword?: string | null
  /** Statements that are an unqualified `UPDATE`/`DELETE`. */
  missingWhere: StatementInfo[]
  /** Which dialect's denylist was applied. */
  dialect: SqlDialect
}

export type GuardMode = 'read-only' | 'read-write'

export interface GuardOptions {
  mode: GuardMode
  /** Allow `;`-separated statements. Off by default; see the README. */
  allowMultipleStatements?: boolean
  /** Allow DDL when `mode` is `read-write`. Off by default. */
  allowDdl?: boolean
  /** Require the caller to have confirmed an unqualified UPDATE/DELETE. */
  confirmedUnqualified?: boolean
  /**
   * Which engine's extra denylist to apply on top of the shared one. Defaults
   * to `postgres` so an adapter that predates dialects keeps its old
   * behaviour exactly.
   */
  dialect?: SqlDialect
}

export type SqlGuardCode =
  | 'EMPTY_SQL'
  | 'MULTIPLE_STATEMENTS'
  | 'WRITE_IN_READ_ONLY'
  | 'DDL_IN_READ_ONLY'
  | 'DDL_NOT_ALLOWED'
  | 'DISALLOWED_KEYWORD'
  | 'UNQUALIFIED_WRITE'
  | 'UNSUPPORTED_STATEMENT'

export class SqlGuardError extends Error {
  readonly code: SqlGuardCode
  constructor(code: SqlGuardCode, message: string) {
    super(message)
    this.name = 'SqlGuardError'
    this.code = code
  }
}

const READ_COMMANDS = new Set(['SELECT', 'WITH', 'TABLE', 'VALUES', 'SHOW', 'EXPLAIN'])
const WRITE_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY', 'UPSERT'])
const DDL_COMMANDS = new Set([
  'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'REINDEX',
  'VACUUM', 'CLUSTER', 'REFRESH', 'SECURITY', 'IMPORT', 'ANALYZE',
])
const TRANSACTION_COMMANDS = new Set([
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START', 'END', 'ABORT',
  'SET', 'RESET', 'DISCARD', 'LOCK',
])

/**
 * Words that must not appear anywhere in a statement we are about to treat as
 * a read, **whatever the engine**. Word-bounded, so `created_at` /
 * `update_seq` / `pg_settings` do not false-positive (the trailing `_` is a
 * word character, so `\bCREATE\b` and `\bUPDATE\b` cannot match inside them).
 *
 * `SELECT … FOR UPDATE` is deliberately rejected: it takes row locks, which is
 * not a read as far as a shared console is concerned.
 *
 * `ATTACH`/`DETACH`/`PRAGMA`/`VACUUM` live here rather than in the SQLite list
 * on purpose: they are SQLite's dangerous verbs, but no Postgres statement
 * legitimately contains them either, so blocking them everywhere costs
 * nothing and means a mis-declared dialect cannot open a hole.
 */
const SHARED_DENYLIST = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'COPY',
  'DROP', 'ALTER', 'CREATE', 'REPLACE', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'REINDEX', 'VACUUM', 'CLUSTER', 'REFRESH',
  'CALL', 'DO', 'PREPARE', 'EXECUTE', 'DEALLOCATE',
  'LISTEN', 'NOTIFY', 'UNLISTEN', 'LOCK', 'DISCARD',
  'ATTACH', 'DETACH', 'PRAGMA', 'IMPORT', 'SECURITY',
  // `SELECT … INTO new_table` is a CREATE TABLE wearing a SELECT's clothes,
  // and `VACUUM INTO 'exfil.db'` is a whole-database copy in one statement.
  'INTO',
]

/**
 * Engine-specific additions. These are the built-ins that reach outside the
 * database — the reason a "read-only" console is not automatically safe.
 *
 * SQLite's set has nothing in common with Postgres's: `writefile()` and
 * `readfile()` come from the `fileio` extension and write/read arbitrary paths
 * as the server user; `load_extension()` loads a shared library, i.e. arbitrary
 * code; `sqlite_dbpage` exposes raw B-tree pages (so `SELECT` alone can dump
 * every byte of a database, bypassing every table-level rule); `sqlar`,
 * `zipfile` and `fsdir` walk and unpack the filesystem. They are all blocked
 * even though the driver is *also* opened read-only, because "read-only" stops
 * writes to the database file — it does not stop a read that writes elsewhere.
 */
const DIALECT_DENYLIST: Record<SqlDialect, string[]> = {
  postgres: [
    'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_READ_FILE',
    'PG_READ_BINARY_FILE', 'PG_LS_DIR', 'LO_IMPORT', 'LO_EXPORT', 'DBLINK',
  ],
  sqlite: [
    'WRITEFILE', 'READFILE', 'FSDIR', 'LSMODE',
    'LOAD_EXTENSION', 'SQLITE_DBPAGE', 'SQLAR', 'ZIPFILE',
    'FTS3_TOKENIZER', 'EDIT',
  ],
  /**
   * MySQL's file surface: `LOAD_FILE()` reads any path the server user can
   * (it is a *function*, so it rides inside an ordinary `SELECT`), `INTO
   * OUTFILE`/`DUMPFILE` writes one (`INTO` is already shared-denylisted, but
   * naming these makes the rejection message say which one), `LOAD DATA
   * [LOCAL] INFILE` reads a client-side file through the protocol itself, and
   * `INSTALL PLUGIN`/`INSTALL COMPONENT` load native code. `HANDLER` opens a
   * raw storage-engine cursor that bypasses the optimiser and its checks.
   */
  mysql: [
    'LOAD_FILE', 'OUTFILE', 'DUMPFILE', 'INFILE',
    'INSTALL', 'UNINSTALL', 'HANDLER', 'FLUSH', 'KILL', 'SHUTDOWN',
    'SYS_EXEC', 'SYS_EVAL',
  ],
  // MariaDB is MySQL's surface plus its own: `sequence` engine tables are
  // harmless, but `mysql.plugin`-style loading is the same risk under the same
  // verbs, so the list is shared rather than diverged for its own sake.
  mariadb: [
    'LOAD_FILE', 'OUTFILE', 'DUMPFILE', 'INFILE',
    'INSTALL', 'UNINSTALL', 'HANDLER', 'FLUSH', 'KILL', 'SHUTDOWN',
    'SYS_EXEC', 'SYS_EVAL',
  ],
  /**
   * SQL Server's are the worst of any engine here, because several are
   * *procedures* invoked with `EXEC` (already shared-denylisted) and several
   * more ride inside a `SELECT`: `OPENROWSET`/`OPENDATASOURCE`/`OPENQUERY`
   * open an ad-hoc connection to another server (a read that is also an
   * outbound network call), `BULK` reads a file, and `xp_cmdshell` is a shell.
   */
  mssql: [
    'XP_CMDSHELL', 'SP_CONFIGURE', 'SP_EXECUTESQL', 'SP_OACREATE', 'SP_OAMETHOD',
    'OPENROWSET', 'OPENDATASOURCE', 'OPENQUERY', 'BULK', 'BACKUP', 'RESTORE',
    'SHUTDOWN', 'RECONFIGURE',
  ],
  /**
   * Oracle's file and network reach is all through built-in packages, which
   * are word-bounded names inside otherwise ordinary statements:
   * `UTL_FILE` (filesystem), `UTL_HTTP`/`UTL_TCP`/`UTL_SMTP` (outbound
   * network), `DBMS_SCHEDULER`/`DBMS_JOB` (deferred arbitrary execution),
   * `DBMS_LOB.LOADFROMFILE`, and `DBMS_XMLGEN`/`DBMS_XSLPROCESSOR`.
   */
  oracle: [
    'UTL_FILE', 'UTL_HTTP', 'UTL_TCP', 'UTL_SMTP', 'UTL_INADDR',
    'DBMS_SCHEDULER', 'DBMS_JOB', 'DBMS_LOB', 'DBMS_XMLGEN', 'DBMS_XSLPROCESSOR',
    'DBMS_SQL', 'DBMS_PIPE', 'DBMS_ADVISOR', 'JAVA',
  ],
  /**
   * DuckDB is an *analytics* engine whose whole point is reading files, so its
   * ordinary table functions are exactly the exfiltration primitives:
   * `read_csv`/`read_parquet`/`read_json` take any path or URL, `COPY … TO`
   * writes one, `INSTALL`/`LOAD` fetch and load a native extension, and
   * `httpfs` turns a `SELECT` into an outbound HTTP request. A read-only
   * DuckDB console is therefore *not* automatically a safe one.
   */
  duckdb: [
    'READ_CSV', 'READ_CSV_AUTO', 'READ_PARQUET', 'READ_JSON', 'READ_JSON_AUTO',
    'READ_BLOB', 'READ_TEXT', 'GLOB', 'INSTALL', 'LOAD', 'FORCE',
    'HTTPFS', 'PARQUET_SCAN', 'ICEBERG_SCAN', 'DELTA_SCAN', 'SNIFF_CSV',
  ],
}

const denylistCache = new Map<SqlDialect, RegExp>()

/** The word-bounded denylist regex for one dialect. Built once, then cached. */
function denylistFor(dialect: SqlDialect): RegExp {
  const cached = denylistCache.get(dialect)
  if (cached) return cached
  const built = new RegExp(
    `\\b(${[...SHARED_DENYLIST, ...(DIALECT_DENYLIST[dialect] ?? [])].join('|')})\\b`,
    'i',
  )
  denylistCache.set(dialect, built)
  return built
}

/**
 * Replace the *contents* of comments, string literals, dollar-quoted blocks and
 * quoted identifiers with spaces, preserving the original length so offsets
 * still line up with the source string.
 */
export function maskSql(sql: string): string {
  const out = sql.split('')
  const n = sql.length
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) out[k] = sql[k] === '\n' ? '\n' : ' '
  }
  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      // Postgres block comments nest.
      let depth = 1
      let k = i + 2
      while (k < n && depth > 0) {
        if (sql[k] === '/' && sql[k + 1] === '*') {
          depth++
          k += 2
        } else if (sql[k] === '*' && sql[k + 1] === '/') {
          depth--
          k += 2
        } else k++
      }
      blank(i, k)
      i = k
      continue
    }
    if (ch === "'") {
      let k = i + 1
      while (k < n) {
        if (sql[k] === "'" && sql[k + 1] === "'") k += 2
        else if (sql[k] === "'") {
          k++
          break
        } else k++
      }
      blank(i + 1, k - 1 >= i + 1 ? k - 1 : i + 1)
      i = k
      continue
    }
    if (ch === '"') {
      let k = i + 1
      while (k < n) {
        if (sql[k] === '"' && sql[k + 1] === '"') k += 2
        else if (sql[k] === '"') {
          k++
          break
        } else k++
      }
      blank(i + 1, k - 1 >= i + 1 ? k - 1 : i + 1)
      i = k
      continue
    }
    if (ch === '$') {
      const tag = /^\$\$|^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$/.exec(sql.slice(i))
      if (tag) {
        const marker = tag[0]
        const close = sql.indexOf(marker, i + marker.length)
        const stop = close === -1 ? n : close + marker.length
        blank(i, stop)
        i = stop
        continue
      }
    }
    i++
  }
  return out.join('')
}

/** Remove exactly one trailing `;` (mirrors the Java guard's helper). */
export function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim()
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed
}

/**
 * Split on statement-terminating semicolons only — semicolons inside literals,
 * comments and dollar-quoted bodies are not terminators.
 */
export function splitStatements(sql: string): string[] {
  const masked = maskSql(sql)
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ';') {
      const piece = sql.slice(start, i).trim()
      if (piece) parts.push(piece)
      start = i + 1
    }
  }
  const tail = sql.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function firstWord(masked: string): string {
  const m = /[A-Za-z_][A-Za-z0-9_]*/.exec(masked)
  return m ? m[0].toUpperCase() : ''
}

function classifyCommand(command: string): StatementKind {
  if (!command) return 'empty'
  if (READ_COMMANDS.has(command)) return 'read'
  if (WRITE_COMMANDS.has(command)) return 'write'
  if (DDL_COMMANDS.has(command)) return 'ddl'
  if (TRANSACTION_COMMANDS.has(command)) return 'transaction'
  return 'other'
}

/** Classify one statement. `sql` must already be a single statement. */
export function classifyStatement(
  sql: string,
  dialect: SqlDialect = DEFAULT_DIALECT,
): StatementInfo {
  const text = stripTrailingSemicolon(sql)
  const masked = maskSql(text)
  const command = firstWord(masked)
  let kind = classifyCommand(command)

  // A read-looking statement that mentions a denylisted keyword is not a read.
  // This is what catches `WITH d AS (DELETE … RETURNING *) SELECT * FROM d`,
  // `EXPLAIN ANALYZE UPDATE …` and `SELECT writefile('/tmp/x', content)`.
  if (kind === 'read' && denylistFor(dialect).test(masked)) kind = 'write'

  const missingWhere =
    (command === 'UPDATE' || command === 'DELETE') && !/\bWHERE\b/i.test(masked)

  return { sql: text, command, kind, missingWhere }
}

const KIND_SEVERITY: Record<StatementKind, number> = {
  empty: 0,
  read: 1,
  transaction: 2,
  other: 3,
  write: 4,
  ddl: 5,
}

/** Full analysis of a possibly multi-statement script. Never throws. */
export function analyzeSql(sql: string, dialect: SqlDialect = DEFAULT_DIALECT): SqlAnalysis {
  const pieces = splitStatements(sql ?? '')
  const statements = pieces.map((s) => classifyStatement(s, dialect))
  let kind: StatementKind = statements.length ? 'read' : 'empty'
  for (const s of statements) {
    if (KIND_SEVERITY[s.kind] > KIND_SEVERITY[kind]) kind = s.kind
  }
  const denylist = denylistFor(dialect)
  let smuggled: string | null = null
  for (const s of statements) {
    if (READ_COMMANDS.has(s.command)) {
      const hit = denylist.exec(maskSql(s.sql))
      if (hit) {
        smuggled = hit[1].toUpperCase()
        break
      }
    }
  }
  return {
    statements,
    kind,
    multiple: statements.length > 1,
    readOnly: statements.length > 0 && statements.every((s) => s.kind === 'read'),
    smuggledKeyword: smuggled,
    missingWhere: statements.filter((s) => s.missingWhere),
    dialect,
  }
}

/**
 * Throw unless `sql` is allowed under `options`. The single entry point every
 * adapter must call before sending anything to a server.
 */
export function assertSqlAllowed(sql: string, options: GuardOptions): SqlAnalysis {
  if (!sql || !sql.trim()) {
    throw new SqlGuardError('EMPTY_SQL', 'SQL statement is required')
  }
  const analysis = analyzeSql(sql, options.dialect ?? DEFAULT_DIALECT)
  if (!analysis.statements.length) {
    throw new SqlGuardError('EMPTY_SQL', 'SQL statement is required')
  }
  if (analysis.multiple && !options.allowMultipleStatements) {
    throw new SqlGuardError(
      'MULTIPLE_STATEMENTS',
      'Multiple statements are not allowed. Run one statement at a time, ' +
        'or enable multi-statement mode explicitly.',
    )
  }
  if (options.mode === 'read-only') {
    if (analysis.smuggledKeyword) {
      throw new SqlGuardError(
        'DISALLOWED_KEYWORD',
        `Statement contains a disallowed keyword (${analysis.smuggledKeyword}) in read-only mode`,
      )
    }
    for (const s of analysis.statements) {
      if (s.kind === 'ddl') {
        throw new SqlGuardError(
          'DDL_IN_READ_ONLY',
          `${s.command} is a schema change and is blocked in read-only mode`,
        )
      }
      if (s.kind !== 'read') {
        throw new SqlGuardError(
          'WRITE_IN_READ_ONLY',
          `${s.command || 'This statement'} is not a read and is blocked in read-only mode`,
        )
      }
    }
    return analysis
  }

  // read-write
  for (const s of analysis.statements) {
    if (s.kind === 'ddl' && !options.allowDdl) {
      throw new SqlGuardError(
        'DDL_NOT_ALLOWED',
        `${s.command} is a schema change; enable DDL explicitly to run it`,
      )
    }
    if (s.kind === 'other') {
      throw new SqlGuardError(
        'UNSUPPORTED_STATEMENT',
        `${s.command || 'This statement'} is not supported by this console`,
      )
    }
  }
  if (analysis.missingWhere.length && !options.confirmedUnqualified) {
    const s = analysis.missingWhere[0]
    throw new SqlGuardError(
      'UNQUALIFIED_WRITE',
      `${s.command} without a WHERE clause affects every row — confirm it explicitly`,
    )
  }
  return analysis
}

/**
 * True when the statement can be safely wrapped as
 * `SELECT * FROM (<sql>) _dbb LIMIT n` to enforce a server-side row cap.
 * `EXPLAIN`/`SHOW` cannot be wrapped and are capped client-side instead.
 */
export function isWrappableSelect(info: StatementInfo): boolean {
  return (
    info.kind === 'read' &&
    (info.command === 'SELECT' || info.command === 'WITH' || info.command === 'TABLE' || info.command === 'VALUES')
  )
}
