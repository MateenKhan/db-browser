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
 */

import { useEffect, useRef } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder as placeholderExt } from '@codemirror/view'
import type { TableMeta, TableSchema } from '../types.js'

export interface SqlEditorProps {
  value: string
  onChange: (value: string) => void
  /** Ctrl/Cmd+Enter. */
  onRun?: () => void
  /** Live introspection: every known table, and the columns we have fetched. */
  tables?: readonly TableMeta[]
  schemas?: ReadonlyMap<string, TableSchema>
  placeholder?: string
  readOnly?: boolean
  className?: string
}

/**
 * `@codemirror/lang-sql` wants `{ "schema.table": ["col", …] }`. Unqualified
 * names are registered too so `SELECT * FROM feat…` completes without typing
 * `public.`.
 */
function buildCompletionSchema(
  tables: readonly TableMeta[],
  schemas: ReadonlyMap<string, TableSchema>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const t of tables) {
    const qualified = `${t.schema}.${t.name}`
    const columns = schemas.get(qualified)?.columns.map((c) => c.name) ?? []
    out[qualified] = columns
    if (t.schema === 'public' && !(t.name in out)) out[t.name] = columns
  }
  return out
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  tables = [],
  schemas = new Map(),
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
        langCompartment.current.of(sql({ dialect: PostgreSQL, upperCaseKeywords: true })),
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

  // Re-arm completion whenever introspection changes.
  useEffect(() => {
    const instance = view.current
    if (!instance) return
    instance.dispatch({
      effects: langCompartment.current.reconfigure(
        sql({
          dialect: PostgreSQL,
          upperCaseKeywords: true,
          defaultSchema: 'public',
          schema: buildCompletionSchema(tables, schemas),
        }),
      ),
    })
  }, [tables, schemas])

  return <div className={`dbb-editor ${className ?? ''}`} ref={host} />
}
