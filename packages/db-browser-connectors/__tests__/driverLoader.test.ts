/**
 * Driver resolution and the message a missing driver produces.
 *
 * **The message is the feature.** `Cannot find module 'mysql2'` is a stack
 * trace: it does not say which connector needed it, which version range works,
 * which package manager to use, or that the package was deliberately not
 * bundled. Every one of those is asserted here, because every one of them is
 * something a user would otherwise have to guess.
 */

import { describe, expect, it } from 'vitest'
import { DbBrowserError } from '@jugaaadi/db-browser/core'
import {
  detectPackageManager,
  installCommandFor,
  loadDriver,
  missingDriverError,
  resolveDriver,
} from '../src/driverLoader.js'
import { connectorStatus, connectorStatuses, satisfiesRange } from '../src/registry.js'
import {
  mysqlDescriptor,
  postgresDescriptor,
  sqliteDescriptor,
  oracleDescriptor,
} from '../src/descriptors/index.js'
import type { ConnectorDescriptor } from '../src/types.js'

/**
 * A descriptor for a package that cannot exist.
 *
 * The "absent driver" assertions used to point at `mysql2`, which is not
 * installed in this repo — and that made the suite depend on the machine's
 * `node_modules` rather than on the code. Installing `mysql2` (to verify the
 * install endpoint, say) turned four tests red for a reason that had nothing
 * to do with them. A name that is guaranteed unresolvable tests the same code
 * path and cannot be invalidated by an install.
 */
const ABSENT: ConnectorDescriptor = {
  ...mysqlDescriptor,
  id: 'mysql',
  label: 'Nonexistent Engine',
  driverPackage: '@jugaaadi/driver-that-will-never-exist',
  driverRange: '^1.2.3',
}

describe('resolveDriver', () => {
  it('resolves a driver that is genuinely installed', () => {
    // `pg` is a dependency of @jugaaadi/db-browser-pg in this repo.
    const resolved = resolveDriver(postgresDescriptor)
    expect(resolved.installed).toBe(true)
    expect(resolved.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('reports a driver that cannot resolve', () => {
    expect(resolveDriver(ABSENT).installed).toBe(false)
  })

  it('answers from the filesystem, not from a memoised guess', () => {
    // The property that matters: a driver can be added or removed between two
    // requests, and a cached "installed: true" about a package that is gone
    // produces the MODULE_NOT_FOUND this whole mechanism exists to replace.
    // Two calls, two real resolutions.
    expect(resolveDriver(postgresDescriptor).installed).toBe(true)
    expect(resolveDriver(ABSENT).installed).toBe(false)
    expect(resolveDriver(postgresDescriptor).installed).toBe(true)
  })

  it('treats a built-in as installed by probing the runtime, not a package', () => {
    // SQLite's `driverPackage` is null: `node:sqlite` ships with Node 22.5+.
    // Asking npm about it would answer "not installed" forever.
    const resolved = resolveDriver(sqliteDescriptor)
    expect(resolved.installed).toBe(typeof process.getBuiltinModule === 'function')
  })
})

describe('the install command', () => {
  it('names the package, the range and the detected package manager', () => {
    expect(installCommandFor(mysqlDescriptor, 'npm')).toBe('npm install mysql2@^3.11.0')
    expect(installCommandFor(mysqlDescriptor, 'pnpm')).toBe('pnpm add mysql2@^3.11.0')
    expect(installCommandFor(mysqlDescriptor, 'yarn')).toBe('yarn add mysql2@^3.11.0')
    expect(installCommandFor(mysqlDescriptor, 'bun')).toBe('bun add mysql2@^3.11.0')
  })

  it('has no command for a built-in, because there is nothing to install', () => {
    expect(installCommandFor(sqliteDescriptor, 'npm')).toBeNull()
  })

  it('detects the package manager from npm_config_user_agent', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v22' })).toBe('pnpm')
    expect(detectPackageManager({ npm_config_user_agent: 'yarn/4.0.0' })).toBe('yarn')
    expect(detectPackageManager({ npm_config_user_agent: 'bun/1.1.0' })).toBe('bun')
    // npm is the right fallback rather than merely the safe one: it is the
    // package manager that is always present.
    expect(detectPackageManager({})).toBe('npm')
    expect(detectPackageManager({ npm_config_user_agent: 'something-else' })).toBe('npm')
  })
})

describe('a missing driver produces an actionable error, never MODULE_NOT_FOUND', () => {
  it('names the engine, the package, the range and the exact command', () => {
    const e = missingDriverError(mysqlDescriptor, 'npm')
    expect(e).toBeInstanceOf(DbBrowserError)
    expect(e.code).toBe('DRIVER_NOT_INSTALLED')
    expect(e.message).toContain('MySQL')
    expect(e.message).toContain('npm install mysql2@^3.11.0')
    expect(e.detail).toContain('mysql2')
    expect(e.detail).toContain('^3.11.0')
    // And it explains *why* it is not bundled, which is the question a user
    // asks next.
    expect(e.detail).toMatch(/not bundled/i)
  })

  it('never surfaces the raw module-resolution error', () => {
    const e = missingDriverError(oracleDescriptor, 'pnpm')
    expect(e.message).not.toMatch(/MODULE_NOT_FOUND|Cannot find module|ERR_/)
    expect(e.message).toContain('pnpm add oracledb@^6.6.0')
  })

  it('talks about Node, not npm, for a built-in', () => {
    // Telling someone to `npm install node:sqlite` would be a dead end.
    const e = missingDriverError(sqliteDescriptor)
    expect(e.code).toBe('DRIVER_UNAVAILABLE')
    expect(e.message).toContain('node:sqlite')
    expect(e.message).toContain('Node')
    expect(e.message).not.toMatch(/npm install/)
  })

  it('is what loadDriver throws for an absent driver', async () => {
    await expect(loadDriver(ABSENT)).rejects.toMatchObject({ code: 'DRIVER_NOT_INSTALLED' })
    await expect(loadDriver(ABSENT)).rejects.toThrow(/driver-that-will-never-exist@\^1\.2\.3/)
    // A failed load must not be remembered — the fix is usually an install, so
    // the next attempt has to see the new state rather than a cached rejection.
    await expect(loadDriver(ABSENT)).rejects.toThrow(/never-exist/)
  })

  it('loads a driver that is present', async () => {
    const mod = await loadDriver<Record<string, unknown>>(postgresDescriptor)
    expect(mod).toBeTruthy()
  })
})

describe('connector status', () => {
  it('reports an absent driver with the install command attached', () => {
    const status = connectorStatus(ABSENT, { packageManager: 'npm' })
    expect(status.installed).toBe(false)
    expect(status.installCommand).toBe(
      'npm install @jugaaadi/driver-that-will-never-exist@^1.2.3',
    )
    expect(status.error).toContain('npm install @jugaaadi/driver-that-will-never-exist')
    expect(status.supported).toBe(true)
  })

  it('reports a present driver with its version', () => {
    const status = connectorStatus(postgresDescriptor)
    expect(status.installed).toBe(true)
    expect(status.installedVersion).toMatch(/^\d+\./)
    expect(status.installCommand).toBeUndefined()
  })

  it('distinguishes “no driver” from “no adapter in this build”', () => {
    // Installing `oracledb` would not give you an Oracle browser. Saying so up
    // front beats an install that succeeds and a connection that then fails.
    const status = connectorStatus(oracleDescriptor)
    expect(status.supported).toBe(false)
  })

  it('lists every connector, installed or not, with a command for the rest', () => {
    const statuses = connectorStatuses({ packageManager: 'npm' })
    const byId = Object.fromEntries(statuses.map((s) => [s.descriptor.id, s]))
    // Whether these are installed depends on the machine; what must always
    // hold is that an absent one carries the exact command and a present one
    // does not offer to install what is already there.
    for (const id of ['mysql', 'mariadb', 'mssql', 'duckdb', 'oracle']) {
      const status = byId[id]
      if (status.installed) {
        expect(status.installCommand, id).toBeUndefined()
      } else {
        expect(status.installCommand, id).toBe(
          `npm install ${status.descriptor.driverPackage}@${status.descriptor.driverRange}`,
        )
        expect(status.error, id).toContain('npm install')
      }
    }
    // Every entry carries its whole descriptor, so the UI can render the
    // connection form for an engine it cannot connect to yet.
    for (const s of statuses) {
      expect(s.descriptor.connectionFields.length).toBeGreaterThan(0)
      expect(Object.keys(s.descriptor.typeMap).length).toBeGreaterThan(0)
    }
  })
})

describe('satisfiesRange', () => {
  it('understands the four forms the descriptors use', () => {
    expect(satisfiesRange('8.13.1', '^8.11.0')).toBe(true)
    expect(satisfiesRange('8.10.0', '^8.11.0')).toBe(false)
    expect(satisfiesRange('9.0.0', '^8.11.0')).toBe(false)
    expect(satisfiesRange('3.11.5', '~3.11.0')).toBe(true)
    expect(satisfiesRange('3.12.0', '~3.11.0')).toBe(false)
    expect(satisfiesRange('22.20.0', '>=22.5.0')).toBe(true)
    expect(satisfiesRange('22.4.0', '>=22.5.0')).toBe(false)
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
  })

  it('answers true for anything it cannot parse', () => {
    // A false "your driver is wrong" sends a user to fix something that is not
    // broken. An unparsed range must never be reported as a mismatch.
    expect(satisfiesRange('8.13.1', '>=8 <10 || ^11')).toBe(true)
    expect(satisfiesRange('next', '^8.0.0')).toBe(true)
    expect(satisfiesRange('8.13.1', 'workspace:*')).toBe(true)
  })
})
