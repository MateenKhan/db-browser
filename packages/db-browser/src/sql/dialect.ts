/**
 * The SQL dialect, threaded from the `DataSource` to everything that has to
 * know what engine is on the other end of the wire.
 *
 * Before this module the library was dialect-locked in exactly three places —
 * `sql-formatter`'s `language`, and `@codemirror/lang-sql`'s `dialect` in the
 * editor's two `sql()` calls — all three hardcoded to Postgres. Both
 * underlying libraries already support many dialects, so the fix is to declare
 * the dialect once (on `DataSourceCapabilities`) and let highlighting,
 * completion and formatting follow the connected engine.
 *
 * **This stays a plain string union on purpose.** It is the one piece of
 * engine-specific knowledge the engine-agnostic package is allowed to hold,
 * because it is a *name*, not a driver: nothing here imports `pg`, `mysql2`,
 * `sqlite`, or anything that could only run against one server.
 *
 * ## Dialect is not engine
 *
 * A `SqlDialect` says *which grammar to parse and format with*. An `EngineId`
 * (see `@jugaaadi/db-browser-connectors`) says *which product you are talking
 * to*. They are deliberately different lists: CockroachDB speaks the Postgres
 * wire protocol and grammar, so its descriptor declares `dialect: 'postgres'`
 * while remaining its own engine with its own driver, capabilities and
 * introspection quirks. Collapsing the two would mean either inventing a
 * CockroachDB grammar nobody has written, or pretending Cockroach is Postgres
 * everywhere else too.
 */

/**
 * Grammars this library can describe. Adding one means: a `sql-formatter`
 * language below, a CodeMirror dialect in `react/SqlEditor.tsx`, and (if it
 * has its own dangerous built-ins) a denylist entry in `sql/guard.ts`.
 *
 * Every entry here is backed by a real grammar in **both** underlying
 * libraries — an entry with no `sql-formatter` language would format as
 * generic SQL, and one with no CodeMirror dialect would highlight as generic
 * SQL, which is worse than saying so.
 */
export type SqlDialect =
  | 'postgres'
  | 'sqlite'
  | 'mysql'
  | 'mariadb'
  | 'mssql'
  | 'oracle'
  | 'duckdb'

export const DEFAULT_DIALECT: SqlDialect = 'postgres'

/** Every dialect, for exhaustiveness checks and for `asDialect`. */
export const SQL_DIALECTS: readonly SqlDialect[] = [
  'postgres',
  'sqlite',
  'mysql',
  'mariadb',
  'mssql',
  'oracle',
  'duckdb',
]

/** Human label for the header badge. */
export const DIALECT_LABEL: Record<SqlDialect, string> = {
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  mssql: 'SQL Server',
  oracle: 'Oracle',
  duckdb: 'DuckDB',
}

/**
 * `sql-formatter`'s own language identifiers. Its names are not ours —
 * `postgresql` vs `postgres`, `transactsql` vs `mssql`, `plsql` vs `oracle` —
 * so the mapping is explicit rather than a cast.
 */
const FORMATTER_LANGUAGE: Record<SqlDialect, string> = {
  postgres: 'postgresql',
  sqlite: 'sqlite',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mssql: 'transactsql',
  oracle: 'plsql',
  duckdb: 'duckdb',
}

export function formatterLanguageFor(dialect: SqlDialect | undefined): string {
  return FORMATTER_LANGUAGE[dialect ?? DEFAULT_DIALECT] ?? FORMATTER_LANGUAGE[DEFAULT_DIALECT]
}

/**
 * `@codemirror/lang-sql`'s **export name** for each dialect.
 *
 * The editor cannot import the dialect objects from here — they are a React/DOM
 * dependency and this module is imported by Node adapters — so the mapping is
 * expressed as the export *name*, and the editor does
 * `CODEMIRROR_DIALECTS[codemirrorDialectName(d)]` against its own import.
 *
 * Two entries are not one-to-one, and both are deliberate:
 *
 *  - **`duckdb` → `PostgreSQL`.** `@codemirror/lang-sql` has no DuckDB
 *    dialect, and DuckDB's grammar is explicitly Postgres-compatible, so
 *    Postgres highlighting is correct rather than merely close. (The
 *    *formatter* does have a real `duckdb` language, which is why
 *    `formatterLanguageFor` and this disagree — they are different libraries
 *    with different coverage, and pretending otherwise is how the wrong
 *    grammar gets used.)
 *  - **`mssql` → `MSSQL`, `oracle` → `PLSQL`** — the library's own names.
 */
export const CODEMIRROR_DIALECT_NAME: Record<
  SqlDialect,
  'PostgreSQL' | 'SQLite' | 'MySQL' | 'MariaSQL' | 'MSSQL' | 'PLSQL' | 'StandardSQL'
> = {
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
  mysql: 'MySQL',
  mariadb: 'MariaSQL',
  mssql: 'MSSQL',
  oracle: 'PLSQL',
  duckdb: 'PostgreSQL',
}

export function codemirrorDialectName(
  dialect: SqlDialect | undefined,
): (typeof CODEMIRROR_DIALECT_NAME)[SqlDialect] {
  return CODEMIRROR_DIALECT_NAME[dialect ?? DEFAULT_DIALECT] ?? 'PostgreSQL'
}

/** Normalise anything that arrived over the wire back to a known dialect. */
export function asDialect(value: unknown): SqlDialect {
  return typeof value === 'string' && (SQL_DIALECTS as readonly string[]).includes(value)
    ? (value as SqlDialect)
    : DEFAULT_DIALECT
}

/**
 * Whether the engine namespaces tables under a schema the user has to think
 * about.
 *
 * SQLite has *databases* (`main`, `temp`, an `ATTACH`ed alias) rather than
 * schemas, and every ordinary table lives in `main`. MySQL/MariaDB have
 * *databases* too, and their `information_schema.table_schema` **is** the
 * database name — so a connection scoped to one database sees exactly one
 * "schema" and grouping by it is the same noise it is on SQLite. DuckDB
 * defaults everything to `main` for the same reason.
 *
 * Postgres, SQL Server and Oracle all have a real, user-facing second level
 * (`public`/`dbo`/the owning user), so grouping there is information.
 */
export function hasUserFacingSchemas(dialect: SqlDialect | undefined): boolean {
  const d = dialect ?? DEFAULT_DIALECT
  return d !== 'sqlite' && d !== 'mysql' && d !== 'mariadb' && d !== 'duckdb'
}

/** The schema/database name a bare table name resolves to. */
export function defaultSchemaFor(dialect: SqlDialect | undefined): string {
  switch (dialect ?? DEFAULT_DIALECT) {
    case 'sqlite':
    case 'duckdb':
      return 'main'
    case 'mssql':
      return 'dbo'
    // MySQL/MariaDB have no default schema at all — the "schema" is whichever
    // database the connection selected, which is only known at connect time.
    // An empty string is the honest answer; the adapter overrides it with the
    // live value from `DATABASE()`.
    case 'mysql':
    case 'mariadb':
      return ''
    case 'oracle':
      return ''
    default:
      return 'public'
  }
}
