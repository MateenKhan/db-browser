/**
 * The SQL editor.
 *
 * ## Why CodeMirror 6
 *
 * The requirement is highlighting **plus** completion **plus** a SQL dialect.
 * CodeMirror 6 gives all three from one small, tree-shakeable dependency:
 * `@codemirror/lang-sql` ships a Postgres dialect *and* a schema-aware
 * completion source, so table and column suggestions come from data we already
 * have (live introspection) rather than a second hand-maintained keyword list.
 * Monaco would work too but is an order of magnitude larger and drags in a
 * worker/AMD loader setup; a plain `<textarea>` with a regex highlighter gets
 * the highlighting subtly wrong on exactly the constructs that matter here
 * (dollar quoting, `::` casts, nested comments).
 *
 * The schema handed to the completion source is rebuilt from `DataSource`
 * introspection whenever it changes, through a `Compartment`, so suggestions
 * always describe the database actually connected — never a stale snapshot.
 *
 * ## The dialect is not hardcoded
 *
 * `@codemirror/lang-sql` ships a dialect object per engine, and they genuinely
 * differ: `PostgreSQL` knows `$$` bodies, `::` casts and `E''` escapes;
 * `SQLite` knows `[bracketed]` identifiers and its own built-in list.
 * Highlighting one engine's SQL with another's grammar mis-colours exactly the
 * constructs that are easiest to get wrong, and — worse — hands the completion
 * source the wrong keyword set. So the dialect comes from the connected
 * `DataSource` (`capabilities().dialect`) and is reconfigured through the same
 * `Compartment` as the schema, so switching connections re-arms both without
 * tearing the editor down.
 */

import { useEffect, useRef } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { MSSQL, MariaSQL, MySQL, PLSQL, PostgreSQL, SQLite, sql } from '@codemirror/lang-sql'
import type { SQLDialect } from '@codemirror/lang-sql'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder as placeholderExt } from '@codemirror/view'
import { DEFAULT_DIALECT, defaultSchemaFor } from '../sql/dialect.js'
import type { SqlDialect } from '../sql/dialect.js'
import type { TableMeta, TableSchema } from '../types.js'

/**
 * Our dialect names to CodeMirror's dialect objects. A `Record` over the union
 * rather than a lookup by string, so adding a dialect is a compile error here
 * until it has been given a grammar.
 *
 * Two entries are a *different* CodeMirror dialect rather than a missing one,
 * and the difference matters when reading highlighting bugs:
 *
 *  - **`oracle` → `PLSQL`.** CodeMirror names the grammar after the procedural
 *    language, not the product. Same grammar, different name.
 *  - **`duckdb` → `PostgreSQL`.** DuckDB's dialect is explicitly
 *    Postgres-compatible and CodeMirror ships no DuckDB grammar, so this is
 *    the closest *real* grammar rather than a fallback to generic SQL —
 *    `StandardSQL` would lose dollar quoting, `::` casts and array literals,
 *    all of which DuckDB has and uses.
 */
const CODEMIRROR_DIALECT: Record<SqlDialect, SQLDialect> = {
  postgres: PostgreSQL,
  sqlite: SQLite,
  mysql: MySQL,
  mariadb: MariaSQL,
  mssql: MSSQL,
  oracle: PLSQL,
  duckdb: PostgreSQL,
}

export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  /** Ctrl/Cmd+Enter. */
  onRun?: () => void
  /** Live introspection: every known table, and the columns we have fetched. */
  tables?: readonly TableMeta[]
  schemas?: ReadonlyMap<string, TableSchema>
  /** Which engine's grammar and keyword set to use. Default `postgres`. */
  dialect?: SqlDialect
  placeholder?: string
  readOnly?: boolean
  className?: string
}

/**
 * `@codemirror/lang-sql` wants `{ "schema.table": ["col", …] }`. Names in the
 * engine's *default* schema are registered unqualified too, so `SELECT * FROM
 * feat…` completes without typing `public.` — and on SQLite, where every
 * ordinary table lives in `main` and nobody types `main.`, that is the only
 * form that is any use.
 */
function buildCompletionSchema(
  tables: readonly TableMeta[],
  schemas: ReadonlyMap<string, TableSchema>,
  defaultSchema: string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const t of tables) {
    const qualified = `${t.schema}.${t.name}`
    const columns = schemas.get(qualified)?.columns.map((c) => c.name) ?? []
    out[qualified] = columns
    if (t.schema === defaultSchema && !(t.name in out)) out[t.name] = columns
  }
  return out
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  tables = [],
  schemas = new Map(),
  dialect = DEFAULT_DIALECT,
  placeholder = 'SELECT * FROM …',
  readOnly = false,
  className,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const runRef = useRef(onRun)
  const changeRef = useRef(onChange)
  runRef.current = onRun
  changeRef.current = onChange

  // Mount once; everything else is reconfigured in place.
  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        autocompletion({ activateOnTyping: true, icons: false }),
        placeholderExt(placeholder),
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        // Seeded with the dialect it mounted with; the effect below keeps it
        // in step if the connection (and therefore the engine) changes.
        langCompartment.current.of(
          sql({ dialect: CODEMIRROR_DIALECT[dialect] ?? PostgreSQL, upperCaseKeywords: true }),
        ),
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              runRef.current?.()
              return true
            },
          },
          ...closeBracketsKeymap,
          ...completionKeymap,
          ...historyKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changeRef.current(update.state.doc.toString())
        }),
        EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'inherit' } }),
      ],
    })
    const instance = new EditorView({ state, parent: host.current })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the document in sync when the value changes from outside (format,
  // history replay, a saved query) without fighting the user's cursor.
  useEffect(() => {
    const instance = view.current
    if (!instance) return
    const current = instance.state.doc.toString()
    if (current === value) return
    instance.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: Math.min(value.length, instance.state.selection.main.anchor) },
    })
  }, [value])

  // Re-arm grammar *and* completion whenever the dialect or introspection
  // changes. One compartment for both: they are configured by the same `sql()`
  // call, so splitting them would mean reconfiguring the language twice.
  useEffect(() => {
    const instance = view.current
    if (!instance) return
    const defaultSchema = defaultSchemaFor(dialect)
    instance.dispatch({
      effects: langCompartment.current.reconfigure(
        sql({
          dialect: CODEMIRROR_DIALECT[dialect] ?? PostgreSQL,
          upperCaseKeywords: true,
          defaultSchema,
          schema: buildCompletionSchema(tables, schemas, defaultSchema),
        }),
      ),
    })
  }, [tables, schemas, dialect])

  return <div className={`dbb-editor ${className ?? ''}`} ref={host} />
}
