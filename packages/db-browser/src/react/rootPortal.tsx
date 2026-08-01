/**
 * Where an overlay is portalled to, and why it is not `document.body`.
 *
 * Every rule in `styles.css` that resets a control — `button`, `input`,
 * `select`, `kbd`, `.dbb-primary`, `.dbb-icon-btn`, `.dbb-chip` — is scoped
 * under `.dbb-root`, deliberately: this library is meant to drop into somebody
 * else's application without restyling their buttons. The `--dbb-*` design
 * tokens live on the same element.
 *
 * A dialog portalled to `document.body` therefore lands **outside its own
 * stylesheet**. Everything with a class of its own still works, and every
 * control silently reverts to the browser default — which is exactly the bug
 * that shipped a cheat sheet whose `<kbd>` key caps rendered as plain text and
 * whose close button was an unstyled grey rectangle.
 *
 * So overlays portal into the `.dbb-root` element instead. `position: fixed`
 * still escapes the layout (no ancestor between here and the root establishes a
 * containing block — the motion components that do set `transform` are all
 * inside `.dbb-main`), the tokens inherit, and the descendant selectors match.
 * `document.body` remains the fallback for a consumer who renders `Dialog` on
 * its own outside a `DbBrowser`.
 */

import { createContext, useContext } from 'react'
import type { RefObject } from 'react'

const RootElementContext = createContext<RefObject<HTMLElement | null> | null>(null)

export const RootElementProvider = RootElementContext.Provider

/**
 * The node overlays should portal into: the browser's root element when there
 * is one, `document.body` otherwise. Returns `null` during SSR.
 */
export function usePortalTarget(): HTMLElement | null {
  const ref = useContext(RootElementContext)
  if (typeof document === 'undefined') return null
  return ref?.current ?? document.body
}
