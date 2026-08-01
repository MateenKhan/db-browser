/**
 * The loopback gate.
 *
 * ## Why this exists, stated plainly
 *
 * A web database browser that accepts an arbitrary connection string from
 * anyone who can reach it is two tools at once, and only one of them is the
 * one you wanted:
 *
 *  1. **A server-side request forgery engine.** "Connect to
 *     `10.0.0.7:5432`" is a port scan of the internal network with a
 *     distinguishable response for open/closed/wrong-credentials. The same
 *     request against `169.254.169.254` is a cloud metadata probe. The server
 *     makes the connection, so every network boundary the *browser* could not
 *     cross is crossed for it.
 *  2. **A credential harvester.** "Connect to `attacker.example:3306` as
 *     `root`" makes this server offer whatever password is typed to a machine
 *     the attacker controls — and MySQL's handshake hands over enough for an
 *     offline crack. A connection form is an outbound-credential form.
 *
 * Installing a connector is the same shape of problem with a shorter path: it
 * runs a package manager as a child process, which downloads and executes code
 * from the network.
 *
 * So both are **disabled unless the server is bound to loopback**, and the
 * refusal says why rather than 403-ing blankly. This is not a configurable
 * hardening option. It is off-by-default with no switch, because the switch
 * would be the vulnerability: anybody who could be talked into flipping it is
 * exactly the person the gate protects.
 *
 * ## What "bound to loopback" means here
 *
 * The address the HTTP server is actually listening on — `server.address()` —
 * not the `Host` header (attacker-controlled), not the request's remote address
 * (which says who is talking, not who could), and not an environment variable
 * (which is a switch again). `0.0.0.0` and `::` are explicitly *not* loopback:
 * they are "every interface", which includes the ones that matter.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'

export type EditableReason =
  | 'loopback'
  | 'not-loopback'
  | 'unknown-binding'
  | 'explicitly-disabled'

export interface EditGate {
  /** True when connection CRUD and connector installs are permitted. */
  editable: boolean
  reason: EditableReason
  /** The address the server is bound to, for the message. Never a hostname. */
  boundAddress: string | null
  /** One sentence, shown verbatim in the UI. */
  message: string
}

/**
 * Loopback addresses, exactly.
 *
 * The IPv4 rule is the whole `127.0.0.0/8` block, not just `127.0.0.1` — the
 * kernel routes all of it to the local host, so `127.0.0.2` is as local as
 * `127.0.0.1` and treating it as remote would be wrong in the *strict*
 * direction, which is still wrong.
 *
 * `::ffff:127.0.0.1` is the IPv4-mapped IPv6 form and turns up whenever a
 * dual-stack socket accepts an IPv4 connection; missing it would make a
 * perfectly ordinary local setup read as remote.
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  const a = String(address ?? '').trim().toLowerCase()
  if (!a) return false
  if (a === '::1' || a === 'localhost') return true
  const mapped = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a
  if (mapped === '127.0.0.1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped)
  if (m) {
    const octets = m.slice(1).map(Number)
    if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false
    return octets[0] === 127
  }
  return false
}

/** What `server.address()` returns, reduced to what matters. */
export interface BindingInfo {
  address?: string | null
  family?: string
  port?: number
}

/**
 * Decide whether editing is permitted, from the server's actual binding.
 *
 * `null` — the server has not started, or is on a pipe — is treated as **not
 * editable**. Defaulting the unknown case to permissive would mean a
 * deployment shape nobody anticipated gets the dangerous behaviour, which is
 * the wrong way round.
 */
export function evaluateEditGate(
  binding: BindingInfo | string | null | undefined,
  options: { disabled?: boolean } = {},
): EditGate {
  if (options.disabled) {
    return {
      editable: false,
      reason: 'explicitly-disabled',
      boundAddress: null,
      message:
        'Connection editing is disabled for this server. Connections are read-only here; ' +
        'they can be managed from a locally-bound instance.',
    }
  }

  const address =
    typeof binding === 'string' ? binding : (binding?.address ?? null)

  if (!address) {
    return {
      editable: false,
      reason: 'unknown-binding',
      boundAddress: null,
      message:
        'Connection editing is disabled because this server could not determine which address ' +
        'it is bound to. Editing is only enabled on a loopback binding (127.0.0.1 or ::1).',
    }
  }

  if (isLoopbackAddress(address)) {
    return {
      editable: true,
      reason: 'loopback',
      boundAddress: address,
      message: `Bound to ${address} — connection editing and connector installs are enabled.`,
    }
  }

  return {
    editable: false,
    reason: 'not-loopback',
    boundAddress: address,
    message:
      `Connection editing and connector installs are disabled because this server is bound to ` +
      `${address}, not to loopback. A reachable database browser that accepts arbitrary ` +
      `connection details is a server-side request forgery and credential-harvesting tool: it ` +
      `would connect, on request, to any host the server can reach and offer it whatever ` +
      `password was typed. Bind to 127.0.0.1 to manage connections; browsing already-configured ` +
      `sources is unaffected.`,
  }
}

/** Throw unless editing is permitted. The single check every mutating route makes. */
export function assertEditable(gate: EditGate): void {
  if (!gate.editable) {
    throw new DbBrowserError('EDITING_DISABLED', gate.message)
  }
}
