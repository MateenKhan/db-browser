/**
 * Driver resolution and lazy loading.
 *
 * ## Two rules, and the failures they prevent
 *
 * **1. `installed` is resolved by attempting resolution, never assumed.**
 * Not from a lockfile, not from `package.json`'s dependency list, not from a
 * cached answer that outlived an `npm uninstall`. A registry that *claims* a
 * driver is present and then fails at connect time has moved the error later
 * and made it worse: the user is now looking at a connection dialog, not at a
 * list of connectors with an install button. `require.resolve` is the only
 * thing that knows.
 *
 * **2. The driver is imported at connect time, not at import time.** A
 * descriptor is data; this module is the only path from a descriptor to real
 * code. That is what makes `GET /api/connectors` work with nothing installed —
 * the process never touches `pg` unless a Postgres connection is opened.
 *
 * ## Why a bare `MODULE_NOT_FOUND` is treated as a bug
 *
 * `Cannot find module 'mysql2'` is a stack trace, not an instruction. It does
 * not say which connector needed it, which version range works, whether the
 * package manager is npm or pnpm, or where to run the command. Every failure
 * here is turned into a `DbBrowserError` carrying the exact command, and the
 * unit tests assert on that message — because the message *is* the feature.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DbBrowserError } from '@jugaaadi/db-browser/core'
import type { ConnectorDescriptor } from './types.js'

/**
 * Resolution is done from this file's own location, which is inside the
 * installed package tree, so a driver installed alongside it resolves the same
 * way `import` would at runtime. Resolving from `process.cwd()` instead would
 * answer for the *caller's* directory, which is a different node_modules on
 * every deployment layout that is not a single flat app.
 */
const requireFrom = createRequire(import.meta.url)

/** Node built-ins that back a descriptor with `driverPackage: null`. */
const BUILTIN_DRIVER: Record<string, string> = {
  sqlite: 'node:sqlite',
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/**
 * Which package manager to name in the install command.
 *
 * `npm_config_user_agent` is set by every one of them when they spawn a
 * script, so a server started with `pnpm run server` says `pnpm add`. Falling
 * back to npm is right rather than merely safe: npm is the one that is always
 * present.
 */
export function detectPackageManager(env: NodeJS.ProcessEnv = process.env): PackageManager {
  const ua = String(env.npm_config_user_agent ?? '')
  if (ua.startsWith('pnpm')) return 'pnpm'
  if (ua.startsWith('yarn')) return 'yarn'
  if (ua.startsWith('bun')) return 'bun'
  return 'npm'
}

const ADD_VERB: Record<PackageManager, string> = {
  npm: 'install',
  pnpm: 'add',
  yarn: 'add',
  bun: 'add',
}

/** The exact command that installs one descriptor's driver. */
export function installCommandFor(
  descriptor: ConnectorDescriptor,
  manager: PackageManager = detectPackageManager(),
): string | null {
  if (!descriptor.driverPackage) return null
  return `${manager} ${ADD_VERB[manager]} ${descriptor.driverPackage}@${descriptor.driverRange}`
}

export interface ResolvedDriver {
  installed: boolean
  version?: string
  /** Absolute path to the resolved entry point, for diagnostics. */
  path?: string
  error?: string
}

/**
 * Is this descriptor's driver present *right now*?
 *
 * Synchronous and uncached on purpose. It runs once per `GET /api/connectors`,
 * which is a handful of `stat` calls — cheaper than the bug where a driver
 * installed 200 ms ago still reads as missing because an answer was memoised.
 */
export function resolveDriver(descriptor: ConnectorDescriptor): ResolvedDriver {
  if (!descriptor.driverPackage) {
    const builtin = BUILTIN_DRIVER[descriptor.id]
    if (!builtin) {
      return { installed: true }
    }
    // `node:sqlite` exists only on Node 22.5+. `process.getBuiltinModule` is
    // itself 22.3+, so its absence is also the answer.
    const has =
      typeof process.getBuiltinModule === 'function' &&
      !!process.getBuiltinModule(builtin as 'node:sqlite')
    return has
      ? { installed: true, version: process.versions.node, path: builtin }
      : {
          installed: false,
          error:
            `${builtin} is not available in this Node build (running ${process.versions.node}). ` +
            `Upgrade to Node ${descriptor.driverRange}, or install better-sqlite3 as a fallback.`,
        }
  }

  try {
    const entry = requireFrom.resolve(descriptor.driverPackage)
    return { installed: true, version: readPackageVersion(descriptor.driverPackage), path: entry }
  } catch {
    // A driver can also be resolvable from the *process* root while not being
    // resolvable from this package — a hoisted install in a workspace, which
    // is exactly this repo's layout. Ask both before answering "no".
    try {
      const cwdRequire = createRequire(join(process.cwd(), 'noop.js'))
      const entry = cwdRequire.resolve(descriptor.driverPackage)
      return { installed: true, version: readPackageVersion(descriptor.driverPackage), path: entry }
    } catch {
      return { installed: false }
    }
  }
}

/**
 * The installed version, read from the driver's own `package.json`.
 *
 * Best-effort: a package with an `exports` map that does not expose
 * `./package.json` cannot be read this way, and that is fine — the version is
 * a diagnostic, not a gate. Returning `undefined` is better than resolving the
 * main entry and guessing.
 */
function readPackageVersion(pkg: string): string | undefined {
  for (const req of [requireFrom, createRequire(join(process.cwd(), 'noop.js'))]) {
    try {
      const manifest = req.resolve(`${pkg}/package.json`)
      return JSON.parse(readFileSync(manifest, 'utf8')).version as string
    } catch {
      /* fall through to the directory walk */
    }
    try {
      // No `./package.json` export. Walk up from the resolved entry point
      // until a manifest with the right name turns up.
      let dir = dirname(req.resolve(pkg))
      for (let i = 0; i < 8; i++) {
        try {
          const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
          if (parsed?.name === pkg) return parsed.version as string
        } catch {
          /* keep walking */
        }
        const up = dirname(dir)
        if (up === dir) break
        dir = up
      }
    } catch {
      /* try the next require */
    }
  }
  return undefined
}

/**
 * The error a missing driver produces. Exported because the wording is the
 * feature, and `__tests__/driverLoader.test.ts` asserts on it.
 */
export function missingDriverError(
  descriptor: ConnectorDescriptor,
  manager: PackageManager = detectPackageManager(),
  detail?: string,
): DbBrowserError {
  if (!descriptor.driverPackage) {
    return new DbBrowserError(
      'DRIVER_UNAVAILABLE',
      `${descriptor.label} needs ${BUILTIN_DRIVER[descriptor.id] ?? 'a built-in module'}, ` +
        `which this Node build (${process.versions.node}) does not provide. ` +
        `Upgrade to Node ${descriptor.driverRange}.`,
      detail,
    )
  }
  const command = installCommandFor(descriptor, manager)
  return new DbBrowserError(
    'DRIVER_NOT_INSTALLED',
    `The ${descriptor.label} driver is not installed. Run:  ${command}`,
    detail ??
      `${descriptor.label} connections need the "${descriptor.driverPackage}" package ` +
        `(${descriptor.driverRange}). It is not bundled, so that a machine which never opens a ` +
        `${descriptor.label} connection never installs it.`,
  )
}

/** Cached module handles, keyed by specifier. Load once per process. */
const loaded = new Map<string, Promise<unknown>>()

/**
 * Import a descriptor's driver, or throw the actionable error.
 *
 * The cache holds the *promise*, not the module, so two connections opened in
 * the same tick share one import rather than racing two.
 */
export async function loadDriver<T = unknown>(descriptor: ConnectorDescriptor): Promise<T> {
  const specifier = descriptor.driverPackage ?? BUILTIN_DRIVER[descriptor.id]
  if (!specifier) {
    throw missingDriverError(descriptor)
  }

  const cached = loaded.get(specifier)
  if (cached) return cached as Promise<T>

  const pending = (async () => {
    try {
      return await import(/* @vite-ignore */ specifier)
    } catch (e) {
      const code = (e as { code?: string })?.code
      // Only a *resolution* failure means "not installed". A driver that is
      // present but throws while initialising (a native binding built for the
      // wrong ABI, most often) must surface its own message — telling that
      // user to install a package they already have is a dead end.
      if (
        code === 'ERR_MODULE_NOT_FOUND' ||
        code === 'MODULE_NOT_FOUND' ||
        code === 'ERR_UNKNOWN_BUILTIN_MODULE'
      ) {
        throw missingDriverError(descriptor)
      }
      throw new DbBrowserError(
        'DRIVER_LOAD_FAILED',
        `The ${descriptor.label} driver ("${specifier}") is installed but could not be loaded.`,
        e instanceof Error ? e.message : undefined,
      )
    }
  })()

  loaded.set(specifier, pending)
  // A failed load must not be remembered — the fix is usually an install, and
  // the next attempt has to see the new state.
  pending.catch(() => loaded.delete(specifier))
  return pending as Promise<T>
}

/** Drop the module cache. Called after a successful install. */
export function forgetLoadedDrivers(): void {
  loaded.clear()
}
