/**
 * Value display and coercion.
 *
 * The grid edits **text**, the database stores **typed values**, and the two
 * have to round-trip without losing the distinction that matters most in a
 * database browser: `NULL` is not `''`. A cell rendered as an empty string
 * would make a NULL and an empty text column indistinguishable, and committing
 * one as the other is silent data loss.
 *
 * So NULL renders as a dedicated glyph (`␀`) which is never a legal value of
 * any scalar type, and the pending-changes panel also offers an explicit
 * "set NULL" toggle for anyone who would rather not type it.
 */

import type { ColumnMeta, ValueCategory } from '../types.js'

/** What a NULL looks like in the grid. Round-trips back to `null`. */
export const NULL_DISPLAY = '␀'

/** A binary cell placeholder — never the bytes themselves. */
export interface BinaryPlaceholder {
  __dbbBinary: true
  bytes: number | null
  contentType?: string | null
}

export function isBinaryPlaceholder(v: unknown): v is BinaryPlaceholder {
  return !!v && typeof v === 'object' && (v as BinaryPlaceholder).__dbbBinary === true
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

/** Render a value for the grid. Always returns a string. */
export function toDisplay(value: unknown, category?: ValueCategory): string {
  if (value === null || value === undefined) return NULL_DISPLAY
  if (isBinaryPlaceholder(value)) {
    return `[binary · ${formatBytes(value.bytes)}]`
  }
  if (value instanceof Date) return value.toISOString()
  if (category === 'boolean') return value === true ? 'true' : value === false ? 'false' : String(value)
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/**
 * Turn the text the user typed back into a value to bind as a parameter.
 *
 * Everything that is not JSON, an array, a boolean or a number is passed
 * through as a **string** and left for Postgres to cast — that keeps date,
 * interval, enum, uuid and domain types exact instead of re-implementing their
 * parsers here, and a bad value comes back as a normal database error.
 */
export function fromDisplay(text: string, column: Pick<ColumnMeta, 'category' | 'name'>): CoerceResult {
  if (text === NULL_DISPLAY) return { ok: true, value: null }
  const category = column.category
  if (category === 'binary') {
    return {
      ok: false,
      error: `Column "${column.name}" is binary. Binary values cannot be edited as text.`,
    }
  }
  if (text === '' && category !== 'string') {
    // For non-text columns an empty box almost always means "make it NULL".
    return { ok: true, value: null }
  }
  switch (category) {
    case 'number': {
      const n = Number(text)
      if (!Number.isFinite(n)) return { ok: false, error: `"${text}" is not a number` }
      // Keep the text for arbitrary-precision numerics so 1e21 etc. survive.
      return { ok: true, value: /^[-+]?\d+$/.test(text.trim()) ? n : text }
    }
    case 'boolean': {
      const t = text.trim().toLowerCase()
      if (['true', 't', 'yes', 'y', '1'].includes(t)) return { ok: true, value: true }
      if (['false', 'f', 'no', 'n', '0'].includes(t)) return { ok: true, value: false }
      return { ok: false, error: `"${text}" is not a boolean` }
    }
    case 'json': {
      try {
        return { ok: true, value: JSON.parse(text) }
      } catch (e) {
        return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
      }
    }
    case 'array': {
      const trimmed = text.trim()
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed)
          if (!Array.isArray(parsed)) return { ok: false, error: 'Expected a JSON array' }
          return { ok: true, value: parsed }
        } catch (e) {
          return { ok: false, error: `Invalid array literal: ${(e as Error).message}` }
        }
      }
      // Accept a Postgres array literal verbatim and let the server parse it.
      return { ok: true, value: trimmed }
    }
    default:
      return { ok: true, value: text }
  }
}

/** True when two cell values are the same as far as a pending edit is concerned. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (a instanceof Date || b instanceof Date) {
    const av = a instanceof Date ? a.getTime() : new Date(String(a)).getTime()
    const bv = b instanceof Date ? b.getTime() : new Date(String(b)).getTime()
    return av === bv
  }
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return String(a) === String(b)
}
