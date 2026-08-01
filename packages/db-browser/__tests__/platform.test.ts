/**
 * Modifier names, per platform.
 *
 * These strings appear in every tooltip, the `?` cheat sheet and the command
 * palette. Getting them wrong is not a style slip: `⌘` on a Windows keyboard
 * names a key that does not exist, so the hint is a false instruction and the
 * user concludes the shortcut is broken. The reported bug was exactly that —
 * Mac glyphs rendered on Windows.
 *
 * The user-agent strings below are the real ones these APIs emit, so the suite
 * checks every platform rather than only whichever machine it happens to run on
 * — which is how this class of bug survives review.
 */

import { describe, expect, it } from 'vitest'
import { detectPlatform, formatKeys, keyToken, splitKeys } from '../src/react/platform.js'

const WINDOWS = {
  userAgentData: { platform: 'Windows' },
  platform: 'Win32',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}
const MAC = {
  userAgentData: { platform: 'macOS' },
  platform: 'MacIntel',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}
const LINUX = {
  userAgentData: { platform: 'Linux' },
  platform: 'Linux x86_64',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}
/** Safari and Firefox have no `userAgentData`; `platform` is the fallback. */
const SAFARI = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' }
const FIREFOX_WINDOWS = { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0' }
/** iPadOS reports "MacIntel" from `platform` but "iPad" in the UA. Either way: mac. */
const IPAD = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/604.1' }

describe('detectPlatform', () => {
  it('prefers `navigator.userAgentData.platform` — the supported, non-deprecated API', () => {
    expect(detectPlatform(WINDOWS)).toBe('windows')
    expect(detectPlatform(MAC)).toBe('mac')
    expect(detectPlatform(LINUX)).toBe('linux')
  })

  it('falls back to `navigator.platform` where `userAgentData` does not exist', () => {
    expect(detectPlatform(SAFARI)).toBe('mac')
    expect(detectPlatform(FIREFOX_WINDOWS)).toBe('windows')
    expect(detectPlatform(IPAD)).toBe('mac')
  })

  it('is total: no navigator, or one it cannot read, is `other` — never mac', () => {
    expect(detectPlatform(null)).toBe('other')
    expect(detectPlatform(undefined)).toBe('other')
    expect(detectPlatform({})).toBe('other')
    // The safe default matters: `other` spells its modifiers in words, so an
    // unknown environment can never be told about a key it may not have.
    expect(keyToken('mod', detectPlatform({}))).toBe('Ctrl')
  })
})

describe('modifier names', () => {
  it('spells Windows and Linux modifiers as words', () => {
    for (const platform of ['windows', 'linux'] as const) {
      expect(keyToken('mod', platform)).toBe('Ctrl')
      expect(keyToken('alt', platform)).toBe('Alt')
      expect(keyToken('shift', platform)).toBe('Shift')
    }
  })

  it('uses the Mac glyphs only on macOS, where they are engraved on the keys', () => {
    expect(keyToken('mod', 'mac')).toBe('⌘')
    expect(keyToken('alt', 'mac')).toBe('⌥')
    expect(keyToken('shift', 'mac')).toBe('⇧')
    expect(keyToken('ctrl', 'mac')).toBe('⌃')
  })

  it('never emits a Mac glyph on any non-Mac platform', () => {
    const glyphs = /[⌘⌥⇧⌃]/
    for (const platform of ['windows', 'linux', 'other'] as const) {
      for (const keys of ['mod+k', 'mod+shift+s', 'shift+alt+f', 'mod+enter', 'alt+c', 'escape', '?']) {
        expect(formatKeys(keys, platform)).not.toMatch(glyphs)
      }
    }
  })

  it('names the non-command modifier after the key, not after the DOM spec', () => {
    // An earlier revision printed "Meta" here, which is engraved on no keyboard.
    expect(keyToken('ctrl', 'windows')).toBe('Win')
    expect(keyToken('ctrl', 'linux')).toBe('Super')
  })
})

describe('formatKeys / splitKeys', () => {
  it('renders the app’s real bindings the way each platform writes them', () => {
    expect(formatKeys('mod+k', 'windows')).toBe('Ctrl+K')
    expect(formatKeys('mod+enter', 'windows')).toBe('Ctrl+Enter')
    expect(formatKeys('shift+alt+f', 'windows')).toBe('Shift+Alt+F')
    expect(formatKeys('mod+shift+s', 'linux')).toBe('Ctrl+Shift+S')
    expect(formatKeys('mod+k', 'mac')).toBe('⌘K')
    expect(formatKeys('mod+enter', 'mac')).toBe('⌘Return')
  })

  it('spells out keys whose symbol means different things on different keyboards', () => {
    // "Enter" on a PC, "Return" on a Mac — `↵` is a line-break symbol and names
    // neither key.
    expect(formatKeys('enter', 'windows')).toBe('Enter')
    expect(formatKeys('enter', 'mac')).toBe('Return')
    expect(formatKeys('escape', 'windows')).toBe('Esc')
  })

  it('keeps the arrows, which every keyboard in the world is engraved with', () => {
    expect(formatKeys('arrowleft', 'windows')).toBe('←')
    expect(formatKeys('arrowdown', 'mac')).toBe('↓')
  })

  it('splits on the canonical binding, so macOS still gets one chip per key', () => {
    expect(splitKeys('mod+shift+s', 'windows')).toEqual(['Ctrl', 'Shift', 'S'])
    // The old implementation split the *rendered* label on '+', which produced
    // a single run-on chip on macOS because macOS writes chords solid.
    expect(splitKeys('mod+shift+s', 'mac')).toEqual(['⌘', '⇧', 'S'])
  })

  it('handles the single-key bindings the app registers', () => {
    expect(formatKeys('/', 'windows')).toBe('/')
    expect(formatKeys('?', 'windows')).toBe('?')
    expect(formatKeys('f5', 'windows')).toBe('F5')
    expect(formatKeys(']', 'windows')).toBe(']')
  })
})
