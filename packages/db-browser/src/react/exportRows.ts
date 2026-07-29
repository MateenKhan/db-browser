/**
 * Result export.
 *
 * Exports are built from the **raw** row values, not from what the grid shows,
 * so a NULL exports as an empty CSV field / JSON `null` rather than the `␀`
 * display glyph. Binary cells export as their metadata, never as a `blob:`
 * URL — such a URL is valid only for the current page session and would be a
 * dead link in the file (see the README's blob caveat).
 */

import { isBinaryPlaceholder } from '../render/values.js'
import type { Row } from '../types.js'

export function toCsv(rows: readonly Row[], columns: readonly string[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    if (isBinaryPlaceholder(value)) return `[binary ${value.bytes ?? '?'} bytes]`
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [columns.join(',')]
  for (const row of rows) lines.push(columns.map((c) => escape(row[c])).join(','))
  return lines.join('\r\n')
}

export function toJson(rows: readonly Row[], columns: readonly string[]): string {
  const shaped = rows.map((row) => {
    const out: Row = {}
    for (const c of columns) {
      const v = row[c]
      out[c] = isBinaryPlaceholder(v) ? { binary: true, bytes: v.bytes } : v
    }
    return out
  })
  return JSON.stringify(shaped, null, 2)
}

/**
 * Trigger a download. The object URL is revoked on the next tick — it exists
 * only long enough for the click, and is never stored anywhere.
 */
export function downloadText(filename: string, text: string, mime: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
