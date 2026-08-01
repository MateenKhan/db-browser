/**
 * The SQLite driver seam.
 *
 * ## Which driver, and why
 *
 * **`node:sqlite` is used when the running Node has it, and it does here
 * (Node v22.20.0 — `node:sqlite` landed in v22.5.0 and `DatabaseSync` has
 * shipped its `readOnly` option since).** It is preferred for one reason that
 * outweighs every other consideration in a *database browser*: it is built in,
 * so there is no native module to compile, no prebuilt binary to match against
 * the running ABI, and no install step that can fail on a machine where the
 * user only wanted to look at a file. `better-sqlite3` is faster at very high
 * statement rates, which is not this tool's workload — a browser issues one
 * paged `SELECT` per keystroke-free navigation.
 *
 * The fallback exists because the *consumer's* Node may be older than ours:
 * `loadDriver()` probes `node:sqlite` and falls back to `better-sqlite3` if it
 * is installed. Both are reached through the tiny `SqliteDb` interface below,
 * which is all the adapter uses, so neither driver's API leaks past this file.
 *
 * ## Two things this file exists to get right
 *
 * 1. **Read-only is opened at the driver level, not just guarded.** The
 *    statement guard is a regex over text and is the *first* gate; `readOnly:
 *    true` makes SQLite itself answer `attempt to write a readonly database`
 *    to anything the regex missed. A guard alone is one bug away from a write.
 *
 * 2. **Integers are read as BigInt and then narrowed.** `node:sqlite` **throws**
 *    `ERR_OUT_OF_RANGE` on any INTEGER outside ±2^53 unless `setReadBigInts` is
 *    on — so a table with a snowflake id or a nanosecond timestamp is not
 *    "displayed oddly", it is *unreadable*. Reading BigInts and converting back
 *    to a `number` when it is safe (and to a **string** when it is not) means
 *    every row renders, every value is exact, and nothing downstream has to
 *    cope with a BigInt that `JSON.stringify` refuses to serialise.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'

/** A prepared statement, reduced to what the adapter actually calls. */
export interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  /** Column names in result order — available even for a zero-row result. */
  columnNames(): string[]
  /**
   * Declared type of each result column, when it comes straight from a table
   * column; `null` for an expression. SQLite is dynamically typed, so this is
   * the *only* type information a result set carries.
   */
  columnTypes(): Array<string | null>
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement
  close(): void
  /** Which driver is in use, for the capabilities payload and diagnostics. */
  readonly driver: 'node:sqlite' | 'better-sqlite3'
}

export interface OpenOptions {
  filename: string
  /** Default true. Enforced by SQLite itself, not only by the guard. */
  readOnly?: boolean
}

/**
 * Narrow a value that came back from the driver.
 *
 * BigInt → number when it round-trips exactly, otherwise the decimal string.
 * A string is the right lossy-free fallback for a database browser: it renders
 * identically, exports identically, and — unlike a rounded `number` — does not
 * silently claim `9007199254740993` is `9007199254740992`.
 */
export function narrowValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  return value
}

function narrowRow(row: Record<string, unknown>): Record<string, unknown> {
  // `node:sqlite` returns null-prototype objects; spreading into a plain one
  // keeps `JSON.stringify`, `Object.entries` and React's key handling normal.
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(row)) out[key] = narrowValue(row[key])
  return out
}

// ---------------------------------------------------------------------------
// node:sqlite
// ---------------------------------------------------------------------------

interface NodeSqliteStatement {
  all(...p: unknown[]): unknown[]
  get(...p: unknown[]): unknown
  run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  columns(): Array<{ name: string; type: string | null; column: string | null }>
  setReadBigInts(on: boolean): void
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement
  close(): void
}

function wrapNodeSqlite(db: NodeSqliteDatabase): SqliteDb {
  return {
    driver: 'node:sqlite',
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql)
      // See the header: without this, any INTEGER outside ±2^53 throws rather
      // than being returned, so a whole table can become unreadable.
      stmt.setReadBigInts(true)
      return {
        all: (...p) => (stmt.all(...p) as Array<Record<string, unknown>>).map(narrowRow),
        get: (...p) => {
          const row = stmt.get(...p) as Record<string, unknown> | undefined
          return row ? narrowRow(row) : undefined
        },
        run: (...p) => stmt.run(...p),
        columnNames: () => stmt.columns().map((c) => c.name),
        columnTypes: () => stmt.columns().map((c) => c.type ?? null),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// better-sqlite3 (fallback for a Node without node:sqlite)
// ---------------------------------------------------------------------------

interface BetterSqliteStatement {
  all(...p: unknown[]): unknown[]
  get(...p: unknown[]): unknown
  run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  columns(): Array<{ name: string; type: string | null }>
  reader: boolean
}

interface BetterSqliteDatabase {
  prepare(sql: string): BetterSqliteStatement
  close(): void
  defaultSafeIntegers(on: boolean): void
}

function wrapBetterSqlite(db: BetterSqliteDatabase): SqliteDb {
  db.defaultSafeIntegers(true)
  return {
    driver: 'better-sqlite3',
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql)
      return {
        all: (...p) => (stmt.all(...p) as Array<Record<string, unknown>>).map(narrowRow),
        get: (...p) => {
          const row = stmt.get(...p) as Record<string, unknown> | undefined
          return row ? narrowRow(row) : undefined
        },
        run: (...p) => stmt.run(...p),
        // `columns()` throws on a statement that returns nothing (`reader` is
        // false); an empty list is the honest answer there.
        columnNames: () => (stmt.reader ? stmt.columns().map((c) => c.name) : []),
        columnTypes: () => (stmt.reader ? stmt.columns().map((c) => c.type ?? null) : []),
      }
    },
  }
}

// ---------------------------------------------------------------------------

/**
 * Open a database. Tries `node:sqlite`, then `better-sqlite3`, and reports
 * clearly when neither is available rather than surfacing a bare
 * `ERR_MODULE_NOT_FOUND`.
 */
export async function openSqlite(options: OpenOptions): Promise<SqliteDb> {
  const readOnly = options.readOnly !== false

  try {
    const mod = (await import('node:sqlite')) as {
      DatabaseSync: new (path: string, opts?: Record<string, unknown>) => NodeSqliteDatabase
    }
    return wrapNodeSqlite(
      new mod.DatabaseSync(options.filename, {
        readOnly,
        // Never create a database by opening it. A browser pointed at a typo'd
        // path should say "no such file", not silently produce an empty one and
        // then report that it has no tables.
        open: true,
        // `"a"` must always be an identifier, never a string literal. SQLite's
        // legacy misfeature would make a typo'd column name a silent constant.
        enableDoubleQuotedStringLiterals: false,
        // `load_extension()` is arbitrary code execution. It is denylisted in
        // the guard too; this is the layer that cannot be regexed around.
        allowExtension: false,
      }),
    )
  } catch (e) {
    // Only fall through when node:sqlite is *absent*. A real open failure
    // (missing file, corrupt header) must surface, not be retried on another
    // driver that will fail the same way with a worse message.
    const code = (e as { code?: string })?.code
    if (code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') {
      throw toSqliteError(e, options.filename)
    }
  }

  try {
    // The specifier is built at runtime so TypeScript does not try to resolve
    // `better-sqlite3`'s types at build time. It is an **optional** peer: this
    // package must compile, install and run without it, because the fallback
    // only matters on a Node too old to have `node:sqlite`.
    const specifier = 'better' + '-sqlite3'
    const mod = (await import(/* @vite-ignore */ specifier)) as unknown as {
      default: new (path: string, opts?: Record<string, unknown>) => BetterSqliteDatabase
    }
    return wrapBetterSqlite(new mod.default(options.filename, { readonly: readOnly, fileMustExist: true }))
  } catch (e) {
    const code = (e as { code?: string })?.code
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new DbBrowserError(
        'NO_SQLITE_DRIVER',
        'No SQLite driver available. Use Node 22.5+ (for the built-in node:sqlite) or install better-sqlite3.',
      )
    }
    throw toSqliteError(e, options.filename)
  }
}

/**
 * Normalise a driver error. SQLite's messages describe the *statement* and are
 * safe to surface; the raw error is not necessarily — it can carry the absolute
 * path of the database file, which is a filesystem-layout disclosure on a
 * shared host.
 */
export function toSqliteError(e: unknown, filename?: string): Error {
  if (e instanceof DbBrowserError) return e
  const err = e as { code?: string; message?: string; errcode?: number }
  const raw = typeof err?.message === 'string' ? err.message : 'SQLite operation failed'
  // Strip the path if the driver interpolated it into the message.
  const message = filename ? raw.split(filename).join('<database>') : raw
  if (/readonly database/i.test(message)) {
    return new DbBrowserError(
      'READ_ONLY',
      'SQLite refused the write: this database is open read-only.',
      message,
    )
  }
  if (/unable to open database file/i.test(message)) {
    return new DbBrowserError('DB_NOT_FOUND', 'The database file could not be opened.', message)
  }
  return new DbBrowserError(err?.code ? `SQLITE_${err.code}` : 'DB_ERROR', message)
}
