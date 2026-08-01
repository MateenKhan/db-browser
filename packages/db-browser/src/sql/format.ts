/**
 * Query formatting.
 *
 * `sql-formatter` is used rather than a hand-rolled pretty-printer because it
 * has real per-engine dialects (Postgres knows `::` casts, `$$` bodies,
 * `FILTER`, window functions and dollar placeholders; SQLite knows its own
 * `?`/`:name` placeholders and does *not* know `::`) and it is a *formatter*,
 * not a parser we would then be tempted to use for security decisions.
 * Formatting never changes what a statement does — and when the formatter
 * cannot parse something, the original text is returned unchanged rather than
 * a mangled approximation.
 *
 * The language comes from the connected `DataSource`'s declared dialect rather
 * than being hardcoded: running a SQLite statement through the Postgres
 * grammar is how `?` placeholders and `[bracketed]` identifiers come back
 * rearranged.
 */

import { format as formatSql } from 'sql-formatter'
import { formatterLanguageFor } from './dialect.js'
import type { SqlDialect } from './dialect.js'

export interface FormatOptions {
  tabWidth?: number
  uppercaseKeywords?: boolean
  /** Defaults to `postgres`, which is the behaviour from before dialects existed. */
  dialect?: SqlDialect
}

export function formatQuery(sql: string, options: FormatOptions = {}): string {
  if (!sql.trim()) return sql
  try {
    return formatSql(sql, {
      // `sql-formatter` types `language` as a closed union of its own ids.
      // `formatterLanguageFor` is the only producer and it maps from our
      // dialect union, so this cast can only ever yield an id it accepts.
      language: formatterLanguageFor(options.dialect) as 'postgresql',
      tabWidth: options.tabWidth ?? 2,
      keywordCase: options.uppercaseKeywords === false ? 'preserve' : 'upper',
      expressionWidth: 80,
    })
  } catch {
    // A statement the formatter cannot parse is still a statement the server
    // might accept. Never destroy the user's text.
    return sql
  }
}
