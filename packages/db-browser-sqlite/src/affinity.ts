/**
 * SQLite's type system, which is **not** Postgres's.
 *
 * Three differences that matter to a browser, in the order they bite:
 *
 * 1. **Types are advisory.** A column's declared type does not constrain what
 *    it stores — `CREATE TABLE t(n INTEGER)` will happily hold the string
 *    `'hello'`. SQLite instead gives each column an *affinity*: a preference
 *    applied when converting a value on the way in. So the declared type tells
 *    you what the author *meant*, and the value tells you what is there. This
 *    module maps the declaration (for headers, filter operators and coercion
 *    hints) and nothing here ever assumes a value matches it.
 *
 * 2. **The declared type is free text.** `pragma table_info` returns exactly
 *    what was typed: `VARCHAR(255)`, `unsigned big int`, `DATETIME`, or `''`.
 *    Affinity is therefore computed by SQLite's own published five-rule
 *    substring algorithm, reproduced below, rather than by a name lookup — a
 *    lookup would have to enumerate an open set and would get `nvarchar(80)`
 *    wrong.
 *
 * 3. **Affinity is coarser than a render category.** Everything date-shaped has
 *    NUMERIC or TEXT affinity, because SQLite has no date type at all. So
 *    affinity is computed first (correctly, by the rules) and then *refined*
 *    using the declared name, which is the only place the author's intent
 *    survives — a `DATETIME` column is rendered as a timestamp even though
 *    SQLite considers it NUMERIC.
 */

import { categoryForType } from '@jugaaadi/db-browser/core'
import type { ValueCategory } from '@jugaaadi/db-browser/core'

/** SQLite's five affinities. */
export type SqliteAffinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC'

/**
 * SQLite's affinity rules, verbatim and **in order** — the order is the whole
 * algorithm. From the file-format documentation, §"Determination Of Column
 * Affinity":
 *
 *   1. contains "INT"                                  → INTEGER
 *   2. contains "CHAR", "CLOB" or "TEXT"               → TEXT
 *   3. contains "BLOB", or the type is empty           → BLOB
 *   4. contains "REAL", "FLOA" or "DOUB"               → REAL
 *   5. otherwise                                       → NUMERIC
 *
 * Rule 1 before rule 2 is why `POINT` is NUMERIC but `INTPOINT` is INTEGER, and
 * why `VARCHAR(20)` is TEXT while `UNSIGNED BIG INT` is INTEGER. Reordering
 * these is not a refactor; it changes what the database itself does.
 */
export function affinityOf(declaredType: string | null | undefined): SqliteAffinity {
  const t = (declaredType ?? '').toUpperCase()
  if (t.includes('INT')) return 'INTEGER'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT'
  if (t === '' || t.includes('BLOB')) return 'BLOB'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

/**
 * Declared names that carry meaning SQLite itself does not model. Checked
 * *before* falling back to affinity, because affinity alone would render a
 * `DATETIME` as a number and a `JSON` column as text.
 */
const DECLARED_HINTS: Array<[RegExp, ValueCategory]> = [
  // `TIMESTAMP`, `DATETIME`, `TIMESTAMPTZ` — matched before plain `DATE` so
  // `DATETIME` is a timestamp rather than a date.
  [/TIMESTAMP|DATETIME/, 'timestamp'],
  [/^DATE$/, 'date'],
  [/^TIME$/, 'time'],
  [/BOOL/, 'boolean'],
  [/JSON/, 'json'],
  [/UUID|GUID/, 'uuid'],
  // Extensions (sqlite-vec, sqlite-vss) declare vector columns like this.
  [/VECTOR|EMBEDDING|FLOAT\[\d*\]/, 'vector'],
]

export interface CategoryHints {
  /** Force `vector` — set by the introspector for a known embedding column. */
  isVector?: boolean
}

/** Map a SQLite column declaration to a render category. */
export function categoryForSqliteType(
  declaredType: string | null | undefined,
  hints: CategoryHints = {},
): ValueCategory {
  if (hints.isVector) return 'vector'
  const t = (declaredType ?? '').toUpperCase().trim()
  for (const [pattern, category] of DECLARED_HINTS) {
    if (pattern.test(t)) return category
  }
  switch (affinityOf(t)) {
    case 'INTEGER':
    case 'REAL':
      return 'number'
    case 'TEXT':
      return 'string'
    case 'BLOB':
      // An **empty** declared type also has BLOB affinity — `CREATE TABLE t(a)`
      // is legal and common — but it is not a blob column, it is an *untyped*
      // one, and untyped columns overwhelmingly hold small scalars. Treating
      // them as binary makes `sqlite_sequence.name` render as `[binary · 5 B]`
      // instead of `chunk`, which is not a cautious display, it is a wrong one.
      // Only an explicit BLOB declaration opts into never-project-inline; a
      // typeless column is rendered as text, and any actual `Uint8Array` value
      // that turns up is converted to a placeholder at row level instead (which
      // is required anyway, because SQLite's dynamic typing means *any* column
      // can hold a blob regardless of what it was declared as).
      return t === '' ? 'other' : 'binary'
    case 'NUMERIC':
      // NUMERIC is the catch-all: `DECIMAL(10,2)` belongs here and is a number,
      // but so does any unrecognised user type. Hand the name to the shared
      // mapper, which knows the SQL-standard spellings, and only call it
      // `other` when that does not recognise it either.
      return t ? fallbackCategory(t) : 'other'
    default:
      return 'other'
  }
}

/**
 * Last resort for a NUMERIC-affinity type the shared mapper does not know.
 *
 * The `DEC`/`NUM` probe is anchored to a word start, and that is a fix rather
 * than a tidy-up: an unanchored `/NUM/` matches **`ENUM`**, so a column
 * declared `CUSTOM_ENUM_T` was being reported as a number — and now that
 * `normalizedType` drives which editor the grid opens, that is not a cosmetic
 * mislabel, it is a numeric editor on a string column. `DECIMAL`, `NUMERIC`,
 * `BIG_DECIMAL` and `NUM` itself all still match; `ENUM` and `RENUMBER` do
 * not.
 */
function fallbackCategory(declared: string): ValueCategory {
  const shared = categoryForType(declared.toLowerCase(), declared.toLowerCase())
  return shared === 'other' ? (/(^|[^A-Z])(DEC|NUM)/i.test(declared) ? 'number' : 'other') : shared
}

/**
 * True for a column whose values must never be projected inline.
 *
 * BLOB affinity **and** an empty declared type both land here, which is
 * deliberate: `CREATE TABLE t(x)` gives `x` BLOB affinity, and a column that
 * might hold megabytes has to be treated as if it does until proven otherwise.
 * The cost of being wrong in this direction is a size chip where a short string
 * would have been fine; the cost of being wrong the other way is streaming
 * every byte of every row into a browser.
 */
export function isBinaryCategory(category: ValueCategory): boolean {
  return category === 'binary' || category === 'vector'
}
