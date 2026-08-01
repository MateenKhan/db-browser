/**
 * The keyboard layer: one registry, one listener, one place that decides
 * whether a keystroke is a command or a character.
 *
 * ## Why a registry instead of `onKeyDown` where the action lives
 *
 * Three things have to agree about every shortcut: the key that fires it, the
 * hint in the control's tooltip, and the row in the `?` cheat sheet. Wire them
 * separately and they drift within a week — the cheat sheet ends up documenting
 * a binding that was renamed, which is worse than having no cheat sheet. So a
 * shortcut is **declared once** as data ({@link ShortcutSpec}); the listener,
 * the tooltip helper ({@link hint}) and the overlay all read the same record.
 *
 * ## The typing rule
 *
 * A shortcut layer that fires while you are typing is a bug, not a feature:
 * `/` belongs in a `LIKE` pattern, `?` is a bind parameter, and `[` opens an
 * array literal. So {@link isTypingTarget} suppresses every binding whose
 * modifier set could be produced by ordinary typing — anything without Ctrl /
 * Cmd / Alt — inside an `input`, `textarea`, `select`, `contenteditable` or the
 * CodeMirror SQL editor.
 *
 * Three kinds of binding are exempt, and each is exempt for a stated reason:
 *
 *  - `Escape` — the one key that must always mean "get me out of here",
 *    including out of the field you are typing in.
 *  - Bindings marked `allowInEditor` — `Ctrl/Cmd+Enter` and `Shift+Alt+F` are
 *    *editor* commands. Their whole purpose is to fire while the editor has
 *    focus, and neither can be typed by accident.
 *  - Nothing else. A binding with a Ctrl/Cmd modifier still does **not** fire
 *    inside a text field unless it opts in, because `Ctrl+A` and friends belong
 *    to the field.
 *
 * ## Chords the browser keeps for itself
 *
 * A binding the browser handles at the window level never reaches the page, and
 * `preventDefault` cannot claw it back — so a cheat-sheet row for one is a
 * documented lie. Three were found by trying them and are deliberately avoided:
 * `Ctrl/⌘+Shift+M` (profile switcher), `Ctrl/⌘+Shift+C` (DevTools element
 * picker) and `Ctrl/⌘+Shift+W` (**closes the window** — the worst possible
 * home for an "arm writes" toggle). Their replacements are `Alt`-based.
 * `Alt+D`, `Alt+E`, `Alt+F` and `Alt+Home` are likewise spoken for; the rest of
 * the `Alt` range is free.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IS_MAC, formatKeys, splitKeys } from './platform.js'

export interface ShortcutSpec {
  /** Stable id. Re-registering the same id replaces the previous binding. */
  id: string
  /**
   * Canonical binding: lower-case, `+`-joined, modifiers first in the order
   * `mod`, `ctrl`, `alt`, `shift`. `mod` is ⌘ on macOS and Ctrl elsewhere.
   * Examples: `mod+k`, `mod+enter`, `shift+alt+f`, `/`, `?`, `escape`, `]`.
   */
  keys: string
  /** Imperative, in the user's words: "Run query", not "Query execution". */
  label: string
  /** Cheat-sheet section. Keep the set small. */
  group: string
  run: () => void
  /** Fire even while a text field or the SQL editor has focus. */
  allowInEditor?: boolean
  /** False hides it from the cheat sheet and stops it firing. */
  enabled?: boolean
}

interface Registry {
  register: (spec: ShortcutSpec) => () => void
  /** Every enabled binding, for the cheat sheet and the palette. */
  list: () => ShortcutSpec[]
}

/**
 * Two contexts, and the split is load-bearing rather than tidy.
 *
 * `useShortcuts` uses the registry as an effect dependency. If the registry
 * object also carried the version counter, then registering a shortcut would
 * bump the version, which would build a new context value, which would change
 * the effect's dependency, which would register again — an unbounded loop that
 * React reports as "Maximum update depth exceeded". So the callbacks live in a
 * context whose value **never** changes identity, and the counter — which only
 * the cheat sheet and the palette read — lives in its own.
 */
const ShortcutContext = createContext<Registry | null>(null)
const ShortcutVersionContext = createContext(0)

/** True when the event target is somewhere a keystroke is a character. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable) return true
  // CodeMirror renders a contenteditable, but the event can land on a child
  // span whose own `isContentEditable` is inherited — check the ancestor too.
  return typeof el.closest === 'function' && el.closest('.cm-editor') !== null
}

/** The canonical string for a keyboard event, matching `ShortcutSpec.keys`. */
export function eventKeys(e: KeyboardEvent): string {
  const parts: string[] = []
  const mod = IS_MAC ? e.metaKey : e.ctrlKey
  if (mod) parts.push('mod')
  // A non-`mod` Ctrl on macOS (or Meta on Windows) is its own modifier.
  if (IS_MAC ? e.ctrlKey : e.metaKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  let key = e.key
  if (key === ' ') key = 'space'
  parts.push(key.length === 1 ? key.toLowerCase() : key.toLowerCase())
  return parts.join('+')
}

/**
 * Alternate spellings of the same chord.
 *
 * `?` is `shift+/` on a US layout and its own key elsewhere, and browsers
 * disagree about whether `e.key` is already `?`. Matching both spellings is the
 * difference between the cheat sheet opening and the cheat sheet being a myth.
 */
function variants(keys: string): string[] {
  const out = [keys]
  if (keys === '?') out.push('shift+/', 'shift+?')
  if (keys === '/') out.push('shift+7')
  return out
}

/**
 * `mod+enter` → `Ctrl+Enter` on Windows/Linux, `⌘Return` on macOS.
 *
 * The spelling lives in `platform.ts`, not here: a key name is a property of
 * the machine the browser is running on, and this module's job is only to know
 * *which* keys a binding uses. Nothing in this package may spell a modifier at
 * a call site — see that file's header for why a wrong glyph is a functional
 * bug rather than a cosmetic one.
 */
export function keyLabel(keys: string): string {
  return formatKeys(keys)
}

/** The same binding as one chip per key, for `<kbd>` rendering. */
export function keyLabelParts(keys: string): string[] {
  return splitKeys(keys)
}

/**
 * A tooltip string with its binding appended: `hint('Run query', 'mod+enter')`
 * → `Run query · Ctrl+Enter`. Every control bound to a shortcut uses this, so
 * the binding is discoverable without opening the cheat sheet.
 */
export function hint(label: string, keys?: string): string {
  return keys ? `${label} · ${keyLabel(keys)}` : label
}

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const specs = useRef(new Map<string, ShortcutSpec>())
  const [version, setVersion] = useState(0)

  const register = useCallback((spec: ShortcutSpec) => {
    specs.current.set(spec.id, spec)
    setVersion((v) => v + 1)
    return () => {
      specs.current.delete(spec.id)
      setVersion((v) => v + 1)
    }
  }, [])

  const list = useCallback(
    () => [...specs.current.values()].filter((s) => s.enabled !== false),
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return
      const pressed = eventKeys(e)
      const typing = isTypingTarget(e.target)
      for (const spec of specs.current.values()) {
        if (spec.enabled === false) continue
        if (!variants(spec.keys).includes(pressed)) continue
        // Escape always gets through; everything else must opt in.
        if (typing && !spec.allowInEditor && spec.keys !== 'escape') continue
        e.preventDefault()
        e.stopPropagation()
        spec.run()
        return
      }
    }
    // Capture phase so a shortcut still fires when focus is inside a widget
    // that stops propagation — CodeMirror does, for most keys.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Stable for the lifetime of the provider: `register` and `list` are both
  // `useCallback(..., [])`, so this memo never produces a new object. See the
  // note on the two contexts above.
  const value = useMemo<Registry>(() => ({ register, list }), [register, list])

  return (
    <ShortcutContext.Provider value={value}>
      <ShortcutVersionContext.Provider value={version}>{children}</ShortcutVersionContext.Provider>
    </ShortcutContext.Provider>
  )
}

/**
 * Register a set of shortcuts for as long as the component is mounted.
 *
 * The specs array may be rebuilt on every render (it usually is — the handlers
 * close over current state), so registration is keyed on the *shape* of the
 * bindings rather than on object identity, and the handler is read through a
 * ref at fire time. Without that, a component that re-renders on every
 * keystroke would re-register on every keystroke.
 */
export function useShortcuts(specs: ShortcutSpec[]): void {
  const registry = useContext(ShortcutContext)
  const latest = useRef(specs)
  latest.current = specs

  // The identity of the *set*: ids, bindings and enabled flags. Handlers are
  // deliberately excluded — they are read live from `latest`.
  const signature = specs
    .map((s) => `${s.id}|${s.keys}|${s.enabled === false ? 0 : 1}|${s.label}|${s.group}`)
    .join('\n')

  useEffect(() => {
    if (!registry) return undefined
    const offs = latest.current.map((spec, i) =>
      registry.register({
        ...spec,
        run: () => latest.current[i]?.run(),
      }),
    )
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, signature])
}

/**
 * Every registered shortcut, for the cheat sheet and the palette.
 *
 * Subscribing to the version context is what makes this re-render when a pane
 * registers or drops a binding; the list itself is read fresh on each render.
 */
export function useShortcutList(): ShortcutSpec[] {
  const registry = useContext(ShortcutContext)
  const version = useContext(ShortcutVersionContext)
  return useMemo(() => (registry ? registry.list() : []), [registry, version])
}
