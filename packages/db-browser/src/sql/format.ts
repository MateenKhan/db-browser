/**
 * Query formatting.
 *
 * `sql-formatter` is used rather than a hand-rolled pretty-printer because it
 * has a real Postgres dialect (it knows `::` casts, `$$` bodies, `FILTER`,
 * window functions and dollar placeholders) and it is a *formatter*, not a
 * parser we would then be tempted to use for security decisions. Formatting
 * never changes what a statement does — and when the formatter cannot parse
 * something, the original text is returned unchanged rather than a mangled
 * approximation.
 */

import { format as formatSql } from 'sql-formatter'

export interface FormatOptions {
  tabWidth?: number
  uppercaseKeywords?: boolean
}

export function formatQuery(sql: string, options: FormatOptions = {}): string {
  if (!sql.trim()) return sql
  try {
    return formatSql(sql, {
      language: 'postgresql',
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
