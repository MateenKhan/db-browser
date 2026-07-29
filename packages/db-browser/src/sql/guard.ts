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
 * so the database itself refuses a write the regex somehow missed.
 */

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
 * a read. Word-bounded, so `created_at` / `update_seq` / `pg_settings` do not
 * false-positive (the trailing `_` is a word character, so `\bCREATE\b` and
 * `\bUPDATE\b` cannot match inside them).
 *
 * `SELECT … FOR UPDATE` is deliberately rejected: it takes row locks, which is
 * not a read as far as a shared console is concerned.
 */
const DENYLIST = new RegExp(
  '\\b(' +
    [
      'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'COPY',
      'DROP', 'ALTER', 'CREATE', 'REPLACE', 'TRUNCATE', 'RENAME',
      'GRANT', 'REVOKE', 'REINDEX', 'VACUUM', 'CLUSTER', 'REFRESH',
      'CALL', 'DO', 'PREPARE', 'EXECUTE', 'DEALLOCATE',
      'LISTEN', 'NOTIFY', 'UNLISTEN', 'LOCK', 'DISCARD',
      'ATTACH', 'DETACH', 'PRAGMA', 'IMPORT', 'SECURITY',
      // `SELECT … INTO new_table` is a CREATE TABLE wearing a SELECT's clothes.
      'INTO',
      'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_READ_FILE',
      'PG_READ_BINARY_FILE', 'PG_LS_DIR', 'LO_IMPORT', 'LO_EXPORT', 'DBLINK',
    ].join('|') +
    ')\\b',
  'i',
)

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
export function classifyStatement(sql: string): StatementInfo {
  const text = stripTrailingSemicolon(sql)
  const masked = maskSql(text)
  const command = firstWord(masked)
  let kind = classifyCommand(command)

  // A read-looking statement that mentions a denylisted keyword is not a read.
  // This is what catches `WITH d AS (DELETE … RETURNING *) SELECT * FROM d`
  // and `EXPLAIN ANALYZE UPDATE …`.
  if (kind === 'read' && DENYLIST.test(masked)) kind = 'write'

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
export function analyzeSql(sql: string): SqlAnalysis {
  const pieces = splitStatements(sql ?? '')
  const statements = pieces.map(classifyStatement)
  let kind: StatementKind = statements.length ? 'read' : 'empty'
  for (const s of statements) {
    if (KIND_SEVERITY[s.kind] > KIND_SEVERITY[kind]) kind = s.kind
  }
  let smuggled: string | null = null
  for (const s of statements) {
    if (READ_COMMANDS.has(s.command)) {
      const hit = DENYLIST.exec(maskSql(s.sql))
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
  const analysis = analyzeSql(sql)
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
