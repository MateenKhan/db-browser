/**
 * The chunk-kind filter, and why it is not an optional refinement.
 *
 * Measured against Piranha's real index (13,482 chunks — 6,139 `function`,
 * 2,623 `file`, 2,473 `class`, 2,247 `doc`), the query *"how are secrets
 * encrypted before being stored"* returned **five documentation chunks and zero
 * code**, while the file that actually implements it was indexed with correct
 * function-level chunks. That is not a ranking bug to be fixed later; it is
 * what nearest-neighbour search *does*. A prose question is genuinely nearer to
 * a paragraph of prose than to the function it describes, so on any conceptual
 * query documentation wins — and because docs are only ~17% of the index, the
 * totals give no hint that it is happening.
 *
 * The user, however, always knows which they wanted. "Where is this
 * implemented" wants `function`+`class`; "how does this work" wants `doc`. So
 * the filter is rendered **next to the search box, not behind a disclosure**,
 * and there is a one-click **Code only** preset, because that is the case that
 * currently fails and the whole point is to make the fix cost one click.
 *
 * Options come from the index's own `chunk.kind` histogram rather than a
 * hardcoded list, so a store with different kinds gets the right chips and the
 * counts are real.
 */

import { useMemo } from 'react'
import { Glyph } from './iconography.js'

export interface KindFilterProps {
  /** Every kind in the index, with counts. Biggest first. */
  available: ReadonlyArray<{ kind: string; count: number }>
  /** Selected kinds. **Empty means "all"**, which is also the default. */
  selected: readonly string[]
  onChange: (kinds: string[]) => void
  disabled?: boolean
}

/**
 * Which kinds count as "code". Used only by the preset; a kind this does not
 * know about is still selectable individually, and the preset simply will not
 * include it.
 */
export const CODE_KINDS = ['function', 'class', 'method', 'type', 'interface', 'struct']

/** Kinds get a stable colour so doc-vs-code is legible without reading. */
export function kindClass(kind: string | null | undefined): string {
  const k = String(kind ?? '').toLowerCase()
  if (k === 'doc' || k === 'docs' || k === 'documentation') return 'dbb-kind dbb-kind-doc'
  if (k === 'file') return 'dbb-kind dbb-kind-file'
  if (CODE_KINDS.includes(k)) return 'dbb-kind dbb-kind-code'
  return 'dbb-kind'
}

export function KindFilter({ available, selected, onChange, disabled }: KindFilterProps) {
  const selectedSet = useMemo(() => new Set(selected.map((k) => k.toLowerCase())), [selected])
  const allSelected = selected.length === 0

  const codeKinds = useMemo(
    () => available.filter((a) => CODE_KINDS.includes(a.kind.toLowerCase())).map((a) => a.kind),
    [available],
  )

  if (!available.length) return null

  const toggle = (kind: string) => {
    // "All" is represented as the empty set, not as every kind ticked — so the
    // first click on a chip has to mean "only this one", which is what a user
    // clicking a single chip out of an all-selected row expects.
    if (allSelected) {
      onChange([kind])
      return
    }
    const next = selectedSet.has(kind.toLowerCase())
      ? selected.filter((k) => k.toLowerCase() !== kind.toLowerCase())
      : [...selected, kind]
    onChange(next)
  }

  const codeOnlyActive =
    !allSelected &&
    selected.length === codeKinds.length &&
    codeKinds.every((k) => selectedSet.has(k.toLowerCase()))

  return (
    <div className="dbb-kinds" role="group" aria-label="Filter results by chunk kind">
      <span className="dbb-kinds-label">
        <Glyph name="filter" size="sm" />
        Kinds
      </span>

      <button
        type="button"
        className={allSelected ? 'dbb-chip dbb-chip-on' : 'dbb-chip'}
        onClick={() => onChange([])}
        disabled={disabled}
        aria-pressed={allSelected}
        title="Search every kind of chunk"
      >
        All
      </button>

      {codeKinds.length ? (
        <button
          type="button"
          className={codeOnlyActive ? 'dbb-chip dbb-chip-on dbb-chip-code' : 'dbb-chip dbb-chip-code'}
          onClick={() => onChange(codeOnlyActive ? [] : codeKinds)}
          disabled={disabled}
          aria-pressed={codeOnlyActive}
          title="Only functions and classes — the fix for a conceptual query that returns nothing but documentation"
        >
          <Glyph name="chunk" size="sm" className="dbb-kind-glyph" />
          Code only
        </button>
      ) : null}

      <span className="dbb-kinds-sep" aria-hidden />

      {available.map(({ kind, count }) => {
        const on = allSelected || selectedSet.has(kind.toLowerCase())
        return (
          <button
            key={kind}
            type="button"
            className={`${kindClass(kind)} dbb-chip ${on ? 'dbb-chip-on' : ''}`}
            onClick={() => toggle(kind)}
            disabled={disabled}
            aria-pressed={on}
            title={`${count.toLocaleString()} ${kind} chunks in this index`}
          >
            {kind}
            <span className="dbb-chip-count">{count.toLocaleString()}</span>
          </button>
        )
      })}
    </div>
  )
}
