/**
 * The `?` cheat sheet.
 *
 * It is generated from the live registry rather than written out, so it can
 * never document a binding that no longer exists — and a shortcut that is
 * currently disabled (no index service, a read-only connection) simply is not
 * listed, which is more honest than greying out a row and making the user guess
 * why.
 *
 * Groups are ordered by how early a new user meets them, not alphabetically.
 */

import { useMemo } from 'react'
import { Dialog } from './Dialog.js'
import { Appear } from './motion.js'
import { keyLabelParts, useShortcutList } from './shortcuts.js'
import type { ShortcutSpec } from './shortcuts.js'

const GROUP_ORDER = ['Global', 'Navigate', 'Query', 'Search', 'Data', 'Connections']

function groupRank(group: string): number {
  const i = GROUP_ORDER.indexOf(group)
  return i === -1 ? GROUP_ORDER.length : i
}

/**
 * `mod+enter` → `['Ctrl', 'Enter']`, so each key can be its own `<kbd>`.
 *
 * The split happens on the **canonical** binding rather than on the rendered
 * label, so a platform whose key names are not separated by `+` (macOS writes
 * `⌘Return` solid) still gets one chip per key instead of a single run-on one.
 */
export function keyChips(keys: string): string[] {
  return keyLabelParts(keys)
}

export function ShortcutOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const all = useShortcutList()

  const groups = useMemo(() => {
    const map = new Map<string, ShortcutSpec[]>()
    for (const s of all) {
      const list = map.get(s.group) ?? []
      list.push(s)
      map.set(s.group, list)
    }
    return [...map.entries()].sort(([a], [b]) => groupRank(a) - groupRank(b) || a.localeCompare(b))
  }, [all])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      subtitle="Nothing fires while you are typing in a field or the SQL editor — except Esc, and the two editor commands marked below."
      size="lg"
      className="dbb-cheatsheet"
    >
      <div className="dbb-cheat-grid">
        {groups.map(([group, items], gi) => (
          <Appear key={group} index={gi} as="section" className="dbb-cheat-group">
            <h3 className="dbb-cheat-group-title">{group}</h3>
            <dl>
              {items.map((s) => (
                <div key={s.id} className="dbb-cheat-row">
                  <dt>
                    {s.label}
                    {s.allowInEditor ? (
                      <span className="dbb-cheat-flag" title="Also fires inside the SQL editor">
                        editor
                      </span>
                    ) : null}
                  </dt>
                  <dd>
                    {keyChips(s.keys).map((k, i) => (
                      <kbd key={`${k}-${i}`}>{k}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </Appear>
        ))}
        {!groups.length ? <p className="dbb-muted">No shortcuts are active on this screen.</p> : null}
      </div>
    </Dialog>
  )
}
