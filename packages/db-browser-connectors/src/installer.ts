/**
 * Connector installation, as a streamed background job.
 *
 * ## Why this is a job and not a request
 *
 * `npm install pg` takes between two seconds and two minutes depending on the
 * network and the registry, and it produces output the whole time. Doing it
 * inside the request would hold a socket open for that long, give the user a
 * spinner with no information, and turn a slow registry into a gateway
 * timeout with no way to find out whether the install actually finished. So
 * the POST starts a child process and returns a job id immediately, and the
 * progress endpoint reports the phase, a percentage and the latest line.
 *
 * ## What is *not* passed to a shell
 *
 * The package name comes from a descriptor, never from the request — the route
 * takes an `EngineId`, looks up the descriptor, and installs
 * `descriptor.driverPackage`. `spawn` is called with an argument array and
 * `shell: false`, so even if a package name somehow contained a metacharacter
 * there is no shell to interpret it. This matters because the alternative
 * shape of this feature — "install the package named in the body" — is remote
 * code execution with extra steps.
 *
 * Installs are additionally gated on a loopback binding (`loopbackGate.ts`),
 * because running a package manager is downloading and executing code from the
 * network on request.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { DbBrowserError } from '@jugaaadi/db-browser/core'
import { detectPackageManager, forgetLoadedDrivers, resolveDriver } from './driverLoader.js'
import type { PackageManager } from './driverLoader.js'
import { requireDescriptor } from './registry.js'
import type { ConnectorDescriptor, EngineId } from './types.js'

export type InstallPhase = 'queued' | 'resolving' | 'downloading' | 'linking' | 'done' | 'failed'

export interface InstallProgress {
  phase: InstallPhase
  /** 0-100. Coarse by nature — see `phaseProgress`. */
  percent: number
  /** The most recent meaningful line of output, already scrubbed. */
  message: string
  done: boolean
  error: string | null
}

export interface InstallJob extends InstallProgress {
  id: string
  engine: EngineId
  package: string
  startedAt: string
  finishedAt: string | null
  /** Every scrubbed output line, newest last. Capped — see `MAX_LOG_LINES`. */
  log: string[]
  /** Set when the install finished and the driver then resolved. */
  installedVersion?: string
}

const MAX_LOG_LINES = 200

/**
 * Percentage per phase.
 *
 * A package manager does not report a percentage, and inventing a precise one
 * from parsed output would be a lie that gets less accurate as the tool
 * changes its format. Phases are what it *does* report, so the progress bar
 * moves on real events and stops pretending in between.
 */
const PHASE_PERCENT: Record<InstallPhase, number> = {
  queued: 0,
  resolving: 15,
  downloading: 45,
  linking: 80,
  done: 100,
  failed: 100,
}

/**
 * Classify one line of package-manager output into a phase.
 *
 * Deliberately loose: it matches on words that npm, pnpm, yarn and bun all
 * use, and an unrecognised line simply does not change the phase. The cost of
 * being wrong is a progress bar that sits still, not a wrong result.
 */
function phaseFor(line: string, current: InstallPhase): InstallPhase {
  const l = line.toLowerCase()
  if (/resolv|fetch metadata|packages in registry/.test(l)) return 'resolving'
  if (/download|progress|fetching|reify|added \d+ package/.test(l)) return 'downloading'
  if (/link|building|postinstall|prepare|audited/.test(l)) return 'linking'
  return current
}

/**
 * Strip anything that could be a credential from a line before it is stored.
 *
 * A registry URL with an embedded token (`https://user:token@registry/...`) is
 * the realistic case, and it appears in npm's own error output. `_authToken`
 * shows up in `.npmrc` echoes. This runs on every line, including the ones
 * that only ever reach the log.
 */
export function scrubInstallLine(line: string): string {
  return String(line)
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//<redacted>@')
    .replace(/(_auth(?:Token)?|_password|npm_token|NPM_TOKEN)\s*=\s*\S+/gi, '$1=<redacted>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 <redacted>')
}

const ARGS: Record<PackageManager, (pkg: string) => string[]> = {
  npm: (pkg) => ['install', pkg, '--no-audit', '--no-fund'],
  pnpm: (pkg) => ['add', pkg],
  yarn: (pkg) => ['add', pkg],
  bun: (pkg) => ['add', pkg],
}

export interface SpawnPlan {
  command: string
  args: string[]
  /** True only where there is genuinely no way to avoid a shell. */
  shell: boolean
  /** How the command was chosen, for the job log. */
  via: 'npm_execpath' | 'direct' | 'shell'
}

/**
 * Decide *how* to run the package manager, without a shell wherever possible.
 *
 * On Windows every package manager is a `.cmd` shim, and since the fix for
 * CVE-2024-27980 Node refuses to `spawn` one with `shell: false` — it fails
 * with `EINVAL`. That is a real security fix and working around it with
 * `shell: true` everywhere would re-open exactly what it closed.
 *
 * So the order is:
 *
 *  1. **`npm_execpath`** — npm, pnpm and yarn all set it when they spawn a
 *     script, and it points at the manager's *JavaScript* entry point. Running
 *     `node <that> install pkg` is a plain executable with an argument array:
 *     no shim, no shell, no interpretation, and it works identically on every
 *     platform. This is the path a server started with `npm run server` takes,
 *     which is every normal case.
 *  2. **the bare binary** — correct on POSIX, where `npm` is a real
 *     executable.
 *  3. **a shell**, only on Windows with no `npm_execpath` (a server started by
 *     a supervisor rather than by a script). The argument is still a package
 *     name that came from a *descriptor* and never from a request, so there is
 *     nothing attacker-controlled for the shell to interpret — but it is the
 *     last resort rather than the default, and the job log records that it was
 *     used.
 */
export function planSpawn(
  manager: PackageManager,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): SpawnPlan {
  const execPath = env.npm_execpath
  if (execPath && /\.[cm]?js$/i.test(execPath)) {
    return { command: process.execPath, args: [execPath, ...args], shell: false, via: 'npm_execpath' }
  }
  if (platform !== 'win32') {
    return { command: manager, args, shell: false, via: 'direct' }
  }
  return { command: `${manager}.cmd`, args, shell: true, via: 'shell' }
}

export interface InstallerOptions {
  /** Where to run the install. The project root, normally. */
  cwd: string
  packageManager?: PackageManager
  /** Kill the child after this long. Default 5 minutes. */
  timeoutMs?: number
  /** Injected in tests so no real package manager runs. */
  spawnFn?: typeof spawn
}

/**
 * Runs installs and remembers their jobs.
 *
 * One installer per process. Jobs are kept in memory: an install that the
 * server outlived is an install whose result is now visible in
 * `GET /api/connectors` anyway, so persisting job history would add a file for
 * information that has a better source.
 */
export class ConnectorInstaller {
  private readonly jobs = new Map<string, InstallJob>()
  /** package name → job id, so a concurrent install of the same one is refused. */
  private readonly active = new Map<string, string>()

  constructor(private readonly options: InstallerOptions) {}

  get(jobId: string): InstallJob | undefined {
    return this.jobs.get(jobId)
  }

  list(): InstallJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /**
   * Start an install. Returns immediately with the job.
   *
   * Refuses a second install of the same package while one is running: two
   * package managers writing one `node_modules` concurrently is how a tree
   * ends up half-linked, and the second one usually "succeeds" while leaving
   * the first one's work broken.
   */
  start(engine: EngineId | string): InstallJob {
    const descriptor = requireDescriptor(String(engine))
    if (!descriptor.driverPackage) {
      throw new DbBrowserError(
        'NOTHING_TO_INSTALL',
        `${descriptor.label} uses a built-in driver — there is nothing to install. ` +
          `It needs Node ${descriptor.driverRange}; this process is ${process.versions.node}.`,
      )
    }

    const existingId = this.active.get(descriptor.driverPackage)
    if (existingId) {
      const running = this.jobs.get(existingId)
      if (running && !running.done) {
        throw new DbBrowserError(
          'INSTALL_IN_PROGRESS',
          `An install of ${descriptor.driverPackage} is already running (job ${existingId}). ` +
            'Two package managers writing one node_modules concurrently corrupts it.',
        )
      }
    }

    const already = resolveDriver(descriptor)
    if (already.installed) {
      // Not an error — it is the desired state. A job that is already `done`
      // lets the caller use exactly the same polling path either way.
      const job = this.finishedJob(descriptor, already.version)
      this.jobs.set(job.id, job)
      return job
    }

    const spec = `${descriptor.driverPackage}@${descriptor.driverRange}`
    const job: InstallJob = {
      id: randomUUID(),
      engine: descriptor.id,
      package: descriptor.driverPackage,
      phase: 'queued',
      percent: 0,
      message: `Installing ${spec}…`,
      done: false,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: [],
    }
    this.jobs.set(job.id, job)
    this.active.set(descriptor.driverPackage, job.id)
    this.run(job, descriptor, spec)
    return job
  }

  private finishedJob(descriptor: ConnectorDescriptor, version?: string): InstallJob {
    const now = new Date().toISOString()
    return {
      id: randomUUID(),
      engine: descriptor.id,
      package: descriptor.driverPackage ?? descriptor.id,
      phase: 'done',
      percent: 100,
      message: `${descriptor.driverPackage} is already installed${version ? ` (${version})` : ''}.`,
      done: true,
      error: null,
      startedAt: now,
      finishedAt: now,
      log: [],
      ...(version ? { installedVersion: version } : {}),
    }
  }

  private run(job: InstallJob, descriptor: ConnectorDescriptor, spec: string): void {
    const manager = this.options.packageManager ?? detectPackageManager()
    const spawnFn = this.options.spawnFn ?? spawn
    const plan = planSpawn(manager, ARGS[manager](spec))
    this.append(job, `Running ${manager} (${plan.via}) in ${this.options.cwd}`)

    let child: ReturnType<typeof spawn>
    try {
      child = spawnFn(plan.command, plan.args, {
        cwd: this.options.cwd,
        // See `planSpawn`: no shell on any path that has an alternative, and
        // the package name comes from a descriptor rather than a request in
        // every case.
        shell: plan.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, npm_config_yes: 'true' },
      })
    } catch (e) {
      this.fail(job, e instanceof Error ? e.message : `Could not run ${manager}`)
      return
    }

    const timeout = this.options.timeoutMs ?? 5 * 60_000
    const timer = setTimeout(() => {
      this.append(job, `Timed out after ${Math.round(timeout / 1000)}s — killing ${manager}.`)
      child.kill()
    }, timeout)
    // A pending timer must not hold the process open on its own — an install
    // is a side task, not a reason for the server to refuse to exit.
    timer.unref?.()

    const onChunk = (chunk: Buffer | string) => {
      for (const raw of String(chunk).split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        this.append(job, line)
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    child.on('error', (e: Error) => {
      clearTimeout(timer)
      this.fail(
        job,
        `Could not run "${manager}": ${e.message}. Install the driver manually with:  ` +
          `${manager} ${manager === 'npm' ? 'install' : 'add'} ${spec}`,
      )
    })

    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code !== 0) {
        this.fail(job, `${manager} exited with code ${code ?? 'null'}.`)
        return
      }
      // The install said it succeeded; the only thing that proves it is a
      // resolution. A "successful" install of a package the runtime still
      // cannot find is a real outcome (wrong workspace root, most often), and
      // reporting it as success would send the user to a connection dialog
      // that then fails with the error this whole feature replaces.
      forgetLoadedDrivers()
      const resolved = resolveDriver(descriptor)
      if (!resolved.installed) {
        this.fail(
          job,
          `${manager} reported success, but "${descriptor.driverPackage}" still does not resolve ` +
            `from ${this.options.cwd}. It may have been installed into a different workspace root.`,
        )
        return
      }
      job.phase = 'done'
      job.percent = 100
      job.done = true
      job.finishedAt = new Date().toISOString()
      job.message = `Installed ${descriptor.driverPackage}${
        resolved.version ? `@${resolved.version}` : ''
      }.`
      if (resolved.version) job.installedVersion = resolved.version
      this.active.delete(job.package)
    })
  }

  private append(job: InstallJob, line: string): void {
    const scrubbed = scrubInstallLine(line)
    job.log.push(scrubbed)
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES)
    job.phase = phaseFor(scrubbed, job.phase === 'queued' ? 'resolving' : job.phase)
    job.percent = PHASE_PERCENT[job.phase]
    job.message = scrubbed
  }

  private fail(job: InstallJob, error: string): void {
    job.phase = 'failed'
    job.percent = 100
    job.done = true
    job.error = scrubInstallLine(error)
    job.message = job.error
    job.finishedAt = new Date().toISOString()
    this.active.delete(job.package)
  }
}
