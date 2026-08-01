/**
 * The icon system: **one glyph and one hue per concept, declared in one place.**
 *
 * ## Why a registry rather than colours at the call site
 *
 * Colour in this UI is *information*, not decoration. A user scanning a table
 * list, a column header and a search result must be able to tell "this is a
 * key", "this is a type", "this is code" apart without reading the label — and
 * that only works if the same concept is the same colour on every surface. The
 * moment a component writes `className="text-emerald-600"` inline, the next
 * component writes a slightly different green and the channel stops carrying
 * meaning.
 *
 * So every icon in the browser goes through {@link Glyph}, which resolves a
 * **concept name** to a `(lucide icon, tone)` pair from {@link ICONS} below.
 * A tone is a CSS custom property (`--dbb-ic-<tone>`), defined once in
 * `styles.css` for light and dark, so a consumer restyles the whole palette by
 * setting six variables rather than hunting through JSX.
 *
 * ## The palette, and what each hue means
 *
 * | tone | hue | meaning |
 * | :-- | :-- | :-- |
 * | `data` | emerald | rows and the things that hold them — tables, the grid, code chunks |
 * | `derived` | cyan | something computed from data rather than stored — views, estimates, scores |
 * | `key` | amber | identity and linkage — primary keys, foreign keys, commits, docs |
 * | `type` | violet | a *type* or a vector — the shape of a value rather than the value |
 * | `find` | blue | search, filter, sort — narrowing what you are looking at |
 * | `graph` | sky | the code-graph mode: nodes, edges, communities |
 * | `run` | accent | execute — run a query, submit a search. The one brand-coloured tone |
 * | `build` | orange | a long, rewriting job — rebuild, install, download |
 * | `danger` | red | writes, DDL, delete, failure |
 * | `safe` | teal | read-only, success, "this cannot hurt you" |
 * | `link` | indigo | connections and connectors — reaching another system |
 * | `mute` | slate | structural chrome that must not compete: columns, chevrons, counts |
 *
 * Twelve tones is the ceiling on purpose: past about a dozen the eye stops
 * treating hue as a category and starts treating it as texture.
 *
 * ## Sizing
 *
 * Three sizes, matched to the three text sizes the chrome uses. Icons that sit
 * inline with a label must share its optical line, so `sm` (13px) pairs with
 * 12px labels, `md` (15px) with 13–14px body text and `lg` (18px) with the
 * stat headings. Anything else is a bug, not a choice.
 */

import {
  Activity,
  AlertTriangle,
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  Binary,
  Blocks,
  Bookmark,
  Boxes,
  Braces,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Clock,
  Copy,
  Database,
  Download,
  Eye,
  File,
  FileCode2,
  FileText,
  Filter,
  FolderTree,
  GitCommitHorizontal,
  Grid3x3,
  Hash,
  History,
  Info,
  Keyboard,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  Lock,
  LockOpen,
  Network,
  Package,
  PackageCheck,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Server,
  Settings2,
  ShieldAlert,
  Sparkles,
  SquareChevronRight,
  SquareStack,
  Table2,
  Terminal,
  Trash2,
  Type,
  Unplug,
  Waypoints,
  X,
  Zap,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CSSProperties } from 'react'

/** The twelve semantic hues. See the table in this file's header. */
export type IconTone =
  | 'data'
  | 'derived'
  | 'key'
  | 'type'
  | 'find'
  | 'graph'
  | 'run'
  | 'build'
  | 'danger'
  | 'safe'
  | 'link'
  | 'mute'

export type IconSize = 'sm' | 'md' | 'lg'

/** Pixel sizes, paired to the chrome's three text sizes. */
export const ICON_PX: Readonly<Record<IconSize, number>> = { sm: 13, md: 15, lg: 18 }

/**
 * Every concept this UI has an icon for, with the glyph and the hue it always
 * uses. Adding a row here is how a new icon enters the product; there is no
 * other sanctioned way to render one.
 */
export const ICONS = {
  // --- relational data -----------------------------------------------------
  table: { icon: Table2, tone: 'data' },
  view: { icon: Eye, tone: 'derived' },
  virtual: { icon: SquareStack, tone: 'derived' },
  grid: { icon: Grid3x3, tone: 'data' },
  rows: { icon: Rows3, tone: 'data' },
  database: { icon: Database, tone: 'data' },
  schema: { icon: FolderTree, tone: 'mute' },

  // --- identity ------------------------------------------------------------
  primaryKey: { icon: KeyRound, tone: 'key' },
  foreignKey: { icon: Link2, tone: 'key' },
  commit: { icon: GitCommitHorizontal, tone: 'key' },

  // --- types ---------------------------------------------------------------
  type: { icon: Type, tone: 'type' },
  typeNumber: { icon: Hash, tone: 'type' },
  typeDate: { icon: Calendar, tone: 'type' },
  typeTime: { icon: Clock, tone: 'type' },
  typeJson: { icon: Braces, tone: 'type' },
  typeBinary: { icon: Binary, tone: 'type' },
  typeVector: { icon: Layers, tone: 'type' },
  typeBoolean: { icon: Activity, tone: 'type' },

  // --- finding things ------------------------------------------------------
  search: { icon: Search, tone: 'find' },
  semanticSearch: { icon: Sparkles, tone: 'type' },
  filter: { icon: Filter, tone: 'find' },
  sortAsc: { icon: ArrowUpNarrowWide, tone: 'find' },
  sortDesc: { icon: ArrowDownNarrowWide, tone: 'find' },
  pathFilter: { icon: FolderTree, tone: 'find' },

  // --- retrieval results ---------------------------------------------------
  chunk: { icon: FileCode2, tone: 'data' },
  doc: { icon: FileText, tone: 'key' },
  fileChunk: { icon: File, tone: 'derived' },
  score: { icon: Activity, tone: 'derived' },

  // --- code graph ----------------------------------------------------------
  graph: { icon: Network, tone: 'graph' },
  node: { icon: Boxes, tone: 'graph' },
  edge: { icon: Waypoints, tone: 'graph' },
  community: { icon: Blocks, tone: 'graph' },

  // --- actions -------------------------------------------------------------
  run: { icon: Play, tone: 'run' },
  format: { icon: Zap, tone: 'find' },
  sql: { icon: Terminal, tone: 'mute' },
  refresh: { icon: RefreshCw, tone: 'find' },
  rebuild: { icon: RefreshCw, tone: 'build' },
  install: { icon: Download, tone: 'build' },
  add: { icon: Plus, tone: 'run' },
  edit: { icon: Pencil, tone: 'find' },
  remove: { icon: Trash2, tone: 'danger' },
  copy: { icon: Copy, tone: 'mute' },
  save: { icon: Bookmark, tone: 'find' },
  history: { icon: History, tone: 'mute' },
  settings: { icon: Settings2, tone: 'mute' },

  // --- posture / state -----------------------------------------------------
  readOnly: { icon: Lock, tone: 'safe' },
  writable: { icon: LockOpen, tone: 'danger' },
  danger: { icon: ShieldAlert, tone: 'danger' },
  success: { icon: Check, tone: 'safe' },
  failure: { icon: AlertTriangle, tone: 'danger' },
  unavailable: { icon: CircleSlash, tone: 'mute' },
  info: { icon: Info, tone: 'find' },
  busy: { icon: Loader2, tone: 'build' },

  // --- connections ---------------------------------------------------------
  connection: { icon: Plug, tone: 'link' },
  connectionOff: { icon: Unplug, tone: 'mute' },
  connector: { icon: Package, tone: 'link' },
  connectorInstalled: { icon: PackageCheck, tone: 'safe' },
  server: { icon: Server, tone: 'link' },

  // --- chrome --------------------------------------------------------------
  prev: { icon: ChevronLeft, tone: 'mute' },
  next: { icon: ChevronRight, tone: 'mute' },
  expand: { icon: ChevronDown, tone: 'mute' },
  close: { icon: X, tone: 'mute' },
  // `SquareChevronRight` (a prompt), not lucide's `Command` — that glyph *is*
  // the Mac ⌘ key, so on a Windows or Linux machine it labels the button with a
  // key the keyboard does not have. A prompt caret means "type a command"
  // everywhere. See `platform.ts` for the general rule.
  palette: { icon: SquareChevronRight, tone: 'mute' },
  keyboard: { icon: Keyboard, tone: 'mute' },
} as const satisfies Record<string, { icon: LucideIcon; tone: IconTone }>

export type IconName = keyof typeof ICONS

export interface GlyphProps {
  name: IconName
  size?: IconSize
  /** Override the registered tone. Use sparingly — see this file's header. */
  tone?: IconTone
  className?: string
  style?: CSSProperties
  /** Spin the glyph (pair with `busy`). Honoured by `prefers-reduced-motion`. */
  spin?: boolean
  /**
   * Icons are decorative by default: they sit next to a label that already says
   * what they mean. Pass a title only for an icon that is the *only* content of
   * a control, and prefer an `aria-label` on the control itself.
   */
  title?: string
}

/**
 * Render one concept's icon in its own hue.
 *
 * `aria-hidden` is the default because in this UI an icon always accompanies a
 * text label or a labelled control — announcing it again is noise for a screen
 * reader. Icon-only buttons carry their name on the *button*, not here.
 */
export function Glyph({ name, size = 'md', tone, className, style, spin, title }: GlyphProps) {
  const entry = ICONS[name]
  const Icon = entry.icon as LucideIcon
  const hue: IconTone = tone ?? (entry.tone as IconTone)
  const classes = ['dbb-ic', `dbb-ic-${hue}`]
  if (spin) classes.push('dbb-spin')
  if (className) classes.push(className)
  return (
    <Icon
      size={ICON_PX[size]}
      className={classes.join(' ')}
      strokeWidth={1.9}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={style}
    />
  )
}

/**
 * Which type glyph a column's normalized type gets.
 *
 * Driven by `NormalizedType` — the engine-agnostic vocabulary — rather than by
 * a raw SQL type name, so `int8`, `bigint`, `INTEGER` and `NUMBER(19)` all land
 * on the same glyph without this file knowing any of those spellings.
 */
export function typeIconFor(normalized: string | undefined): IconName {
  switch (normalized) {
    case 'integer':
    case 'decimal':
      return 'typeNumber'
    case 'boolean':
      return 'typeBoolean'
    case 'date':
      return 'typeDate'
    case 'time':
    case 'timestamp':
      return 'typeTime'
    case 'json':
      return 'typeJson'
    case 'binary':
      return 'typeBinary'
    case 'vector':
      return 'typeVector'
    default:
      return 'type'
  }
}

/** Which glyph a table-list entry gets, from its `TableMeta.kind`. */
export function tableIconFor(kind: string | undefined): IconName {
  switch (kind) {
    case 'view':
    case 'matview':
      return 'view'
    case 'virtual':
      return 'virtual'
    case 'foreign':
      return 'server'
    default:
      return 'table'
  }
}
