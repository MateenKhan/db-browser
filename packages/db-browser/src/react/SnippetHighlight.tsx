/**
 * Syntax highlighting for a retrieved code snippet.
 *
 * ## Why not a real parser
 *
 * The SQL editor uses CodeMirror because there is exactly one language in it
 * and getting `$$` bodies and `::` casts wrong is a correctness problem. A
 * search result is the opposite situation: the snippets come from whatever the
 * indexed repository is written in — TypeScript, Java, Python, Go, Rust, YAML —
 * and a *grammar per language* would mean shipping a dozen Lezer parsers to
 * colour twelve lines of text. Worse, a snippet is a **fragment**: it starts
 * mid-function and ends mid-expression, so a real parser sees a syntax error
 * and gives up on exactly the input this component always receives.
 *
 * So this is a deliberately small lexical tokeniser — comments, strings,
 * numbers, keywords, and the symbol the hit was found on — run over the
 * fragment. It is *approximate by design*: highlighting that is 95% right on
 * every language beats highlighting that is 100% right on one and absent on the
 * rest. Nothing depends on its output being correct; it only ever adds a
 * `<span>` around text that is rendered verbatim either way.
 */

import { useMemo } from 'react'

/**
 * Keywords worth colouring, unioned across the languages this is likely to
 * meet. A union rather than a per-language table on purpose: `class` is a
 * keyword in eight of them, and mis-colouring `def` inside a Go file is not a
 * failure mode anyone will notice, let alone be harmed by.
 */
const KEYWORDS = new Set([
  'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'def', 'default', 'defer', 'del', 'delete', 'do', 'elif',
  'else', 'enum', 'export', 'extends', 'extern', 'final', 'finally', 'fn', 'for',
  'from', 'func', 'function', 'go', 'if', 'impl', 'implements', 'import', 'in',
  'instanceof', 'interface', 'lambda', 'let', 'match', 'mod', 'module', 'mut',
  'new', 'not', 'package', 'pass', 'private', 'protected', 'pub', 'public',
  'raise', 'record', 'return', 'select', 'self', 'static', 'struct', 'super',
  'switch', 'this', 'throw', 'throws', 'trait', 'try', 'type', 'typedef', 'union',
  'unsafe', 'use', 'var', 'void', 'where', 'while', 'with', 'yield',
  'true', 'false', 'null', 'nil', 'none', 'undefined',
])

type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'symbol' | 'plain'

interface Token {
  text: string
  kind: TokenKind
}

/**
 * Single pass, character by character. Order matters: comments and strings are
 * consumed whole *before* word matching, so `// return null` is one comment
 * rather than a comment marker followed by two keywords.
 */
function tokenize(source: string, symbol?: string | null): Token[] {
  const out: Token[] = []
  const n = source.length
  let i = 0
  let plainStart = 0

  const flushPlain = (upto: number) => {
    if (upto > plainStart) out.push({ text: source.slice(plainStart, upto), kind: 'plain' })
  }
  const emit = (text: string, kind: TokenKind, nextIndex: number) => {
    out.push({ text, kind })
    i = nextIndex
    plainStart = nextIndex
  }

  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]

    // Line comments: `//`, `#`, `--`. `#` is only a comment at the start of a
    // token, so `#{interp}` and a CSS colour do not swallow the rest of a line.
    const lineComment =
      (ch === '/' && next === '/') ||
      (ch === '-' && next === '-') ||
      (ch === '#' && (i === 0 || /\s/.test(source[i - 1])))
    if (lineComment) {
      flushPlain(i)
      const end = source.indexOf('\n', i)
      emit(source.slice(i, end === -1 ? n : end), 'comment', end === -1 ? n : end)
      continue
    }

    if (ch === '/' && next === '*') {
      flushPlain(i)
      const close = source.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      emit(source.slice(i, end), 'comment', end)
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      flushPlain(i)
      let k = i + 1
      while (k < n) {
        if (source[k] === '\\') k += 2
        else if (source[k] === ch) {
          k++
          break
        } else if (source[k] === '\n' && ch !== '`') {
          // An unterminated quote in a fragment is normal — stop at the line
          // end rather than painting the rest of the snippet as a string.
          break
        } else k++
      }
      emit(source.slice(i, k), 'string', k)
      continue
    }

    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(source[i - 1]))) {
      flushPlain(i)
      let k = i
      while (k < n && /[0-9a-fA-FxXoObB._]/.test(source[k])) k++
      emit(source.slice(i, k), 'number', k)
      continue
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let k = i
      while (k < n && /[A-Za-z0-9_$]/.test(source[k])) k++
      const word = source.slice(i, k)
      // The symbol the hit was recorded on is highlighted distinctly, so the
      // eye lands on *why this chunk matched* rather than on its keywords.
      const kind: TokenKind | null =
        symbol && word === symbol ? 'symbol' : KEYWORDS.has(word) ? 'keyword' : null
      if (kind) {
        flushPlain(i)
        emit(word, kind, k)
      } else {
        i = k
      }
      continue
    }

    i++
  }
  flushPlain(n)
  return out
}

export interface SnippetHighlightProps {
  code: string
  /** The matched symbol, highlighted distinctly from ordinary identifiers. */
  symbol?: string | null
  /** First line number of the snippet, for the gutter. */
  startLine?: number
  /** Lines to render before truncating. Default 12. */
  maxLines?: number
}

export function SnippetHighlight({
  code,
  symbol,
  startLine,
  maxLines = 12,
}: SnippetHighlightProps) {
  const { body, truncated } = useMemo(() => {
    const lines = code.replace(/\s+$/, '').split('\n')
    return {
      body: lines.slice(0, maxLines).join('\n'),
      truncated: lines.length > maxLines,
    }
  }, [code, maxLines])

  const lines = useMemo(() => {
    // Tokenise once over the whole body, then split per line for the gutter —
    // tokenising line-by-line would break block comments across lines.
    const tokens = tokenize(body, symbol)
    const rows: Token[][] = [[]]
    for (const token of tokens) {
      const parts = token.text.split('\n')
      parts.forEach((part, i) => {
        if (i > 0) rows.push([])
        if (part) rows[rows.length - 1].push({ text: part, kind: token.kind })
      })
    }
    return rows
  }, [body, symbol])

  return (
    <pre className="dbb-snippet" aria-label="Matched code">
      <code>
        {lines.map((tokens, i) => (
          <span className="dbb-snippet-line" key={i}>
            {typeof startLine === 'number' && startLine > 0 ? (
              <span className="dbb-snippet-ln" aria-hidden>
                {startLine + i}
              </span>
            ) : null}
            <span className="dbb-snippet-code">
              {tokens.map((t, j) =>
                t.kind === 'plain' ? (
                  t.text
                ) : (
                  <span className={`dbb-tok dbb-tok-${t.kind}`} key={j}>
                    {t.text}
                  </span>
                ),
              )}
            </span>
          </span>
        ))}
        {truncated ? <span className="dbb-snippet-more">… truncated</span> : null}
      </code>
    </pre>
  )
}
