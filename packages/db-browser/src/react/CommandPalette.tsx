/**
 * The command palette (`Ctrl`/`⌘`+`K`).
 *
 * ## What is in it, and why that set
 *
 * Two kinds of entry, merged into one list:
 *
 *  1. **Every registered shortcut.** The palette is then automatically complete
 *     — a command that exists but is not in the palette is impossible by
 *     construction — and each row shows its binding, so the palette teaches the
 *     shortcuts rather than competing with them.
 *  2. **Navigation targets** — every table, and every configured source. These
 *     have no binding of their own because there are dozens of them; the
 *     palette is exactly the right home for a long, data-driven list.
 *
 * Matching is a subsequence match with a small ranking bias toward prefix hits,
 * so `chnk` finds `chunk` and typing the first letters of a table always puts
 * it first. No fuzzy library: the candidate set is tens of items, and a
 * dependency for that would be absurd.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from './Dialog.js'
import { Glyph } from './iconography.js'
import type { IconName } from './iconography.js'
import { keyChips } from './ShortcutOverlay.js'
import { useShortcutList } from './shortcuts.js'

export interface PaletteCommand {
  id: string
  label: string
  /** Right-aligned context: a schema name, an engine, a source label. */
  detail?: string
  icon: IconName
  group: string
  keys?: string
  run: () => void
}

/** Subsequence match; returns a score, or -1 for no match. */
function score(haystack: string, needle: string): number {
  if (!needle) return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  if (h.startsWith(n)) return 1000 - h.length
  const direct = h.indexOf(n)
  if (direct >= 0) return 500 - direct
  let hi = 0
  let gaps = 0
  for (const ch of n) {
    const at = h.indexOf(ch, hi)
    if (at === -1) return -1
    gaps += at - hi
    hi = at + 1
  }
  return 200 - gaps
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  /** Navigation and other data-driven entries. */
  commands: PaletteCommand[]
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const shortcuts = useShortcutList()

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const id = requestAnimationFrame(() => input.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const all = useMemo<PaletteCommand[]>(() => {
    const fromShortcuts = shortcuts
      // The palette's own binding in the palette is a joke, not a command.
      .filter((s) => s.id !== 'palette')
      .map<PaletteCommand>((s) => ({
        id: `sc:${s.id}`,
        label: s.label,
        icon: 'palette',
        group: s.group,
        keys: s.keys,
        run: s.run,
      }))
    return [...commands, ...fromShortcuts]
  }, [commands, shortcuts])

  const results = useMemo(() => {
    const q = query.trim()
    const scored = all
      .map((c) => ({ c, s: score(`${c.label} ${c.detail ?? ''}`, q) }))
      .filter((r) => r.s >= 0)
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, 60).map((r) => r.c)
  }, [all, query])

  useEffect(() => setActive(0), [query])

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = useCallback(
    (cmd: PaletteCommand | undefined) => {
      if (!cmd) return
      onClose()
      // After the dialog's focus restore, so the command can move focus itself.
      requestAnimationFrame(() => cmd.run())
    },
    [onClose],
  )

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Command palette"
      hideTitle
      size="md"
      className="dbb-palette"
      autoFocus={false}
    >
      <div className="dbb-palette-search">
        <Glyph name="palette" size="md" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to a table, run a command…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded
          aria-controls="dbb-palette-list"
          aria-activedescendant={results[active] ? `dbb-cmd-${results[active].id}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(results[active])
            }
          }}
        />
      </div>
      <ul className="dbb-palette-list" id="dbb-palette-list" role="listbox" ref={listRef}>
        {results.map((c, i) => (
          <li key={c.id} id={`dbb-cmd-${c.id}`} role="option" aria-selected={i === active}>
            <button
              type="button"
              className={i === active ? 'dbb-palette-item dbb-palette-item-on' : 'dbb-palette-item'}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(c)}
              tabIndex={-1}
            >
              <Glyph name={c.icon} size="md" />
              <span className="dbb-palette-label">{c.label}</span>
              {c.detail ? <span className="dbb-palette-detail">{c.detail}</span> : null}
              <span className="dbb-palette-group">{c.group}</span>
              {c.keys ? (
                <span className="dbb-keys">
                  {keyChips(c.keys).map((k, j) => (
                    <kbd key={`${k}-${j}`}>{k}</kbd>
                  ))}
                </span>
              ) : null}
            </button>
          </li>
        ))}
        {!results.length ? <li className="dbb-palette-empty">No command matches “{query}”.</li> : null}
      </ul>
    </Dialog>
  )
}
