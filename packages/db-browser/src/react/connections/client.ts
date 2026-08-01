/**
 * The HTTP implementation of {@link ConnectionsApi}.
 *
 * Thin on purpose: it maps the documented routes onto `fetch`, unwraps the
 * envelopes the server puts its payloads in, and turns a non-2xx into an
 * `Error` carrying the server's own message. It contains no engine knowledge
 * and no retry policy — a failed test is information the user asked for, not a
 * transient to paper over.
 *
 * ## Envelope tolerance lives next door, on purpose
 *
 * Every response shape this client accepts — and every shape it refuses — is
 * decided in `envelope.ts`, in pure functions with no `fetch` in sight, so the
 * real JSON the server returns can be pinned in a test without a network. This
 * module's only jobs are the URL, the headers and the status code.
 *
 * The rule those parsers enforce, and the reason they exist: **a response this
 * client cannot read must throw, not resolve to an empty list.** The panel once
 * reported "Drivers 0/0 — no driver is installed" against a server that had
 * eight, because `body.connectors ?? []` treats "key missing" and "no drivers"
 * as the same fact. They are not, and no route here conflates them any more.
 *
 * ## The gate is not an error
 *
 * A `403` on the list is the documented way a non-loopback bind says "editing
 * is disabled", so it resolves to an empty, non-editable snapshot carrying the
 * server's reason rather than throwing — the panel then renders the
 * explanation instead of a broken form.
 */

import {
  parseConnectionBody,
  parseConnectionsBody,
  parseConnectorsBody,
  parseInstallJobBody,
  parseInstallProgressBody,
  parseTestResultBody,
} from './envelope.js'
import type { EditingGate } from './envelope.js'
import type {
  ConnectionDraft,
  ConnectionsApi,
  ConnectionsSnapshot,
  ConnectorsSnapshot,
  EditPolicy,
  InstallProgress,
  TestResult,
} from './types.js'

export interface HttpConnectionsOptions {
  /** Origin + prefix, e.g. `http://localhost:6960/api`. No trailing slash. */
  baseUrl: string
  /** Extra headers per request (auth). Called fresh each time. */
  headers?: () => Record<string, string>
}

function toPolicy(editing: EditingGate | undefined, fallback = true): EditPolicy {
  if (!editing) return { editable: fallback }
  const editable = editing.enabled ?? editing.editable ?? fallback
  // `message` is the sentence written for a human ("Bound to 127.0.0.1 — …");
  // `reason` is the machine token ("loopback"). Prefer the sentence.
  return { editable, reason: editing.message ?? editing.reason }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      error?: string | { message?: string; code?: string }
      message?: string
    }
    if (typeof body.error === 'string') return body.error
    if (body.error?.message) return body.error.message
    return body.message || `${res.status} ${res.statusText}`
  } catch {
    return `${res.status} ${res.statusText}`
  }
}

export function createHttpConnectionsApi({ baseUrl, headers }: HttpConnectionsOptions): ConnectionsApi {
  const root = baseUrl.replace(/\/+$/, '')

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${root}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(headers?.() ?? {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    if (!res.ok) throw new Error(await readError(res))
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return {
    describe: () => root,

    async listConnectors(signal): Promise<ConnectorsSnapshot> {
      const res = await fetch(`${root}/connectors`, { signal, headers: headers?.() })
      if (res.status === 403) {
        return { connectors: [], policy: { editable: false, reason: await readError(res) } }
      }
      if (!res.ok) throw new Error(await readError(res))
      const parsed = parseConnectorsBody(await res.json(), `GET ${root}/connectors`)
      return { connectors: parsed.connectors, policy: toPolicy(parsed.editing) }
    },

    async installConnector(id, signal) {
      const path = `/connectors/${encodeURIComponent(id)}/install`
      return parseInstallJobBody(await call<unknown>(path, { method: 'POST', signal }), `POST ${root}${path}`)
    },

    async installProgress(jobId, signal): Promise<InstallProgress> {
      const path = `/connectors/install/${encodeURIComponent(jobId)}`
      return parseInstallProgressBody(await call<unknown>(path, { signal }), `GET ${root}${path}`)
    },

    async listConnections(signal): Promise<ConnectionsSnapshot> {
      const res = await fetch(`${root}/connections`, { signal, headers: headers?.() })
      if (res.status === 403) {
        return { connections: [], policy: { editable: false, reason: await readError(res) } }
      }
      if (!res.ok) throw new Error(await readError(res))
      const parsed = parseConnectionsBody(await res.json(), `GET ${root}/connections`)
      return { connections: parsed.connections, policy: toPolicy(parsed.editing) }
    },

    async createConnection(draft, signal) {
      const body = await call<unknown>('/connections', {
        method: 'POST',
        body: JSON.stringify(toWire(draft)),
        signal,
      })
      return parseConnectionBody(body, `POST ${root}/connections`)
    },

    async updateConnection(id, draft, signal) {
      const path = `/connections/${encodeURIComponent(id)}`
      const body = await call<unknown>(path, { method: 'PUT', body: JSON.stringify(toWire(draft)), signal })
      return parseConnectionBody(body, `PUT ${root}${path}`)
    },

    async deleteConnection(id, signal) {
      await call<void>(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
    },

    async testConnection(id, signal): Promise<TestResult> {
      const path = `/connections/${encodeURIComponent(id)}/test`
      const body = await call<unknown>(path, {
        method: 'POST',
        // An empty body means "use exactly what is stored". The browser cannot
        // send the password back — it was never given it — so anything else
        // would be testing a connection with a hole in it.
        body: '{}',
        signal,
      })
      return parseTestResultBody(body, `POST ${root}${path}`)
    },

    async testDraft(draft, signal): Promise<TestResult> {
      const body = await call<unknown>('/connections/test', {
        method: 'POST',
        body: JSON.stringify(toWire(draft)),
        signal,
      })
      return parseTestResultBody(body, `POST ${root}/connections/test`)
    },
  }
}

/** The wire body for a create / update / transient test. */
function toWire(draft: ConnectionDraft): Record<string, unknown> {
  return {
    name: draft.name,
    engine: draft.engine,
    values: draft.values,
    ...(draft.readOnly === undefined ? {} : { readOnly: draft.readOnly }),
  }
}

/**
 * Poll an install job to completion, reporting every tick.
 *
 * A driver download is the one long operation in this panel, and DBeaver's
 * version of it is the reference: a phase name and a real percentage, not a
 * spinner. So this surfaces every poll rather than only the final state, and it
 * stops on `done` **or** `error` — a job that reports an error is finished, and
 * continuing to poll it would leave the bar spinning under an error message.
 */
export async function pollInstall(
  api: ConnectionsApi,
  jobId: string,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal,
  intervalMs = 400,
): Promise<InstallProgress> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const progress = await api.installProgress(jobId, signal)
    onProgress(progress)
    if (progress.done || progress.error) return progress
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
