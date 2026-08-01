/**
 * Which platform is this, and what are its modifier keys called?
 *
 * ## Why this is a module and not four `if (isMac)` expressions
 *
 * A modifier glyph is not decoration: it is an instruction. `⌘` on a Windows
 * keyboard names a key that is not there, so the hint is not merely
 * off-brand — it is **wrong**, and a user who cannot find the key concludes the
 * shortcut does not work. The failure is silent and it is per-call-site, so the
 * only durable fix is that no call site is allowed to spell a modifier at all.
 *
 * Everything that renders a key name — the shortcut registry, the `?` cheat
 * sheet, the command palette, every tooltip built by `hint()` — resolves it
 * through {@link formatKeys} / {@link splitKeys} here. Detection happens
 * **once**, in {@link PLATFORM}.
 *
 * ## Detection order, and why `navigator.platform` is the fallback and not the
 * source
 *
 * `navigator.userAgentData.platform` ("Windows", "macOS", "Linux") is the
 * supported API and the only one that is not deprecated. It is Chromium-only,
 * so `navigator.platform` ("Win32", "MacIntel", "Linux x86_64") backs it up, and
 * the user-agent string backs *that* up for the iPad case where `platform`
 * reports "MacIntel". Every step is a string match on a value that may be
 * absent, so the function is total: an unknown environment is `'other'`, which
 * spells its modifiers in words — the safe answer, never Mac glyphs.
 *
 * ## Words beat symbols unless the symbol is the platform's own name for the key
 *
 * macOS keyboards are engraved `⌘ ⌥ ⇧ ⌃`, so on macOS those glyphs *are* the
 * plain words. Everywhere else the keys are engraved "Ctrl", "Alt", "Shift" and
 * that is what we print. Symbols that are ambiguous across platforms — `↵` for
 * a key labelled "Enter" on one keyboard and "Return" on another — are spelled
 * out on every platform. Arrows are the exception: `←↑→↓` are engraved on every
 * keyboard in the world.
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'other'

/** The (very small) part of `navigator` this module reads. */
export interface PlatformNavigator {
  platform?: string
  userAgent?: string
  userAgentData?: { platform?: string } | null
}

/**
 * Resolve a platform from a navigator-shaped object.
 *
 * Exported and pure so it can be tested against every string these APIs
 * actually produce, rather than only against whatever machine the suite runs
 * on — which is the reason a bug like "Mac glyphs on Windows" survives review.
 */
export function detectPlatform(nav?: PlatformNavigator | null): Platform {
  if (!nav) return 'other'
  const hints = [nav.userAgentData?.platform, nav.platform, nav.userAgent]
  for (const hint of hints) {
    if (!hint) continue
    const value = hint.toLowerCase()
    // Order matters: a macOS user agent contains "mac os x", and an iPadOS one
    // contains both "macintel" (from `platform`) and "ipad" (from the UA).
    if (value.includes('mac') || value.includes('iphone') || value.includes('ipad') || value.includes('darwin')) {
      return 'mac'
    }
    if (value.includes('win')) return 'windows'
    if (value.includes('linux') || value.includes('android') || value.includes('cros')) return 'linux'
  }
  return 'other'
}

/** Detected once, at module evaluation. Everything else reads this. */
export const PLATFORM: Platform = detectPlatform(
  typeof navigator === 'undefined' ? null : (navigator as PlatformNavigator),
)

/** True only on Apple platforms. The one place this question is answered. */
export const IS_MAC = PLATFORM === 'mac'

/**
 * The name each modifier token gets, per platform.
 *
 * `mod` is "the command modifier" — ⌘ on macOS, Ctrl elsewhere — and `ctrl` is
 * the *other* one, which is Control on macOS and the Windows/Super key
 * elsewhere. Naming that key "Meta" (as an earlier revision did) is a browser
 * spec term, not something engraved on any keyboard.
 */
const MODIFIERS: Record<Platform, Record<string, string>> = {
  mac: { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' },
  windows: { mod: 'Ctrl', ctrl: 'Win', alt: 'Alt', shift: 'Shift' },
  linux: { mod: 'Ctrl', ctrl: 'Super', alt: 'Alt', shift: 'Shift' },
  other: { mod: 'Ctrl', ctrl: 'Meta', alt: 'Alt', shift: 'Shift' },
}

/**
 * Non-modifier keys whose name is not simply the token upper-cased.
 *
 * Arrows keep their glyphs — they are engraved on every keyboard. Enter does
 * not: the key says "Enter" on a PC and "Return" on a Mac, and `↵` is a symbol
 * for a line break rather than for either key.
 */
const KEYS: Record<string, string> = {
  escape: 'Esc',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
}

/** One token (`mod`, `shift`, `enter`, `k`, `f5`) as this platform names it. */
export function keyToken(token: string, platform: Platform = PLATFORM): string {
  const modifier = MODIFIERS[platform][token]
  if (modifier) return modifier
  if (token === 'enter') return platform === 'mac' ? 'Return' : 'Enter'
  const named = KEYS[token]
  if (named) return named
  return token.length === 1 ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1)
}

/**
 * A canonical binding as a list of per-key chips: `mod+enter` →
 * `['Ctrl', 'Enter']` on Windows, `['⌘', 'Return']` on macOS.
 *
 * Splitting happens on the **canonical** string, before any label is applied,
 * so a label that itself contains a `+` can never be split in half.
 */
export function splitKeys(keys: string, platform: Platform = PLATFORM): string[] {
  return keys.split('+').map((token) => keyToken(token, platform))
}

/**
 * A binding as one string: `⌘K` on macOS (where chords are written solid) and
 * `Ctrl+K` everywhere else (where they are written with separators).
 */
export function formatKeys(keys: string, platform: Platform = PLATFORM): string {
  const parts = splitKeys(keys, platform)
  return platform === 'mac' ? parts.join('') : parts.join('+')
}
