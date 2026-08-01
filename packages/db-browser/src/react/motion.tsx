/**
 * Motion primitives.
 *
 * ## Three rules everything here obeys
 *
 * 1. **`prefers-reduced-motion` is an explicit branch, not a CSS afterthought.**
 *    `styles.css` does also zero out transitions, but a CSS rule cannot stop
 *    `framer-motion` from driving a transform on every frame — it only stops
 *    the *declarative* ones. So each component below asks {@link useMotionOK}
 *    and, when the answer is no, renders a plain element with no motion
 *    component at all. Nothing animates, nothing is scheduled, and the
 *    scroll-linked pieces do not subscribe to scroll.
 * 2. **Motion never gates interaction.** Only `opacity` and `transform` are
 *    animated — never `height` on something you might click, never
 *    `pointerEvents`, and never an `exit` that has to finish before the next
 *    view mounts. A result card is clickable on the first frame it exists.
 * 3. **Stagger is capped.** A 50-row list staggered at 25ms would take 1.2s to
 *    finish appearing, which reads as jank, not polish. {@link staggerDelay}
 *    clamps the ramp so the last item is never more than ~180ms behind the
 *    first, however long the list is.
 *
 * `framer-motion` is a dependency of `@jugaaadi/table`, this package's peer, so
 * in any app that can render the grid it is already installed and already paid
 * for — exactly the argument that makes `lucide-react` free here. It is left
 * **external** in the library build for the same reason.
 */

import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import type { MotionStyle, Transition } from 'framer-motion'
import { useMemo } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'

/**
 * The one easing curve, matching `--dbb-ease` in `styles.css` so a CSS
 * transition and a JS-driven one on the same element cannot disagree.
 * Never `linear` — a linear fade reads as a slideshow, not as an interface.
 */
export const EASE = [0.2, 0, 0.13, 1] as const

/** Durations, in seconds. Short enough that nothing ever feels queued. */
export const DUR = {
  /** A state flip: a chip turning on, a badge changing. */
  quick: 0.12,
  /** The default: a card, a row, a panel arriving. */
  base: 0.22,
  /** A dialog or a whole-pane change, which travels further. */
  panel: 0.28,
} as const

export const TRANSITION: Transition = { duration: DUR.base, ease: EASE }

/**
 * Should anything move?
 *
 * `framer-motion`'s hook returns `null` before the media query is read, which
 * must be treated as "no preference" rather than "reduce" — otherwise the first
 * paint of every session is unanimated and then snaps on.
 */
export function useMotionOK(): boolean {
  return useReducedMotion() !== true
}

/**
 * Stagger ramp for item `index`, in seconds.
 *
 * Linear at first so a short list has a legible cascade, then compressed so a
 * long one still finishes promptly. The ceiling is deliberate: past ~180ms the
 * cascade stops reading as one gesture and starts reading as a slow list.
 */
export function staggerDelay(index: number, step = 0.028, cap = 0.18): number {
  if (index <= 0) return 0
  return Math.min(index * step, cap)
}

export interface AppearProps {
  children: ReactNode
  /** Position in a list, for the stagger ramp. Omit for a lone element. */
  index?: number
  /** Extra delay before the ramp, e.g. to let a parent land first. */
  delay?: number
  /** How far it rises. 0 for a pure fade (dialogs scale instead). */
  y?: number
  /** Animate only once it scrolls into view — for long result lists. */
  whenVisible?: boolean
  className?: string
  style?: CSSProperties
  as?: 'div' | 'li' | 'section' | 'header' | 'tr'
}

/**
 * The workhorse: fade + a short rise, staggered by `index`.
 *
 * Under reduced motion this renders the bare element — no motion component is
 * mounted, so there is no animation *and* no per-frame subscription.
 */
export function Appear({
  children,
  index = 0,
  delay = 0,
  y = 6,
  whenVisible = false,
  className,
  style,
  as = 'div',
}: AppearProps) {
  const ok = useMotionOK()
  const Tag = as
  if (!ok) {
    return (
      <Tag className={className} style={style}>
        {children}
      </Tag>
    )
  }
  const Motion = motion[as]
  const transition: Transition = {
    duration: DUR.base,
    ease: EASE,
    delay: delay + staggerDelay(index),
  }
  const common = {
    className,
    style: style as MotionStyle,
    initial: { opacity: 0, y },
    transition,
  }
  return whenVisible ? (
    <Motion {...common} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.15 }}>
      {children}
    </Motion>
  ) : (
    <Motion {...common} animate={{ opacity: 1, y: 0 }}>
      {children}
    </Motion>
  )
}

/**
 * A whole pane arriving after a mode / table switch.
 *
 * Keyed rather than wrapped in `AnimatePresence`: the outgoing pane is gone the
 * instant the new one mounts, so nothing waits on an exit animation. The change
 * is still legible — the new pane fades up from slightly below — but the first
 * interactive frame is immediate.
 */
export function PaneTransition({
  paneKey,
  children,
  className,
}: {
  paneKey: string
  children: ReactNode
  className?: string
}) {
  const ok = useMotionOK()
  if (!ok) return <div className={className}>{children}</div>
  return (
    <motion.div
      key={paneKey}
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DUR.panel, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/**
 * Scroll-linked condensing.
 *
 * The vector view's stats strip is the reason this exists: it is genuinely
 * useful at the top of the page (an index built three weeks ago changes what
 * every result below means) and pure noise once you are reading result number
 * twelve. So it shrinks and fades as its scroll container moves, and comes back
 * when you scroll up — no button, no state to remember.
 *
 * The values are derived from `scrollY` directly rather than from a scroll
 * *event handler*, so nothing re-renders React on scroll.
 */
export function useCondense(
  container: RefObject<HTMLElement | null>,
  /** Pixels of scroll over which the collapse completes. */
  distance = 120,
): MotionStyle | undefined {
  const ok = useMotionOK()
  const { scrollY } = useScroll({ container })
  const opacity = useTransform(scrollY, [0, distance], [1, 0.55])
  const scale = useTransform(scrollY, [0, distance], [1, 0.965])
  const y = useTransform(scrollY, [0, distance], [0, -6])
  return useMemo(
    () => (ok ? ({ opacity, scale, y, transformOrigin: 'top left' } as MotionStyle) : undefined),
    [ok, opacity, scale, y],
  )
}

/** A `motion.div` you can hand a {@link useCondense} style to. */
export const CondenseBox = motion.div

/**
 * A dialog's own entrance: scale from 98% with a fade, and a separate fade for
 * the backdrop. Exported as variants rather than a component because the modal
 * also needs to own focus trapping and portalling.
 */
export const DIALOG_MOTION = {
  backdrop: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: DUR.quick, ease: EASE },
  },
  panel: {
    initial: { opacity: 0, scale: 0.98, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.985, y: 4 },
    transition: { duration: DUR.panel, ease: EASE },
  },
} as const

export { motion, AnimatePresence } from 'framer-motion'
