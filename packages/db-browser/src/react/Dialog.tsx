/**
 * The one modal in this library. Every overlay — the binary inspector, the
 * shortcut cheat sheet, the command palette, the connection manager — is this
 * component with different children.
 *
 * ## What "focus trapping" has to mean to be worth having
 *
 * A dialog that merely *moves* focus inside itself is not trapped: Tab still
 * walks out the bottom into the page behind, and a screen-reader user then
 * reads a form they cannot see. So this does four things together, and all four
 * are required:
 *
 *  1. `role="dialog"` + `aria-modal` + a name, so assistive tech announces it
 *     and treats the rest of the page as inert.
 *  2. Focus moves in on open — to the first focusable child, or to the panel
 *     itself if there is none — and **returns to whatever was focused before**
 *     on close. Losing your place in the page is the most common modal bug.
 *  3. Tab and Shift+Tab wrap at the ends of the focusable set, recomputed on
 *     every keypress because the content changes (a connector list gains rows
 *     while a download runs).
 *  4. `Escape` closes, from anywhere inside — including from a text field,
 *     which is the one place a global shortcut layer must still let it through.
 *
 * The backdrop closes on click, but only on a click that *started* on the
 * backdrop: a drag that begins inside the panel and releases outside it is a
 * text selection, not a dismissal.
 */

import { useCallback, useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, DIALOG_MOTION, motion, useMotionOK } from './motion.js'
import { Glyph } from './iconography.js'
import { usePortalTarget } from './rootPortal.js'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export interface DialogProps {
  open: boolean
  onClose: () => void
  /** The accessible name. Rendered as the heading unless `hideTitle`. */
  title: string
  /** One line under the title. Keep it to a fact the title cannot carry. */
  subtitle?: ReactNode
  children: ReactNode
  /** Right-aligned action row. */
  footer?: ReactNode
  /** `sm` for a confirm, `md` for a form, `lg` for a two-pane manager. */
  size?: 'sm' | 'md' | 'lg'
  /** Extra class on the panel, for a surface with its own layout. */
  className?: string
  /** Suppress the visible heading (the palette is its own heading). */
  hideTitle?: boolean
  /** Skip the initial focus move — the palette focuses its own input. */
  autoFocus?: boolean
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  className,
  hideTitle,
  autoFocus = true,
}: DialogProps) {
  const panel = useRef<HTMLDivElement | null>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  const backdropDown = useRef(false)
  const titleId = useId()
  const ok = useMotionOK()
  // Inside `.dbb-root`, so the design tokens and the scoped control resets
  // reach the dialog. See `rootPortal.tsx` for why `document.body` is wrong.
  const portalTarget = usePortalTarget()

  // Remember where focus was, and put it back. Runs on open/close rather than
  // on mount, because the dialog stays mounted across an `open` flip.
  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement as HTMLElement | null
    if (autoFocus) {
      // One frame later: the panel is in the DOM but children may still be
      // settling, and focusing a node that is about to be replaced loses it.
      const id = requestAnimationFrame(() => {
        const el = panel.current
        if (!el) return
        const first = el.querySelector<HTMLElement>(FOCUSABLE)
        ;(first ?? el).focus()
      })
      return () => cancelAnimationFrame(id)
    }
    return undefined
  }, [open, autoFocus])

  useEffect(() => {
    if (open) return
    const back = restoreTo.current
    restoreTo.current = null
    // Only restore if focus is still nowhere useful — never steal it from
    // something the close handler deliberately focused.
    if (back && document.activeElement === document.body) back.focus?.()
  }, [open])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const el = panel.current
      if (!el) return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (n) => n.offsetParent !== null || n === document.activeElement,
      )
      if (!items.length) {
        e.preventDefault()
        el.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    },
    [onClose],
  )

  if (!portalTarget) return null

  const body = (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="dbb-modal-backdrop"
          {...(ok ? DIALOG_MOTION.backdrop : {})}
          onMouseDown={(e) => {
            backdropDown.current = e.target === e.currentTarget
          }}
          onMouseUp={(e) => {
            if (backdropDown.current && e.target === e.currentTarget) onClose()
            backdropDown.current = false
          }}
        >
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={`dbb-modal dbb-modal-${size} ${className ?? ''}`}
            onKeyDown={onKeyDown}
            {...(ok ? DIALOG_MOTION.panel : {})}
          >
            <header className={hideTitle ? 'dbb-modal-head dbb-sr-head' : 'dbb-modal-head'}>
              <div className="dbb-modal-titles">
                <h2 id={titleId} className="dbb-modal-title">
                  {title}
                </h2>
                {subtitle ? <p className="dbb-modal-sub">{subtitle}</p> : null}
              </div>
              <button
                type="button"
                className="dbb-icon-btn"
                onClick={onClose}
                aria-label={`Close ${title}`}
                title="Close · Esc"
              >
                <Glyph name="close" size="md" />
              </button>
            </header>
            <div className="dbb-modal-body">{children}</div>
            {footer ? <footer className="dbb-modal-actions">{footer}</footer> : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )

  return createPortal(body, portalTarget)
}
