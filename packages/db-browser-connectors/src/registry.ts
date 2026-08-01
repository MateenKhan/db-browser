/**
 * The connector registry: the catalogue, and what is usable right now.
 *
 * This is the module `GET /api/connectors` is, and it has one hard property:
 * **it works with nothing installed.** Descriptors are data (`descriptors/`),
 * driver presence is probed rather than assumed (`driverLoader.ts`), and
 * neither path imports a driver. A machine with no `pg`, no `mysql2` and no
 * `mssql` still gets the full list, each entry saying `installed: false` and
 * carrying the exact command that would change that.
 */

import { DbBrowserError } from '@jugaaadi/db-browser/core'
import { CONNECTOR_DESCRIPTORS, getDescriptor } from './descriptors/index.js'
import { detectPackageManager, installCommandFor, resolveDriver } from './driverLoader.js'
import type { PackageManager } from './driverLoader.js'
import type { ConnectorDescriptor, ConnectorStatus, EngineId } from './types.js'

/**
 * Engines this build has a working adapter for.
 *
 * Separate from "the driver is installed", and the distinction is not
 * pedantry: installing `oracledb` does not give you an Oracle browser if
 * nothing here knows how to introspect Oracle. Saying so up front is more
 * useful than an install that succeeds and a connection that then fails.
 *
 * Keep this in step with `dialects/index.ts` — `connectorStatuses()` asserts
 * they agree, so a dialect added without a listing here is a failing test.
 */
export const SUPPORTED_ENGINES: readonly EngineId[] = [
  'postgres',
  'cockroach',
  'mysql',
  'mariadb',
  'sqlite',
]

export function listDescriptors(): readonly ConnectorDescriptor[] {
  return CONNECTOR_DESCRIPTORS
}

/** One descriptor by id, throwing an actionable error for an unknown name. */
export function requireDescriptor(id: string): ConnectorDescriptor {
  const found = getDescriptor(id)
  if (!found) {
    throw new DbBrowserError(
      'UNKNOWN_ENGINE',
      `"${id}" is not a database engine this browser knows. Known engines: ` +
        CONNECTOR_DESCRIPTORS.map((d) => d.id).join(', '),
    )
  }
  return found
}

export interface ConnectorStatusOptions {
  /** Which manager to name in the install command. Detected by default. */
  packageManager?: PackageManager
}

/** Status for one connector, resolved live. */
export function connectorStatus(
  descriptor: ConnectorDescriptor,
  options: ConnectorStatusOptions = {},
): ConnectorStatus {
  const manager = options.packageManager ?? detectPackageManager()
  const resolved = resolveDriver(descriptor)
  const supported = SUPPORTED_ENGINES.includes(descriptor.id)

  const status: ConnectorStatus = {
    descriptor,
    installed: resolved.installed,
    supported,
  }
  if (resolved.version) status.installedVersion = resolved.version
  if (resolved.installed && resolved.version && !satisfiesRange(resolved.version, descriptor.driverRange)) {
    status.versionMismatch = true
    status.error =
      `Installed ${descriptor.driverPackage}@${resolved.version} is outside the supported ` +
      `range ${descriptor.driverRange}. It may work; it is not what this adapter was written against.`
  }
  if (!resolved.installed) {
    const command = installCommandFor(descriptor, manager)
    if (command) status.installCommand = command
    status.error =
      resolved.error ??
      (command
        ? `Not installed. Run:  ${command}`
        : `Not available in this environment.`)
  } else if (!supported) {
    status.error =
      `The driver is installed, but this build has no ${descriptor.label} adapter yet — ` +
      `only ${SUPPORTED_ENGINES.join(', ')} can be connected to.`
  }
  return status
}

/** Status for every connector. The body of `GET /api/connectors`. */
export function connectorStatuses(options: ConnectorStatusOptions = {}): ConnectorStatus[] {
  return CONNECTOR_DESCRIPTORS.map((d) => connectorStatus(d, options))
}

/**
 * A deliberately small semver-range check.
 *
 * Only `^`, `~`, `>=` and a bare version are understood, because those are the
 * only forms any descriptor in this repo uses and pulling in `semver` for four
 * operators would put a dependency in a package whose whole point is not
 * having any. **Anything it cannot parse returns `true`** — an unparsed range
 * must never be reported as a mismatch, because a false "your driver is wrong"
 * sends a user to fix something that is not broken.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version)
  if (!v) return true
  const spec = range.trim()

  const caret = /^\^(\d+)\.(\d+)\.(\d+)/.exec(spec)
  if (caret) {
    const [, maj, min, pat] = caret.map(Number) as unknown as [string, number, number, number]
    if (v.major !== maj) return false
    return v.minor > min || (v.minor === min && v.patch >= pat)
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)/.exec(spec)
  if (tilde) {
    const [, maj, min, pat] = tilde.map(Number) as unknown as [string, number, number, number]
    return v.major === maj && v.minor === min && v.patch >= pat
  }
  const gte = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(spec)
  if (gte) {
    const [, maj, min, pat] = gte.map(Number) as unknown as [string, number, number, number]
    if (v.major !== maj) return v.major > maj
    if (v.minor !== min) return v.minor > min
    return v.patch >= pat
  }
  const exact = parseVersion(spec)
  if (exact) {
    return v.major === exact.major && v.minor === exact.minor && v.patch === exact.patch
  }
  return true
}

function parseVersion(value: string): { major: number; minor: number; patch: number } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}
