/**
 * The engine-agnostic type vocabulary.
 *
 * ## Why this exists
 *
 * Every engine spells the same idea differently: a 64-bit integer is `int8` in
 * Postgres's catalog, `bigint` in MySQL's, `INTEGER` in SQLite's declaration,
 * `bigint` in SQL Server's and `NUMBER(19)` in Oracle's. A grid that wants to
 * know "is this a whole number?" cannot ask that question of a raw type name
 * without embedding a table of every engine's spellings — which is exactly the
 * hardcoding this refactor exists to remove.
 *
 * So each **connector descriptor** carries a `typeMap` from its own raw type
 * names to this small, closed vocabulary, and everything downstream — the cell
 * editor, the formatter, the filter operator list, the value coercion on
 * commit — reads the normalized type instead. Adding an engine adds a map, not
 * a branch.
 *
 * ## The fallback rule, and why it is never a crash
 *
 * A type map is a *dictionary*, not a schema: engines ship extension types
 * (`geometry`, `vector`, `hstore`, `ltree`, `cidr`), users declare domains, and
 * a map written today cannot know a type added tomorrow. An unknown type
 * therefore normalises to **`'unknown'`**, which the grid renders as read-only
 * text — the value still displays, still exports, still copies. It is never an
 * exception, because "this database contains a column type I have not seen"
 * must not be the difference between browsing a table and a blank screen.
 *
 * Lookup is deliberately more than a `Map.get`, because raw type names carry
 * decoration the map should not have to enumerate:
 *
 *  - **parameters** — `character varying(255)`, `numeric(10,2)`, `NUMBER(19)`
 *  - **modifiers**  — `int unsigned zerofill`, `timestamp without time zone`
 *  - **arrays**     — Postgres's `_text` prefix and the trailing `[]` form
 *
 * `normalizeDbType` strips those, in that order, and only then consults the
 * map — so a descriptor lists `varchar` once instead of listing every width.
 */

/**
 * The closed vocabulary. Ordered roughly by how often a grid has to branch on
 * it, which is also the order the preset mapping reads best in.
 */
export type NormalizedType =
  | 'string'
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'uuid'
  | 'json'
  | 'binary'
  | 'array'
  | 'enum'
  | 'vector'
  | 'unknown'

export const NORMALIZED_TYPES: readonly NormalizedType[] = [
  'string',
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'time',
  'timestamp',
  'uuid',
  'json',
  'binary',
  'array',
  'enum',
  'vector',
  'unknown',
]

/** What an unrecognised raw type becomes. Documented, tested, never thrown. */
export const UNKNOWN_NORMALIZED_TYPE: NormalizedType = 'unknown'

const NORMALIZED_SET = new Set<string>(NORMALIZED_TYPES)

/** Normalise anything that arrived over the wire back into the vocabulary. */
export function asNormalizedType(value: unknown): NormalizedType {
  return typeof value === 'string' && NORMALIZED_SET.has(value)
    ? (value as NormalizedType)
    : UNKNOWN_NORMALIZED_TYPE
}

/** A raw type name reduced to the key a `typeMap` is expected to hold. */
export interface DbTypeParts {
  /** Lower-cased, de-parameterised, de-modified base name — the map key. */
  base: string
  /** True when the raw name described an array of `base`. */
  isArray: boolean
}

/**
 * Modifiers that decorate a type without changing what it *is*. Stripped
 * before the map lookup so `int unsigned` and `int` share one entry, and
 * `timestamp without time zone` does not need its own.
 *
 * `varying` and `precision` are deliberately NOT here: `character varying` and
 * `double precision` are whole type *names*, not decorated ones, and stripping
 * the second word would silently turn them into `character` and `double`.
 *
 * `unsigned` is the interesting one: it genuinely changes the range, but not
 * the *category* — an unsigned bigint is still an integer, and a grid that
 * cannot render it as one because the map lacked `bigint unsigned` is worse
 * off than one that treats the range as the database's business.
 */
const TYPE_MODIFIERS =
  /\b(unsigned|signed|zerofill|without time zone|with time zone|with local time zone|character set \w+|collate \w+)\b/g

/**
 * Split a raw type name into its map key.
 *
 * Postgres reports array types two ways depending on which catalog column you
 * read — `_text` from `pg_type.typname`, `text[]` from `format_type()` — and
 * both mean the same thing, so both are recognised.
 */
export function normalizeDbType(raw: string | null | undefined): DbTypeParts {
  let s = String(raw ?? '').trim().toLowerCase()
  if (!s) return { base: '', isArray: false }

  let isArray = false
  // `text[]`, `numeric(10,2)[]`, and the doubled `text[][]` (still one array
  // as far as rendering is concerned).
  while (s.endsWith('[]')) {
    isArray = true
    s = s.slice(0, -2).trim()
  }
  // Postgres's internal spelling. Guarded on a following letter so a genuinely
  // underscore-prefixed user type (`_internal_thing`) is not mistaken for one
  // — that is a real risk, so the check is deliberately narrow.
  if (s.startsWith('_') && /^_[a-z]/.test(s)) {
    isArray = true
    s = s.slice(1)
  }

  // Parameters: `varchar(255)`, `numeric(10, 2)`, `char(1) for bit data`.
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(TYPE_MODIFIERS, ' ')
  // Collapse the whitespace the two replacements left behind, keeping the
  // internal single spaces that multi-word names legitimately have
  // (`character varying`, `double precision`, `unsigned big int`).
  s = s.replace(/\s+/g, ' ').trim()

  return { base: s, isArray }
}

/**
 * Resolve a raw database type through a descriptor's `typeMap`.
 *
 * The order is: exact raw match (so a descriptor *can* pin a fully-decorated
 * spelling if it needs to), then the de-parameterised base, then the array
 * rule, then `'unknown'`. Nothing here throws.
 *
 * The array rule is applied **after** the base lookup rather than before, so a
 * descriptor that maps `_float4` to `'vector'` — which pgvector-style columns
 * want — keeps that answer instead of being flattened to `'array'`.
 */
export function normalizedTypeFor(
  raw: string | null | undefined,
  typeMap: Readonly<Record<string, NormalizedType>>,
): NormalizedType {
  const rawKey = String(raw ?? '').trim().toLowerCase()
  if (rawKey && typeMap[rawKey]) return typeMap[rawKey]

  const { base, isArray } = normalizeDbType(raw)
  if (!base) return UNKNOWN_NORMALIZED_TYPE

  const mapped = typeMap[base]
  if (mapped) return isArray && mapped !== 'vector' ? 'array' : mapped
  return isArray ? 'array' : UNKNOWN_NORMALIZED_TYPE
}

/**
 * True when a normalized type must never be projected inline.
 *
 * `vector` is a *sub-case* of `binary`, not a replacement, so every binary
 * safeguard still applies to it — the distinction exists only so a cell can
 * read `768 dims · 3.0 KB` instead of `[binary · 3.0 KB]`.
 */
export function isBinaryNormalizedType(type: NormalizedType): boolean {
  return type === 'binary' || type === 'vector'
}

/** True for the types a filter can meaningfully compare with `<`/`>`. */
export function isOrderedNormalizedType(type: NormalizedType): boolean {
  return (
    type === 'integer' ||
    type === 'decimal' ||
    type === 'date' ||
    type === 'time' ||
    type === 'timestamp'
  )
}
