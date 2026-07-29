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
| [`packages/db-browser`](packages/db-browser) | **`@jugaaadi/db-browser`** — the library. React UI + the transport-agnostic `DataSource` contract, SQL guard, pagination planner and pending-changes model. Browser-safe. |
| [`packages/db-browser-pg`](packages/db-browser-pg) | **`@jugaaadi/db-browser-pg`** — the reference Postgres adapter (`pg`) and a dependency-free `node:http` handler that exposes it. **Node only.** |
| [`apps/demo`](apps/demo) | A demo that browses a real Postgres database end to end. |
| `vendor/` | `@jugaaadi/table` as a tarball — it is not published to a registry. |

```bash
npm install          # installs all three (npm workspaces)
npm run build:lib    # build the libraries first — the demo consumes their dist/
npm run build        # …and then the demo
npm test             # 131 unit tests: guard, identifiers, pagination, PK rules, storage, SQL builder
npm run typecheck
```

Then, in two terminals:

```bash
cp apps/demo/.env.example apps/demo/.env   # put your DSN here; it never leaves the server
npm run demo:server                        # API + static server on :6960
npm run demo:web                           # Vite dev server on :5173
```

---

## Install (in your own app)

```bash
npm i @jugaaadi/db-browser @jugaaadi/table react react-dom
# server side:
npm i @jugaaadi/db-browser-pg pg
```

`react`, `react-dom` and `@jugaaadi/table` are **peer dependencies**. CodeMirror 6 and
`sql-formatter` are regular dependencies and are left external in the build, so your bundler
deduplicates them with any copy you already have.

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
  capabilities(): DataSourceCapabilities               // { writes, keyset, binaryFetch, label }

  listTables(): Promise<TableMeta[]>                   // schema, name, kind, rowCountEstimate
  describeTable(t: TableRef): Promise<TableSchema>     // columns + primaryKey + updatable + reason

  select(q: SelectQuery): Promise<Page>                // limit, sort, filters, cursor | offset
  insert(t: TableRef, row: Row): Promise<Row>
  update(t: TableRef, pk: PkValues, patch: Row): Promise<Row>
  delete(t: TableRef, pk: PkValues): Promise<void>

  runQuery(sql: string, opts?: RunQueryOptions): Promise<QueryResult>
  fetchBinary?(t: TableRef, pk: PkValues, column: string): Promise<BinaryCellData>
}
```

Two implementations ship:

- **`createPgDataSource`** (`@jugaaadi/db-browser-pg`) — real Postgres over `pg`, for a Node process.
- **`createHttpDataSource`** (`@jugaaadi/db-browser`) — for the browser; posts JSON to the server
  that hosts the one above.

Everything non-React is importable without pulling in React or the DOM:

```ts
import { assertSqlAllowed, planPage, quoteIdent, describeUpdatability } from '@jugaaadi/db-browser/core'
```

---

## Security model

This is a SQL console. It is treated as dangerous by default.

### 1. Read-only unless you opt in — twice

`createPgDataSource` defaults to `readOnly: true`. Enforcement is layered, and the outer layer
is not made of regexes:

| Layer | What it does |
| :--- | :--- |
| **Statement guard** (`assertSqlAllowed`) | Classifies the statement and rejects writes, DDL, stacked statements and smuggled keywords **before** anything is sent. |
| **`BEGIN … READ ONLY`** | Every read runs in a read-only transaction, so Postgres itself refuses a write the guard somehow missed: `ERROR: cannot execute UPDATE in a read-only transaction`. |
| **`statement_timeout`** + `idle_in_transaction_session_timeout` | Set per transaction via `set_config(..., true)`; one query cannot pin a connection. |
| **Row caps** | Server-side. `SELECT` is wrapped as `SELECT * FROM (…) _dbb_capped LIMIT n`. |

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

### 6. Credentials

The DSN is read from the environment by the server, is never sent to the browser, never logged,
and never echoed. `capabilities().label` is a display name derived from the database name only.
Driver errors are normalised before they leave the process, because a raw `pg` error object
carries the client config.

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

## Tests

```
npm test        # 131 passing
```

| File | Covers |
| :--- | :--- |
| `packages/db-browser/__tests__/guard.test.ts` | Read-only classification, stacked statements, masking of literals/comments/`$$`, data-modifying CTEs, `SELECT … INTO`, read-write mode, unqualified `UPDATE`/`DELETE` |
| `packages/db-browser/__tests__/identifiers.test.ts` | Quoting/escaping, control characters, resolution against introspection, injection attempts |
| `packages/db-browser/__tests__/pagination.test.ts` | Limit clamping, keyset vs offset choice, the nullable-column fallback, lexicographic predicates with mixed directions, cursor staleness |
| `packages/db-browser/__tests__/schema.test.ts` | Type→category mapping, composite PK order, **PK-less / view read-only rules**, row keys |
| `packages/db-browser/__tests__/changeset.test.ts` | Staging, revert-cancels-change, mutation ordering, NULL vs `''`, coercion |
| `packages/db-browser/__tests__/tableStorage.test.ts` | Key namespacing, cross-table and cross-connection isolation, row data never persisting, purge on install |
| `packages/db-browser-pg/__tests__/sqlBuilder.test.ts` | Parameterisation (no value ever inlined), binary projection, PK predicates, partial/NULL key refusal, generated columns, `LIMIT` sanitisation |

---

## License

MIT. Built on [TanStack Table](https://tanstack.com/table) by way of `@jugaaadi/table` — please
support both.
