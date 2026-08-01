# `@jugaaadi/db-browser`

A reusable **database browser** for React — browse tables with real pagination, edit rows through
a reviewed commit step, and run ad-hoc SQL behind a statement guard. Built on
[`@jugaaadi/table`](https://github.com/MateenKhan/Table), whose spreadsheet grid gives you cell
editing, a query builder, formatting, find & replace and export for free.

> ⚠️ **This tool grants database access.** Anything that can reach it can read — and, if you
> enable writes, change — whatever the connection can. Never expose the demo server, or any
> deployment of it, on a public origin without authentication in front of it. See
> [Security model](#security-model).

---

## What is in this repo

| Package | What it is |
| :--- | :--- |
| [`packages/db-browser`](packages/db-browser) | **`@jugaaadi/db-browser`** — the library. React UI + the transport-agnostic `DataSource` contract, SQL guard, pagination planner, pending-changes model, the normalized type vocabulary, and the vector-store contract/decoder. Browser-safe. |
| [`packages/db-browser-connectors`](packages/db-browser-connectors) | **`@jugaaadi/db-browser-connectors`** — the engine catalogue. Connector descriptors as **pure data**, on-demand driver loading, the shared `SqlDataSource`, the per-engine `Dialect` strategies, and the server-owned connection registry. **Node only.** |
| [`packages/db-browser-pg`](packages/db-browser-pg) | **`@jugaaadi/db-browser-pg`** — the Postgres entry point (a thin wrapper over the shared base, taking a `pg.Pool` you already own) and a dependency-free `node:http` handler. **Node only.** |
| [`packages/db-browser-sqlite`](packages/db-browser-sqlite) | **`@jugaaadi/db-browser-sqlite`** — the SQLite adapter (`node:sqlite`, falling back to `better-sqlite3`), with a `rowid` key fallback, a SQLite-flavoured guard, and vector-store / code-graph detection. **Node only.** |
| [`apps/demo`](apps/demo) | A demo that browses a Postgres database, a SQLite embedding store and a SQLite code graph, behind a source picker — plus the connector and connection API. |
| `vendor/` | `@jugaaadi/table` as a tarball — it is not published to a registry. |

```bash
npm install          # installs all five (npm workspaces)
npm run build:lib    # build the libraries first — the demo consumes their dist/
npm run build        # …and then the demo
npm test             # 420 unit tests: guard, dialects, identifiers, pagination, PK/rowid rules,
                     # storage, SQL builders, vector detection, blob decoding, search filters,
                     # descriptor validity, type normalisation, driver-absent messaging,
                     # MySQL's dialect, secret write-only-ness and the loopback gate
npm run typecheck
```

Then, in two terminals:

```bash
cp apps/demo/.env.example apps/demo/.env   # DSN and .db paths; they never leave the server
npm run demo:server                        # API + static server on :6960
npm run demo:web                           # Vite dev server on :5173
```

`verify.mjs` at the repo root is a manual end-to-end check against **real** databases —
introspection, pagination, the `rowid` fallback, blob decoding and the guard. Point it at your own
files with `CODE_GRAPH_DB`, `BIG_GRAPH_DB` and `EMBEDDINGS_DB`:

```bash
node verify.mjs
```

---

## Engines are metadata, not code

**An engine is a descriptor.** Adding one is a `ConnectorDescriptor` (pure data), a small `Dialect`
strategy, and a driver binding — with **no change to `@jugaaadi/db-browser`**. MySQL was
implemented after the abstraction existed, as the test of whether it was real; it needed exactly
those three files and nothing else.

```
descriptor (data)          dialect (strategy)             shared, engine-agnostic
──────────────────         ──────────────────             ───────────────────────
driverPackage              quoteIdent / qualify           the SQL guard + denylists
driverRange                placeholder style              the pagination planner
dialect                    LIMIT/OFFSET vs FETCH NEXT     identifier resolution
defaultPort                castToText / LIKE / IN         row-identity rules
connectionFields  ────►    byteLength / base64      ────► the pending-changes model
capabilities               introspection queries          createSqlDataSource
typeMap                    error normalisation            the wire protocol
```

The catalogue ships **eight** descriptors and **no drivers**:

| Engine | Driver package | Dialect | Adapter in this build |
| :--- | :--- | :--- | :--- |
| PostgreSQL | `pg` | `postgres` | yes — shared base |
| MySQL | `mysql2` | `mysql` | yes — shared base |
| MariaDB | `mysql2` | `mariadb` | yes — shared base |
| CockroachDB | `pg` | `postgres` | yes — shared base |
| SQLite | *(built in — `node:sqlite`)* | `sqlite` | yes — `@jugaaadi/db-browser-sqlite` |
| SQL Server | `mssql` | `mssql` | descriptor + type map only |
| DuckDB | `@duckdb/node-api` | `duckdb` | descriptor + type map only |
| Oracle | `oracledb` | `oracle` | descriptor + type map only |

Note that **`EngineId` and `SqlDialect` are different lists**. CockroachDB speaks the Postgres wire
protocol and grammar, so it declares `dialect: 'postgres'` while remaining its own engine with its
own driver, capabilities and quirks. Collapsing the two would mean either inventing a CockroachDB
grammar nobody has written, or pretending Cockroach is Postgres everywhere else too.

### Drivers are downloaded, not bundled

No connector is a dependency of anything here. Every one is an **optional peer**, and
`GET /api/connectors` works with none of them installed — that is the machine that most needs the
list. `installed` is resolved by *attempting resolution* on every call, never from a lockfile and
never from a memoised answer, because a driver can be removed between two requests and a registry
that says `installed: true` about a package that is gone produces the `MODULE_NOT_FOUND` this whole
mechanism exists to replace.

A missing driver never surfaces as a stack trace:

```
DRIVER_NOT_INSTALLED
The MySQL driver is not installed. Run:  npm install mysql2@^3.11.0

detail: MySQL connections need the "mysql2" package (^3.11.0). It is not bundled, so that
        a machine which never opens a MySQL connection never installs it.
```

The package manager is detected from `npm_config_user_agent`, so a server started with
`pnpm run server` is told `pnpm add`. `POST /api/connectors/:id/install` runs it as a child
process, streams the phase and a percentage, and refuses a concurrent install of the same package
(two package managers writing one `node_modules` corrupts it).

### The dialect table

| | Postgres | MySQL / MariaDB | SQLite |
| :--- | :--- | :--- | :--- |
| Editor grammar + completion | `PostgreSQL` | `MySQL` / `MariaSQL` | `SQLite` |
| Formatter language | `postgresql` | `mysql` / `mariadb` | `sqlite` |
| Identifier quoting | `"x"` | `` `x` `` (a `"` is a *string* unless `ANSI_QUOTES`) | `"x"` |
| Placeholders | `$n` | `?` | `?` |
| Cast to text | `x::text` | `CAST(x AS CHAR)` | `CAST(x AS TEXT)` |
| Case-insensitive LIKE | `ILIKE` | `LIKE` (already CI by collation) | `LIKE` |
| `IN` | `= ANY ($1)` | one placeholder per value | one placeholder per value |
| Blob length | `octet_length` | `LENGTH` | `length` |
| `RETURNING` | yes | no — the row is re-read | yes (3.35+) |
| Extra denylist | `pg_read_file`, `dblink`, `pg_ls_dir`, … | `LOAD_FILE`, `OUTFILE`, `INFILE`, `INSTALL`, … | `writefile()`, `readfile()`, `load_extension()`, `sqlite_dbpage`, `sqlar`, `zipfile`, `fsdir` |
| Read-only enforcement | `BEGIN … READ ONLY` | `START TRANSACTION READ ONLY` | driver-level `readOnly: true` |
| Row identity | `PRIMARY KEY` only | `PRIMARY KEY` only | `PRIMARY KEY`, else the implicit **`rowid`** |
| Default schema | `public` | the connected database (no grouping) | `main` (no grouping) |

Before this the library was dialect-locked in exactly three places — `sql-formatter`'s `language`,
and `@codemirror/lang-sql`'s `dialect` in the editor's two `sql()` calls. All three now read from
the connected source, and an unrecognised dialect is normalised to Postgres rather than handed
straight to CodeMirror.

### SQLite is the one engine not on the shared base

Every server-backed engine runs through `createSqlDataSource`. SQLite runs through
`@jugaaadi/db-browser-sqlite`'s own adapter instead, because it is a different *shape* rather than
a different set of strings: it is in-process and synchronous (no pool to pin, no `BEGIN` to route,
no statement timeout), its introspection is `pragma`-based, its **`rowid` fallback** is what makes
PK-less tables editable at all, it applies SQLite's five-rule **affinity** algorithm that no type
map can reproduce, it narrows **BigInt** integers, and it detects embedding stores and code graphs.

It implements the **same `DataSource` contract** and shares every safety property that is not
engine-specific — the guard, the pagination planner, the identifier rules, the row-identity rule
and the pending-changes model are the same code in both paths. `openConnection()` routes to it, so
a caller cannot tell the difference.

---

## Types are normalised, not hardcoded

Every engine spells the same idea differently: a 64-bit integer is `int8` in Postgres's catalog,
`bigint` in MySQL's, `INTEGER` in SQLite's declaration, and `NUMBER(19)` in Oracle's. So each
descriptor carries a `typeMap` into one closed vocabulary:

```
string · text · integer · decimal · boolean · date · time · timestamp
uuid · json · binary · array · enum · vector · unknown
```

`ColumnMeta` therefore carries **both** the raw name and the normalized one:

```jsonc
{
  "name": "total",
  "dataType": "decimal(12,2)",   // the human form
  "dbType": "decimal",           // the type-map key
  "normalizedType": "decimal",   // the vocabulary
  "isForeignKey": false,
  "references": null
}
```

Lookup strips what a map should not have to enumerate — parameters (`varchar(255)`), modifiers
(`int unsigned`, `timestamp without time zone`) and array decoration (`_text`, `text[]`) — so a
descriptor lists `varchar` once instead of every width.

**An unknown type is never a crash.** A type nobody mapped — PostGIS, `hstore`, an extension
released tomorrow — normalises to `unknown` and renders as read-only text. The value still
displays, still exports, still copies:

```
name          dataType        dbType          normalizedType  category
footprint     HYPERCUBE       hypercube       unknown         other
```

`NORMALIZED_TYPE_PRESET` maps the vocabulary onto **`@jugaaadi/table`'s own `ColumnTypePreset`
registry** rather than reimplementing it, so the grid's editors, formatters, alignment and filter
operators come from metadata alone. Three of those choices are deliberate and are worth stating,
because the obvious answer is wrong in each: `boolean` → `text` (the grid has no boolean preset,
and `number` would render Postgres's `true` differently from MySQL's `1`); `binary`/`vector` →
`text` and **not** `file` (a file picker would invite a user to replace a cell this library never
streams inline); and `integer` → `number` while `decimal` → `decimal`, because the grid's `number`
editor truncates and would silently drop the cents from a `numeric(10,2)`.

---

## Connections are server-owned

A connection is a host, a user and a password. `localStorage` is not an option — it is readable by
every script on the origin, survives in a synced browser profile, and is one XSS from being
exfiltrated wholesale — and it cannot work anyway, because the browser cannot open a TCP socket to
Postgres, so the server needs the credentials regardless.

The store is a JSON file the server owns, in `DB_BROWSER_STATE_DIR`. **Secrets are write-only**:
`values` and `secrets` are separate containers, so the serialiser that answers the API does not
have the plaintext to leak. A read reports only *whether* a secret is set:

```jsonc
// GET /api/connections
{ "id": "…", "name": "Prod Postgres", "engine": "postgres",
  "values": { "host": "db.internal", "port": 5432, "user": "browser", "readOnly": true },
  "secretsSet": ["password"] }        // ← never the value, in any response
```

On disk the field is AES-256-GCM ciphertext under a key file created `0600` beside it
(`"password": "v1:BfomTeFB…"`). GCM rather than CBC so a *tampered* ciphertext fails loudly instead
of decrypting to garbage that then gets sent to a database as a password. Encryption at rest stops
a password reaching a backup, a synced drive or a support ticket; it does not stop someone who can
read the key file, and it cannot — the server has to decrypt in order to connect.

### The loopback gate — not optional

**Connection create/edit/delete and connector install are disabled unless the server is bound to
loopback.** A reachable database browser that accepts arbitrary connection details is two tools at
once, and only one of them is the one you wanted:

1. **An SSRF engine.** "Connect to `10.0.0.7:5432`" is an internal port scan with a
   distinguishable response for open / closed / wrong-credentials. Against `169.254.169.254` it is
   a cloud-metadata probe. The *server* makes the connection, so every network boundary the browser
   could not cross is crossed for it.
2. **A credential harvester.** "Connect to `attacker.example:3306` as `root`" makes the server
   offer whatever password is typed to a machine the attacker controls — and MySQL's handshake
   hands over enough for an offline crack.

The decision is made from `server.address()` — not the `Host` header (attacker-controlled), not the
request's remote address, and not an environment variable, because a switch would *be* the
vulnerability. `0.0.0.0` and `::` are explicitly **not** loopback: they are "every interface",
which includes the ones that matter. An unknown binding defaults to disabled.

The refusal explains itself rather than 403-ing blankly:

```
HTTP 403  EDITING_DISABLED
Connection editing and connector installs are disabled because this server is bound to
0.0.0.0, not to loopback. A reachable database browser that accepts arbitrary connection
details is a server-side request forgery and credential-harvesting tool… Bind to 127.0.0.1
to manage connections; browsing already-configured sources is unaffected.
```

Reads are unaffected: `GET /api/connectors`, `GET /api/connections` and every `/api/db/*` browse
route keep working on a public bind. `GET /api/connectors` also returns the gate itself, so the UI
can render a disabled button *with the reason* rather than one that 403s when clicked.

### Endpoints

```
GET    /api/connectors                 -> { connectors: ConnectorStatus[], editing: {…} }
POST   /api/connectors/:id/install     -> 202 { job }        (returns immediately)
GET    /api/connectors/install/:jobId  -> { phase, percent, message, done, error, job }
GET    /api/connections                -> { connections: PublicConnection[] }
POST   /api/connections                -> 201 { connection }
PUT    /api/connections/:id            -> { connection }
DELETE /api/connections/:id            -> { ok: true }
POST   /api/connections/:id/test       -> { ok, durationMs, tableCount, message }
POST   /api/connections/test           -> the same, for an unsaved form
POST   /api/db/conn/:id/*              -> the ordinary wire protocol, for a saved connection
```

`test` probes with `listTables()` rather than a bare handshake, because "the TCP connection
succeeded" is not what a user means by *test*: a login that cannot read the catalog would otherwise
produce a green tick and then an empty sidebar. Every failure is scrubbed against the config's own
secrets before it is returned.

### SQLite: which driver, and why

**`node:sqlite` when the running Node has it** (22.5+; this repo verified on v22.20.0), because it
is built in — no native module to compile, no prebuilt binary to match against the running ABI,
and no install step that can fail on a machine where someone only wanted to *look* at a file.
`better-sqlite3` is faster at very high statement rates, which is not a browser's workload; it is
supported as an **optional peer** for consumers on an older Node, reached through the same small
`SqliteDb` interface so neither driver's API leaks past `driver.ts`.

One non-obvious thing `node:sqlite` forces: it **throws** `ERR_OUT_OF_RANGE` on any INTEGER
outside ±2^53 unless `setReadBigInts` is on — so a table with a snowflake id is not "displayed
oddly", it is unreadable. The adapter reads BigInts and narrows them: to a `number` when that
round-trips exactly, and to a **decimal string** when it does not, so nothing is silently rounded
and nothing downstream meets a BigInt that `JSON.stringify` refuses to serialise.

### SQLite's type system is not Postgres's

- **Types are advisory.** A declared type does not constrain what a column stores; SQLite applies
  an *affinity* instead. `affinity.ts` reproduces SQLite's five-rule substring algorithm **in
  order** — the order is the algorithm: `INT` before `CHAR` is why `INTPOINT` is INTEGER while
  `POINT` is NUMERIC — then refines it with the declared name, so `DATETIME` renders as a
  timestamp rather than a number.
- **An empty declared type is *untyped*, not binary.** `CREATE TABLE t(a)` has BLOB affinity by
  the letter of the rules, but treating it as binary made `sqlite_sequence.name` render as
  `[binary · 5 B]` instead of `chunk` — a wrong display, not a cautious one. Only an explicit
  `BLOB` opts into never-project-inline; because typing is dynamic, any actual `Uint8Array` that
  turns up in *any* column is converted to a placeholder at row level instead.
- **`PRIMARY KEY` does not imply `NOT NULL`** — a 2001 bug never fixed because too much data
  depended on it. `CREATE TABLE t(k TEXT PRIMARY KEY)` genuinely accepts a NULL `k` (asserted by
  test, against a real database). Nullability therefore comes from `table_info.notnull` and is
  never inferred from `pk`: telling the pagination planner that a nullable ordering column cannot
  be null silently drops rows from a keyset page.
- **With exactly one exception.** A single-column `INTEGER PRIMARY KEY` on a rowid table *is* the
  rowid, so inserting NULL allocates the next id rather than storing one. `table_info` still
  reports `notnull: 0`; taking that literally forced every such table — which is most of them —
  onto OFFSET pagination.

### `rowid` as a fallback key

Unlike Postgres, an ordinary SQLite table always has a unique 64-bit key whether or not anyone
declared one. Under the strict PK rule inherited from the Postgres adapter, every PK-less SQLite
table would be read-only — and PK-less tables are ordinary in SQLite in a way they are not in
Postgres, because the language never made you declare one to get a key. So a rowid table with no
declared PK is **editable via `rowid`**, and the UI says so rather than passing it off as a
primary key:

> **Editable via rowid.** This table has no PRIMARY KEY, so rows are addressed by SQLite's
> implicit rowid. That identifies exactly one row, so editing is safe — but a rowid is not stable
> across VACUUM, so do not store it as a durable reference.

Never applied to a **view**, a **virtual/shadow table**, or a **`WITHOUT ROWID`** table, which has
no rowid at all. (SQLite refuses to *create* a `WITHOUT ROWID` table without a `PRIMARY KEY` —
asserted by test — so in practice one always has a real key; the keyless branch is covered on the
pure function.) If a real column shadows `rowid`, the next unused alias (`_rowid_`, `oid`) is
used; if all three are taken there is no way to name the implicit key, and the table stays
read-only rather than silently addressing the wrong column.

---

## Install (in your own app)

```bash
npm i @jugaaadi/db-browser @jugaaadi/table react react-dom
# server side, pick your engine:
npm i @jugaaadi/db-browser-pg pg
npm i @jugaaadi/db-browser-sqlite          # node:sqlite; no native build
```

`react`, `react-dom` and `@jugaaadi/table` are **peer dependencies**. CodeMirror 6,
`sql-formatter` and `lucide-react` are regular dependencies and are left external in the build, so
your bundler deduplicates them with any copy you already have — and for `lucide-react` you always
have one, because `@jugaaadi/table` depends on it too, which is why the mode iconography costs
nothing extra.

```tsx
import { DbBrowser, createHttpDataSource } from '@jugaaadi/db-browser'
import '@jugaaadi/table/style.css'      // the grid's compiled styles
import '@jugaaadi/db-browser/style.css' // this package's chrome

const dataSource = createHttpDataSource({ baseUrl: '/api/db', id: 'prod-readonly' })

export default function Page() {
  return <DbBrowser dataSource={dataSource} defaultLimit={100} maxLimit={1000} />
}
```

Server side:

```ts
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { createPgDataSource, createDbBrowserHandler } from '@jugaaadi/db-browser-pg'

const dataSource = createPgDataSource({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  label: 'platformdb',   // a display name — never a DSN
  readOnly: true,        // the default
  statementTimeoutMs: 15_000,
  limits: { defaultLimit: 100, maxLimit: 1000 },
})

const api = createDbBrowserHandler({
  dataSource,
  basePath: '/api/db',
  authorize: (req) => (isSignedIn(req) ? null : { status: 401, message: 'Sign in' }),
})

createServer(async (req, res) => {
  if (await api(req, res)) return
  // …your own routes
}).listen(6960)
```

> **Import order matters once.** `@jugaaadi/table` reads `localStorage` at module-evaluation
> time, so this library loads it with a dynamic `import()` *after* installing a storage scope
> (see [The localStorage hazard](#the-localstorage-hazard)). Importing
> `@jugaaadi/table/style.css` statically is fine — a CSS entry does not evaluate the module —
> but do not statically `import { SpreadsheetTable } from '@jugaaadi/table'` in the same app if
> you want the scoping to cover it.

---

## The `DataSource` contract

A browser cannot open a socket to Postgres, so the library never talks to a database. It talks to
whatever you give it:

```ts
interface DataSource {
  readonly id: string                                  // namespaces client-side state
  capabilities(): DataSourceCapabilities               // { writes, keyset, binaryFetch, label, dialect }

  listTables(): Promise<TableMeta[]>                   // schema, name, kind, rowCountEstimate
  describeTable(t: TableRef): Promise<TableSchema>     // columns + primaryKey + updatable + reason

  select(q: SelectQuery): Promise<Page>                // limit, sort, filters, cursor | offset
  insert(t: TableRef, row: Row): Promise<Row>
  update(t: TableRef, pk: PkValues, patch: Row): Promise<Row>
  delete(t: TableRef, pk: PkValues): Promise<void>

  runQuery(sql: string, opts?: RunQueryOptions): Promise<QueryResult>
  fetchBinary?(t: TableRef, pk: PkValues, column: string): Promise<BinaryCellData>
  describeDatabase?(): Promise<DatabaseProfile>        // relational | vector | code-graph
}
```

Three implementations ship:

- **`createPgDataSource`** (`@jugaaadi/db-browser-pg`) — real Postgres over `pg`, for a Node process.
- **`createSqliteDataSource`** (`@jugaaadi/db-browser-sqlite`) — a SQLite file over `node:sqlite`,
  opened read-only at the driver level, with `rowid` key fallback and mode detection.
- **`createHttpDataSource`** (`@jugaaadi/db-browser`) — for the browser; posts JSON to the server
  that hosts either of the above.

Everything non-React is importable without pulling in React or the DOM:

```ts
import { assertSqlAllowed, planPage, quoteIdent, describeUpdatability } from '@jugaaadi/db-browser/core'
```

---

## Security model

This is a SQL console. It is treated as dangerous by default.

### 1. Read-only unless you opt in — twice

Both `createPgDataSource` and `createSqliteDataSource` default to `readOnly: true`. Enforcement is
layered, and **the outer layer is not made of regexes** — a guard is the first gate, never the only
one:

| Layer | Postgres | SQLite |
| :--- | :--- | :--- |
| **Statement guard** (`assertSqlAllowed`) | Classifies the statement and rejects writes, DDL, stacked statements and smuggled keywords **before** anything is sent. | Same, with the SQLite denylist. |
| **The engine itself** | `BEGIN … READ ONLY`, so Postgres refuses a write the guard missed: `ERROR: cannot execute UPDATE in a read-only transaction`. | The file is opened `readOnly` at the driver level: `attempt to write a readonly database`. Verified by going *straight to the driver*, bypassing the guard entirely. |
| **Extension / code loading** | — | `allowExtension: false` at open time, so `load_extension()` is unavailable even before the denylist sees it. Also `enableDoubleQuotedStringLiterals: false`, so a typo'd column name can never become a silent string constant. |
| **Timeouts** | `statement_timeout` + `idle_in_transaction_session_timeout` per transaction; one query cannot pin a connection. | Not applicable — SQLite runs in-process and synchronously, so there is no connection to pin. The row cap is the honest protection, and this is stated rather than papered over. |
| **Row caps** | Server-side. `SELECT` is wrapped as `SELECT * FROM (…) _dbb_capped LIMIT n`. | Same. |

SQLite's dangerous surface has nothing in common with Postgres's, so the denylist is
dialect-specific. Blocked in read-only mode and verified against a real database:
`ATTACH`/`DETACH DATABASE`, every `PRAGMA` (a read-only pragma and a write cannot be told apart
without a parser, so the verb is blocked — introspection does not go through the console anyway),
`VACUUM INTO 'exfil.db'` (a whole-database copy in one statement), `writefile()`, `readfile()`,
`load_extension()`, and the `sqlite_dbpage` / `sqlar` / `zipfile` / `fsdir` virtual tables — which
matter precisely because read-only stops writes *to the database file* and does nothing about a
read that writes somewhere else.

In the UI, writes additionally require an explicit per-statement **allow writes** toggle, and
`UPDATE`/`DELETE` without a `WHERE` clause requires confirmation on top of that.

### 2. No SQL is built by concatenating values

All CRUD goes through `packages/db-browser-pg/src/sqlBuilder.ts`. Values are always bound
parameters. There is no code path that renders a user value into statement text — the unit tests
assert exactly that, including with a `Robert'); DROP TABLE feature;--` payload.

### 3. Identifiers are resolved, then quoted

SQL has no placeholder for a table or column name, so identifiers must be interpolated. They are
only interpolated after being **resolved against live introspection** (a name the server never
reported cannot reach a statement) and then **double-quoted with `"` doubled**. A filter on
`code"; DROP TABLE feature; --` comes back as `404 COLUMN_NOT_FOUND`, not as SQL.

### 4. Multi-statement execution is off

`;` chaining is the classic path from a read-only console to `DROP TABLE`. It is rejected unless
*both* the server (`allowMultipleStatements`) and the request opt in. Semicolons inside string
literals, comments and `$$` bodies are not statement breaks — the guard masks those before
splitting, so `SELECT ';'` is one statement and `SELECT 1 -- x\n; DROP TABLE t` is two.

Blocked in read-only mode, all verified by test: `UPDATE`, `DELETE`, `INSERT`, `MERGE`, `DROP`,
`ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `CALL`, `DO`, `COPY … TO PROGRAM`, `SELECT … FOR UPDATE`,
`SELECT … INTO t` (a `CREATE TABLE` wearing a `SELECT`'s clothes), `pg_read_file()`,
`WITH d AS (DELETE … RETURNING *) SELECT …`, and `EXPLAIN ANALYZE UPDATE …` (which really
executes the update).

The guard is a port of Piranha's Java `ReadOnlySqlGuard`, hardened with literal/comment masking,
dollar-quote handling, data-modifying-CTE detection, and classification instead of
allow/deny-only.

### 5. Rows without a primary key are read-only

A row can only be updated when a key identifies exactly one row. Without one, the only available
`WHERE` is "every column equals its old value", which matches every duplicate row, cannot express
NULLs, and silently updates nothing if someone else changed the row first. So PK-less tables,
views and materialized views are surfaced as **read-only with the reason shown in the UI** rather
than written to on a guess. A partial composite key is refused too — `INCOMPLETE_PRIMARY_KEY`,
never a widened `WHERE`.

**SQLite gets one principled exception**: an ordinary rowid table always has a unique key even
when none was declared, so it is editable via `rowid` — labelled as such in the UI, and never
extended to views, virtual tables or `WITHOUT ROWID` tables. See
[`rowid` as a fallback key](#rowid-as-a-fallback-key).

### 6. Credentials

The DSN — and, for SQLite, the **file path** — is read from the environment by the server, is never
sent to the browser, never logged, and never echoed. `capabilities().label` is a display name
derived from the database name (Postgres) or the file's basename (SQLite), never the directory.
Driver errors are normalised before they leave the process, because a raw `pg` error object carries
the client config and a SQLite error interpolates the absolute path of the database file, which
discloses the server's filesystem layout.

---

## Pagination

Never `SELECT *` unbounded. A limit is always applied, always visible in the toolbar, and can
only be raised deliberately up to the server's `maxLimit`.

- **Keyset** (`WHERE (a, b) > ($1, $2) ORDER BY a, b LIMIT n`) whenever the table has a primary
  key. The PK is appended to whatever the user sorted by so the ordering is total, and the
  predicate is expanded lexicographically rather than as a row comparison, so mixed
  `ASC`/`DESC` works. Constant cost at any depth.
- **Offset** for PK-less tables and views — and deliberately also when an ordering column is
  **nullable**, because a NULL inside a keyset tuple comparison silently drops rows. A page that
  quietly loses rows is worse than a slow one. The UI shows which strategy is in use and warns
  on deep offset paging.
- `hasMore` comes from fetching `limit + 1` rows, so paging never needs a `COUNT(*)`. Sidebar
  counts are `pg_class.reltuples` **estimates**, labelled as such.

---

## Editing

Edits are **staged, not applied**. `SpreadsheetTable` fires a change per committed cell; turning
that straight into an `UPDATE` would mean a stray keypress rewrites a production row. Instead:

1. Every changed cell appears in a **pending panel**: `pk … | column | before → after`, with the
   number of `UPDATE`s that will run and a per-line **drop**.
2. **Commit** issues one parameterised `UPDATE` per row, keyed on the full primary key, and
   refuses if the statement matched 0 rows (someone else deleted it) or more than 1.
3. Editing a cell back to its original value **removes** the pending change.
4. Rejected edits (read-only table, PK column, binary column, unparseable value) snap the grid
   back to the truth and say why — the screen never shows an edit that is not going to happen.

Changes are matched to rows **by primary key**, not by row index, because the grid can sort
internally and an index means nothing by the time the change comes back.

**The grid's own query builder is wired to the live schema, not re-implemented.** Column
suggestions come from the `ColumnDef`s built out of `ColumnMeta`, so they name real columns of the
open table. Every column is declared to the grid as `meta.type: 'text'` on purpose: telling it a
column is a `number` or a `date` also hands it that type's *formatter*, which would round a
`bigint`, re-render a `timestamp(3)` in the grid's own format and then commit that back. A
database browser must show what the database holds, so values stay exact text in the grid and are
coerced once, at commit, from the real column category. Type information is not lost — it is shown
in the column header (`PK`/`FK` badges, nullability, the SQL type) and drives the toolbar's own
filter operators.

**NULL is not the empty string.** NULL renders as `␀` and round-trips back to `null`; an empty
text cell stays `''`. Values are coerced once, at commit, using the column's real category —
JSON is parsed and validated, arrays accept JSON or a Postgres literal, booleans accept
`true/t/yes/1`, and dates/enums/uuids are passed through as text for the server to cast, so their
semantics stay exact.

---

## The `localStorage` hazard

`@jugaaadi/table` persists to `localStorage`. For a spreadsheet that is right; for a database
browser it is actively wrong, because rows are a snapshot of a live server. Handled in two parts:

**Row data.** Verified against the `@jugaaadi/table@0.0.1` bundle: the exported
`SpreadsheetTable` renders with `standalone: false`, and both the read and the debounced write of
the sheet key `tt.customSheet.v1` are gated on that flag — **in library mode the table does not
persist rows at all.** This library does not rely on that alone: the scope shim drops writes to
that key in every mode, purges it on install, and the grid is re-keyed per table + page so its
state cannot outlive a navigation.

**Everything else.** These seven keys are *not* gated, and are keyed by **column id**:
`tableFormatting`, `tableColumnMerges`, `tableColumnTypeOverrides`, `tableCustomColumnTypes`,
`tableCustomFunctions`, `tableFormatProfiles`, `tableSavedQueries`. Two tables both having an
`id` column is the normal case, so formatting painted on one table's `id` would reappear on every
other table's `id`, in every database. The shim rewrites them to
`dbb:<connection>|<schema>.<table>:<key>`, so view state follows the table it was made on and
never crosses a connection. Everything else on the origin is untouched. `mode: 'suppress'` turns
persistence off entirely, and the header has a **reset view state** action.

Verified in the browser:

```js
localStorage.setItem('tableFormatting', '{"id":{"fill":"red"}}')
localStorage.setItem('tt.customSheet.v1', '{"version":1,"data":[{"leaked":"stale row"}]}')
localStorage.setItem('my-app-key', 'untouched')
Object.keys(localStorage)
// → ["dbb:demo-platformdb|public.feature:tableFormatting", "my-app-key"]
localStorage.getItem('tt.customSheet.v1')   // → null   (row data never persists)
// after switching to another table:
localStorage.getItem('tableFormatting')     // → null   (no cross-table leak)
```

## Binary / BYTEA cells

Blob URLs are session-scoped: they do not survive a reload and do not travel inside an export.
So this library never pretends one is a value.

- `SELECT` projects binary columns as `octet_length(col)`, never the bytes. The cell renders as
  `[binary · 1.2 KB]`.
- Clicking one opens a dialog with the type, size and the row's key, and an explicit
  **Fetch & download** action that reads that one cell as base64 on demand.
- The object URL is created, clicked and **revoked immediately**. Nothing is cached, and exports
  contain binary *metadata*, never a dead `blob:` link.

---

## The SQL editor: why CodeMirror 6

The requirement is highlighting **plus** completion **plus** a real SQL dialect.
`@codemirror/lang-sql` provides all three in one small, tree-shakeable dependency: a Postgres
dialect that gets dollar-quoting, `::` casts and nested comments right, and a schema-aware
completion source that takes `{ "schema.table": ["col", …] }` — which is exactly the shape live
introspection already produces, so **table and column suggestions come from the connected
database**, not a hand-maintained keyword list. It is rebuilt through a `Compartment` whenever
introspection changes.

Monaco would also work but is an order of magnitude larger and needs a worker/AMD loader setup;
a `<textarea>` plus a regex highlighter gets exactly the constructs that matter here subtly wrong.
Formatting uses **`sql-formatter`** (a formatter, not a parser we would then be tempted to trust
for security decisions); when it cannot parse something it returns the original text unchanged
rather than mangling it.

The console also has **query history** and **saved queries**, both namespaced per connection under
keys this package owns, and CSV/JSON export built from raw values (so NULL exports as empty/`null`,
not as the display glyph).

---

## Theming

The library ships plain CSS driven by custom properties rather than Tailwind utilities, for one
reason: `@jugaaadi/table` ships *compiled* styles so consumers do not need Tailwind, and requiring
it here would undo that. Every colour is a `--dbb-*` variable that **defaults to the table's own
`--jt-*` token** where one exists, so restyling the grid restyles this chrome with it:

```css
:root {
  --jt-accent: #7c3aed;   /* recolours the grid AND the browser chrome */
}
.dbb-root {
  --dbb-surface-2: #f5f3ff;  /* or target this package directly */
}
```

Light theme is the default; dark is honoured through `prefers-color-scheme` and an explicit
`[data-theme="dark"]`, matching the grid's own behaviour. Hover styling is `(hover: hover)`-gated,
motion uses a standard ease curve, and `prefers-reduced-motion` disables it. A Tailwind app can
also merge classes via `classNames={{ root, sidebar, main }}` on `<DbBrowser>` or style any part
by class (`.dbb-toolbar`, `.dbb-pending`, `.dbb-console`, …).

---

## Not every database is a grid

Some SQLite files are **embedding stores**, and some are **code graphs**. Both are derived data
whose rows answer a different question from a table's, so `DataSource.describeDatabase()` reports
what a file *is* — detected from its schema, never from configuration or a filename — and the main
pane follows:

| mode | pane | why |
| :--- | :--- | :--- |
| `relational` | grid + toolbar + pending changes | rows are the subject |
| `vector` | semantic search, ranked results, stats, rebuild | rows are 3 KB of floats |
| `code-graph` | node/edge overview, read-only, rebuild | rows are derived facts |

**The grid never goes away.** Every special mode has a *Browse tables* toggle, because "show me
the actual rows" is always legitimate — the special view is the better default, not a replacement.
`describeDatabase` is optional and any failure falls back to `relational`, so an adapter that has
never heard of profiles still works. The two modes get their own accent colour and their own
icon family (`react/icons.tsx`) so they are unmistakable from the grid: a similarity score misread
as a row count is a real failure, and the only thing preventing it is that the screens do not look
alike.

### The vector-store contract

Fixed by agreement with the indexer that writes these files. A database is an embedding store when
it has all three tables with (at least) these columns — a **superset passes**, because refusing to
recognise an index that gained a column would turn every schema addition into an outage:

```sql
chunk(id, path, start_line, end_line, kind, symbol, content, token_count, content_sha, updated_at)
embedding(chunk_id, model, dims, vector BLOB)   -- little-endian Float32Array, dims*4 bytes, L2-normalised
build_meta(key, value)                          -- model, dims, built_at, chunk_count, git_commit, …
```

Because the vectors are normalised at write time, **similarity is a plain dot product** — no
square root on the query path.

`vector/blob.ts` refuses to do three things, each because the alternative fails *silently*:

1. **Guess the length.** A blob whose byte length is not a multiple of 4 is not a float array, and
   one whose float count disagrees with its row's `dims` is a mixed-model index whose scores are
   meaningless. Both throw.
2. **Assume the host is little-endian.** `new Float32Array(buffer)` reads in *host* order; on a
   big-endian host every value would come back as garbage that still looks like a number.
3. **Assume alignment.** A Node `Buffer` is a view into a shared pool, so its `byteOffset` is
   frequently not a multiple of 4 and the `Float32Array` constructor throws outright. Unaligned
   input is copied.

### Never render a 768-float BLOB

`SELECT` projects a blob column as `length(col)`, never the bytes: 100 rows × 768 float32s is
300 KB per page for a value no cell can usefully show. A vector cell reads **`768 dims · 3.0 KB`**
— the dimension count first, because that is the number that identifies the model family and has
to match for a comparison to mean anything, with the size beside it as the sanity check (`dims × 4`
should equal the bytes, and the cell says `⚠ size mismatch` when it does not). The bytes are
fetched one cell at a time, on request, through `fetchBinary`. Editing a vector is refused with a
reason: it is derived data; rebuild the index instead.

### Prose matches prose — the `kind` filter

Measured against a real 13,482-chunk index (6,139 `function`, 2,623 `file`, 2,473 `class`,
2,247 `doc`), the query *"how are secrets encrypted before being stored"* returned **five
documentation chunks and zero code**, while the file that implements it was indexed correctly with
function-level chunks. That is not a ranking bug — it is what nearest-neighbour search *does*. A
question phrased in prose is genuinely nearer to a paragraph of prose than to the function it
describes, so on any conceptual query documentation wins; and because docs are only ~17% of the
index, the totals give no hint that it is happening.

The user, however, always knows which they wanted. So the results carry a **kind badge** (with its
own icon as well as its own colour — colour alone would fail exactly the readers who most need
this distinction), and a **kind filter sits beside the search box, not behind a disclosure**, with
a one-click **Code only** preset. Changing a filter re-runs the current query immediately; making
the user re-submit would put a second step back in front of the fix. Options and counts come from
the index's own `chunk.kind` histogram, so the filter never offers a kind the store does not have.

Same query, one click later:

```
all kinds          0.6949 [doc]      docs/DEPLOYMENT.md:158-179
                   0.6574 [doc]      docs/SECURITY-DEPLOYMENT.md:177-197
                   …five docs, no code

Code only          0.6258 [function] backend/agentic/db/tasks.ts:1270-1279   decryptAppSecrets
                   0.6135 [function] backend/agentic/db/appConfig.ts:183-208 readValues
                   0.6133 [class]    …/users/security/SecretCipher.java:18-49 SecretCipher
```

Filters are sent to the search endpoint in both `snake_case` and `camelCase`. A server that
supports them filters **before** ranking — "the top 10 functions". One that ignores unknown fields
still works, because the client over-fetches 5× and filters locally — but that can only mean "the
functions among the top 50", so the UI **says which happened** rather than letting the two look
identical. A path-prefix filter (`backend/`) works the same way.

### Rebuild with progress

The rebuild control renders **only** for a vector store or a code graph — a relational database
has nothing to rebuild, and such a button beside a production `customer` table is an invitation to
find out what it does.

`POST …/rebuild` returns a job id immediately; the UI polls `GET …/rebuild/:id` and renders a
spinner **plus a real percentage**, the current phase (`scan`/`chunk`/`embed`/`write`) as a
stepper, and processed/total counts. All three, because a percentage with no counts hides a total
that jumped, counts with no phase hide that the slow part has not started, and a spinner alone
cannot be told apart from a hang. A build takes minutes, so:

- **the UI never blocks** — everything is a poll on a timer;
- **progress survives a re-render** — the loop is keyed on the service, not on the parent;
- **progress survives a reload** — the *job id* is persisted (never its progress, which is server
  truth and is always re-read), and the hook re-attaches on mount. Verified: reloading mid-build
  resumed at 65%;
- **the button is disabled for the whole build**, not just the request, because a second POST
  starts a second indexer over the same file;
- **failures show the server's own message.** "no API key configured" is actionable; "The build
  failed" is not.

Search and rebuild are **not** on `DataSource`. They are served by the indexer, a different
process with a different lifetime that may not be running at all, so they live on a separate,
optional `VectorService`. Without it the stats, the tables and the SQL console all still work, and
only the controls that need it report themselves unavailable. The demo server proxies to a
configurable `PIRANHA_API_URL` and turns a refused connection into an actionable 503 rather than
failing the page.

### Code graphs

`code-review-graph` writes `.code-review-graph/graph.db`. The schema this renders was **read off a
real file**, not designed here: `nodes` (symbols keyed by `qualified_name`), `edges` (`kind`,
`source_qualified`, `target_qualified`), `metadata` (`schema_version`), plus the optional
`communities` / `flows` / `risk_index` tables that appear only once the deeper passes have run —
so those are deliberately *not* part of the match, and a `null` count means "that pass did not
run", which is a different fact from `0`.

Presented **read-only**, and not because of a missing feature: every row is a fact *about* source
code that a build produced. A hand-edit would survive until the next rebuild and, in the meantime,
make the graph disagree with the repository it claims to describe. The overview shows node/edge
kind histograms — the fastest way to see what a build actually captured, since a graph with 4,000
`File` nodes and 11 `CALLS` edges did not resolve calls — with every table one click away in the
grid.

---

## Tests

```
npm test        # 420 passing
```

| File | Covers |
| :--- | :--- |
| `packages/db-browser/__tests__/guard.test.ts` | Read-only classification, stacked statements, masking of literals/comments/`$$`, data-modifying CTEs, `SELECT … INTO`, read-write mode, unqualified `UPDATE`/`DELETE` |
| `packages/db-browser/__tests__/dialect.test.ts` | Dialect→formatter/CodeMirror mapping, normalisation of an unknown dialect, SQLite's denylist (`writefile`, `readfile`, `load_extension`, `sqlite_dbpage`, `sqlar`, `zipfile`, `fsdir`), `ATTACH`/`DETACH`/`PRAGMA`/`VACUUM INTO`, and that SQLite's entries do **not** leak into Postgres |
| `packages/db-browser/__tests__/vector.test.ts` | Contract matching (superset passes, missing column fails, the two contracts do not collide), BLOB→`Float32Array` decoding incl. unaligned views / wrong lengths / dims mismatch, dot-product-is-cosine, the kind & path filters, wire normalisation, and job re-attachment |
| `packages/db-browser-sqlite/__tests__/introspect.test.ts` | Affinity rules in order, `NOT NULL` inference (both the rule and its INTEGER-PK exception, proven against a live database), `rowid` fallback incl. views / `WITHOUT ROWID` / shadowed aliases, and the assembled `TableSchema` |
| `packages/db-browser/__tests__/identifiers.test.ts` | Quoting/escaping, control characters, resolution against introspection, injection attempts |
| `packages/db-browser/__tests__/pagination.test.ts` | Limit clamping, keyset vs offset choice, the nullable-column fallback, lexicographic predicates with mixed directions, cursor staleness |
| `packages/db-browser/__tests__/schema.test.ts` | Type→category mapping, composite PK order, **PK-less / view read-only rules**, row keys |
| `packages/db-browser/__tests__/changeset.test.ts` | Staging, revert-cancels-change, mutation ordering, NULL vs `''`, coercion |
| `packages/db-browser/__tests__/tableStorage.test.ts` | Key namespacing, cross-table and cross-connection isolation, row data never persisting, purge on install |
| `packages/db-browser-pg/__tests__/sqlBuilder.test.ts` | Parameterisation (no value ever inlined), binary projection, PK predicates, partial/NULL key refusal, generated columns, `LIMIT` sanitisation |
| `packages/db-browser-connectors/__tests__/descriptors.test.ts` | Descriptor validity — one per engine, a usable connection form, every credential field marked `secret`, lower-cased de-parameterised type-map keys, and a **static scan proving no descriptor imports its driver** (the property that makes the registry listable with nothing installed) |
| `packages/db-browser-connectors/__tests__/typeMapping.test.ts` | Parameter/modifier/array stripping, per-engine spellings, the **`unknown` fallback that never throws**, and the mapping onto `@jugaaadi/table`’s shipped preset ids (integer vs decimal; never a file picker for a blob) |
| `packages/db-browser-connectors/__tests__/driverLoader.test.ts` | Live resolution (never memoised), built-ins probed on the runtime rather than on npm, the four package managers, and the **actionable missing-driver message** — engine, package, range and exact command, never a `MODULE_NOT_FOUND` |
| `packages/db-browser-connectors/__tests__/mysqlDialect.test.ts` | MySQL through the *shared* builder and base: backtick quoting, `?` placeholders, `CAST(… AS CHAR)`, expanded `IN`, no `RETURNING`, SET-before-WHERE binding order, `tinyint(1)` vs `tinyint(4)`, enum-label parsing, `NULL table_rows` → -1, and that no value is ever inlined |
| `packages/db-browser-connectors/__tests__/connections.test.ts` | **Secrets are write-only** (absent from every response *and* from the file on disk, still usable to connect, kept across an unrelated edit), GCM tamper detection, descriptor-driven validation, and the **loopback gate** in both directions incl. `0.0.0.0`/`::` and the unknown-binding default |

---

## License

MIT. Built on [TanStack Table](https://tanstack.com/table) by way of `@jugaaadi/table` — please
support both.
