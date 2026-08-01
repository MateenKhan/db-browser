/**
 * The connection-manager wire contract.
 *
 * These types restate the API this UI is built against, verbatim. They live in
 * the React tree rather than in `core/` because the server that implements them
 * is owned elsewhere: this package consumes the contract, it does not define
 * it, and a change on the server should show up here as a type error rather
 * than as a silently empty panel.
 *
 * ## The one idea worth understanding
 *
 * **The UI never knows what a Postgres connection looks like.** It knows how to
 * render a `ConnectionField`. Everything engine-specific — that Postgres wants
 * a host, a port and an SSL mode while SQLite wants a file path and a read-only
 * flag — arrives as `ConnectorDescriptor.connectionFields` and is rendered
 * generically. That is the whole point of the metadata design, and the moment a
 * component writes `if (connectorId === 'postgres')` the design is gone: adding
 * an engine becomes a UI change again.
 *
 * ## Secrets
 *
 * A field marked `secret` is **write-only**. The server never returns its
 * value; it returns whether one is set. The form therefore shows `••••••` and
 * "set" / "not set", the input starts empty, and an empty secret input on save
 * means "leave it alone" — not "clear it". Clearing is its own explicit action.
 * A secret never enters a URL, a query string or a log line, and it lives in
 * component state only between the keystroke and the submit.
 */

export type ConnectionFieldKind = 'text' | 'number' | 'password' | 'file' | 'boolean' | 'select'

export interface ConnectionFieldOption {
  value: string
  label: string
}

export interface ConnectionField {
  key: string
  label: string
  kind: ConnectionFieldKind
  required: boolean
  placeholder?: string
  default?: string | number | boolean
  options?: ConnectionFieldOption[]
  /** Write-only. Never populated on read; see this file's header. */
  secret?: boolean
  /** The server's own guidance for this field. Rendered under the input. */
  help?: string
}

export interface ConnectorCapabilities {
  schemas: boolean
  transactions: boolean
  keysetPagination: boolean
  implicitRowId: boolean
  readOnlySession: boolean
  multipleDatabases: boolean
}

export interface ConnectorDescriptor {
  id: string
  label: string
  /** One line about the engine, shown under its name in the driver list. */
  description?: string
  driverPackage: string | null
  driverRange: string
  dialect: string
  defaultPort?: number
  /** Render the connection form from this. Never branch on `id`. */
  connectionFields: ConnectionField[]
  capabilities: ConnectorCapabilities
  typeMap: Record<string, string>
}

export interface ConnectorStatus {
  descriptor: ConnectorDescriptor
  installed: boolean
  installedVersion?: string
  /** Why this connector cannot be used, if it cannot. */
  error?: string
  /**
   * False when this build has **no adapter** for the engine — the driver could
   * be downloaded and the connection still could not be opened. This is the
   * only condition that makes an engine genuinely unselectable; "not installed"
   * does not, because that is a download away. Absent means "no opinion", which
   * is read as `true`: an older server must not have every engine greyed out.
   */
  supported?: boolean
  /** True when the installed version is outside `driverRange`. */
  versionMismatch?: boolean
  /** The exact shell command that would install the driver, if there is one. */
  installCommand?: string
}

/**
 * Can a connection be made with this engine, and if not, why not?
 *
 * One function, because "is this engine usable" is asked in four places — the
 * driver list, the engine picker, the form's gate and the palette — and four
 * copies of the rule is how a picker ends up offering an engine the server
 * cannot open. It distinguishes the three states that matter:
 *
 *  - **`ready`** — installed and supported; go.
 *  - **`installable`** — supported, driver missing, and there is something to
 *    download. Selectable, with the download offered inline.
 *  - **`unavailable`** — nothing the user can do from here. Not selectable, and
 *    it says why in the server's own words.
 */
export type ConnectorAvailability = 'ready' | 'installable' | 'unavailable'

export function connectorAvailability(status: ConnectorStatus): {
  state: ConnectorAvailability
  reason?: string
} {
  const { descriptor, installed, supported, error } = status
  if (supported === false) {
    // Deliberately *not* the server's `error` here. When an engine is both
    // uninstalled and unsupported the server fills `error` with the install
    // command — true, but the most misleading sentence available, because
    // running it would not make the engine connectable. The reason a user needs
    // is the adapter, not the driver.
    return {
      state: 'unavailable',
      reason: `This build has no ${descriptor.label} adapter yet, so a connection cannot be opened even once the driver is installed.`,
    }
  }
  if (installed) return { state: 'ready' }
  if (descriptor.driverPackage) return { state: 'installable' }
  return {
    state: 'unavailable',
    reason: error ?? `${descriptor.label} needs no driver, but the server does not report it as installed.`,
  }
}

/** The non-secret half of a saved connection. */
export type ConnectionValues = Record<string, string | number | boolean>

/**
 * A saved connection, as the server returns it.
 *
 * `secretsSet` is the whole of what the API says about secrets: the **keys**
 * that currently hold a value, never a value. That is what the "set" / "not
 * set" markers in the form are rendered from, and it is why this UI is
 * structurally incapable of displaying a password — there is nothing to
 * display.
 */
export interface StoredConnection {
  id: string
  name: string
  /** The connector this connection uses — matches `ConnectorDescriptor.id`. */
  engine: string
  /** Every non-secret field's value. Secrets are absent by construction. */
  values: ConnectionValues
  /** Keys of the secret fields that currently hold a value. */
  secretsSet?: string[]
  /** The server's own read-only posture for this connection. */
  readOnly?: boolean
  createdAt?: string
  updatedAt?: string
}

/**
 * What the form submits.
 *
 * Secrets ride **inside `values`**, under their own field key, exactly like
 * every other field — because to the server a secret is just a field whose
 * descriptor says `secret: true`, and inventing a second envelope for them
 * here would be a shape only this client knows about. The rules the server
 * applies, which the form is built to produce:
 *
 *  - a secret key **absent** from `values` means "leave the stored one alone";
 *  - a secret key present as `''` or `null` means "clear it";
 *  - anything else replaces it.
 */
export interface ConnectionDraft {
  id?: string
  name: string
  engine: string
  /** `null` is meaningful here and only here: it clears a stored secret. */
  values: Record<string, string | number | boolean | null>
  /** Explicit read-only posture. Omitted, the server infers it from `values`. */
  readOnly?: boolean
}

/**
 * The outcome of opening a connection and closing it again.
 *
 * Two fields are accepted under two names each, because the contract this UI
 * was specified against and the server that implements it spell them
 * differently and both are in the wild: `latencyMs`/`durationMs` and
 * `error`/`message`. {@link describeTest} is the single place that resolves
 * them, so no component has to know.
 */
export interface TestResult {
  ok: boolean
  error?: string
  /** The server's own sentence, on success or failure. Richer than `error`. */
  message?: string
  latencyMs?: number
  durationMs?: number
  /** A machine-readable failure code, when the server has one. */
  code?: string
  /** How many tables the probe could see. Proof it really opened. */
  tableCount?: number
}

/** One line of prose for a test result, and the latency, whatever it is called. */
export function describeTest(result: TestResult): { text: string; ms: number | null } {
  const ms = result.latencyMs ?? result.durationMs ?? null
  if (result.ok) {
    return { text: result.message ?? 'Connected', ms }
  }
  return { text: result.error ?? result.message ?? 'Connection failed', ms }
}

export type InstallPhase = string

export interface InstallProgress {
  phase: InstallPhase
  percent: number
  message?: string
  done: boolean
  error?: string
}

/**
 * Whether this deployment allows connections to be edited at all.
 *
 * Editing is a loopback-only capability on the server: a browser tool that can
 * add a connection can reach any host the server can, so exposing it on a
 * public bind would be a request-forgery pivot. When it is off the UI must say
 * **why**, and must not render a form that will 403 on submit.
 */
export interface EditPolicy {
  editable: boolean
  /** The server's own words. Shown verbatim; it knows the reason, we do not. */
  reason?: string
}

export interface ConnectionsSnapshot {
  connections: StoredConnection[]
  policy: EditPolicy
}

export interface ConnectorsSnapshot {
  connectors: ConnectorStatus[]
  policy: EditPolicy
}

/**
 * Everything the manager needs from a backend.
 *
 * An interface rather than a bare `fetch` wrapper so a host application can
 * supply its own transport — and so the demo can run the whole panel against an
 * in-memory stand-in while the real endpoints are still being built.
 */
export interface ConnectionsApi {
  listConnectors(signal?: AbortSignal): Promise<ConnectorsSnapshot>
  installConnector(id: string, signal?: AbortSignal): Promise<{ jobId: string }>
  installProgress(jobId: string, signal?: AbortSignal): Promise<InstallProgress>
  listConnections(signal?: AbortSignal): Promise<ConnectionsSnapshot>
  createConnection(draft: ConnectionDraft, signal?: AbortSignal): Promise<StoredConnection>
  updateConnection(id: string, draft: ConnectionDraft, signal?: AbortSignal): Promise<StoredConnection>
  deleteConnection(id: string, signal?: AbortSignal): Promise<void>
  testConnection(id: string, signal?: AbortSignal): Promise<TestResult>
  /**
   * Test a draft that has not been saved yet, when the server supports it.
   * Optional: without it the UI only offers "Test" on a saved connection,
   * which is honest rather than a button that cannot work.
   */
  testDraft?(draft: ConnectionDraft, signal?: AbortSignal): Promise<TestResult>
  /** Shown in the panel so it is never ambiguous what you are talking to. */
  describe?(): string
}
