/**
 * Install this application's bundled dsh runtime as the machine's `dsh`
 * command, so a surface that only reads PATH — MissionOS, a terminal — uses the
 * same installation the desktop window serves.
 *
 * The launcher is a shell wrapper, because the bundled runtime lives inside
 * `app.asar` and only the application's own Electron binary reads that archive.
 * Installation is explicit and reversible: an occupied path is preserved and a
 * state file records what to restore.
 * @module @deepseek-ai/dsh-desktop/cli-launcher
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'

/** Directories preferred for the launcher, most preferred first. */
export const PREFERRED_LAUNCHER_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'] as const

/** File name of the installed launcher. */
export const CLI_LAUNCHER_NAME = 'dsh'

/** One `dsh` that already occupied the chosen path. */
export type CliLauncherReplaced =
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'file'; readonly backup: string }

/** Recorded installation, used to report status and to remove the launcher. */
export interface CliLauncherState {
  /** Application version that installed the launcher. */
  readonly version: string
  /** Absolute launcher path. */
  readonly path: string
  /** What the launcher replaced, when the path was occupied. */
  readonly replaced?: CliLauncherReplaced
}

/** Inputs that decide what the launcher runs. */
export interface CliLauncherEnvironment {
  /** Installed application version, which the bundled runtime also reports. */
  readonly version: string
  /** Absolute application executable run in Electron Node mode. */
  readonly executable: string
  /** Absolute bundled `dsh` entry point inside the application. */
  readonly cliEntry: string
  /** `PATH` entries visible to this application, in lookup order. */
  readonly pathEntries: readonly string[]
  /** Absolute state file owned by this application. */
  readonly stateFile: string
}

/** Filesystem and process operations the installer needs; replaced in tests. */
export interface CliLauncherOperations {
  /** Whether a path exists as any kind of entry, following no symlink. */
  exists(path: string): boolean
  /** Whether a path is a directory. */
  isDirectory(path: string): boolean
  /** Whether the current user may create entries in a directory. */
  isWritableDirectory(path: string): boolean
  /** Symlink target, or undefined when the path is missing or not a symlink. */
  readLink(path: string): string | undefined
  /** File contents, or undefined when the path is missing. */
  readFile(path: string): string | undefined
  /** Create or replace a regular file at one path with one mode. */
  writeFile(path: string, contents: string, mode: number): void
  /** Create a symlink, replacing any existing entry. */
  writeLink(path: string, target: string): void
  /** Move an entry, replacing the destination. */
  rename(from: string, to: string): void
  /** Remove one entry. */
  remove(path: string): void
  /** Run one shell script with administrator rights, rejecting when refused. */
  runPrivileged(script: string): Promise<void>
  /** Run the installed launcher and return the version it reports. */
  installedVersion(path: string): Promise<string | undefined>
}

/** Outcome of an installation attempt. */
export type CliInstallResult =
  | { readonly status: 'installed'; readonly path: string; readonly version: string; readonly replaced?: CliLauncherReplaced }
  | { readonly status: 'unchanged'; readonly path: string; readonly version: string }
  | { readonly status: 'no-directory' }
  | { readonly status: 'unavailable'; readonly path: string }

/** Outcome of a removal attempt. */
export type CliRemoveResult =
  | { readonly status: 'removed'; readonly path: string; readonly restored?: string }
  | { readonly status: 'absent' }
  | { readonly status: 'unavailable'; readonly path: string }

/** Header comment of the installed launcher. */
const LAUNCHER_PREAMBLE = `#!/bin/sh
# Installed by DeepSeek Harness. Remove or reinstall it from the application menu.
`

/** Marker that terminates the privileged heredoc. */
const LAUNCHER_HEREDOC = 'DSH_LAUNCHER'

/** Quote one value for safe interpolation into a shell command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The launcher script that runs the bundled runtime under the application's own
 * Electron binary. `ELECTRON_RUN_AS_NODE` is what gives that binary plain
 * `node` semantics while still reading the `app.asar` archive.
 * @param environment - application paths.
 * @returns the complete shell script.
 */
export function cliLauncherScript(environment: CliLauncherEnvironment): string {
  return `${LAUNCHER_PREAMBLE}ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(environment.executable)} --expose-internals ${shellQuote(environment.cliEntry)} "$@"
`
}

/**
 * Directories the launcher may be written to, in order: the two conventional
 * locations first, then every other PATH entry this application can see, so an
 * installation still works where those directories are absent.
 * @param pathEntries - `PATH` entries visible to this application.
 * @returns absolute candidate directories without duplicates.
 */
export function cliLauncherDirectories(pathEntries: readonly string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const entry of [...PREFERRED_LAUNCHER_DIRECTORIES, ...pathEntries]) {
    if (entry === '' || seen.has(entry)) continue
    seen.add(entry)
    ordered.push(entry)
  }
  return ordered
}

/**
 * Where the launcher currently lives, read back from the state file.
 * @param environment - application paths, including the state file.
 * @param operations - filesystem operations.
 * @returns the recorded state, or undefined when this application installed none.
 */
export function readCliLauncher(environment: CliLauncherEnvironment, operations: CliLauncherOperations): CliLauncherState | undefined {
  const text = operations.readFile(environment.stateFile)
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // A truncated or hand-edited record is treated as "this application installed none".
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.version !== 'string' || typeof candidate.path !== 'string') return undefined
  const replaced = candidate.replaced
  if (replaced === undefined) return { version: candidate.version, path: candidate.path }
  if (typeof replaced !== 'object' || replaced === null) return undefined
  const entry = replaced as Record<string, unknown>
  if (entry.kind === 'symlink' && typeof entry.target === 'string') {
    return { version: candidate.version, path: candidate.path, replaced: { kind: 'symlink', target: entry.target } }
  }
  if (entry.kind === 'file' && typeof entry.backup === 'string') {
    return { version: candidate.version, path: candidate.path, replaced: { kind: 'file', backup: entry.backup } }
  }
  return undefined
}

/** Persist one installation record. */
function writeCliLauncherState(environment: CliLauncherEnvironment, operations: CliLauncherOperations, state: CliLauncherState): void {
  operations.writeFile(environment.stateFile, `${JSON.stringify(state, undefined, 2)}\n`, 0o600)
}

/**
 * The commands one privileged installation runs: preserve whatever occupies the
 * path, then write and mark the launcher executable. The existing entry is
 * removed first because a shell redirection follows a symlink instead of
 * replacing it.
 * @param path - absolute launcher path.
 * @param script - launcher contents.
 * @param replaced - what occupied the path, when anything did.
 * @returns newline-joined shell commands.
 */
function privilegedInstall(path: string, script: string, replaced: CliLauncherReplaced | undefined): string {
  const preserve = replaced?.kind === 'file' ? `mv -f ${shellQuote(path)} ${shellQuote(replaced.backup)}` : `rm -f ${shellQuote(path)}`
  return [
    preserve,
    `cat > ${shellQuote(path)} <<'${LAUNCHER_HEREDOC}'`,
    script.replace(/\n$/u, ''),
    LAUNCHER_HEREDOC,
    `chmod 755 ${shellQuote(path)}`,
  ].join('\n')
}

/**
 * Install the launcher into the first usable directory, preserving whatever
 * occupied the chosen path.
 *
 * A writable directory receives the file directly. When only an
 * administrator-owned conventional directory exists, the same preservation and
 * write run as one privileged script, which is the operating system's own
 * authorization prompt.
 * @param environment - application paths and version.
 * @param operations - filesystem and privilege operations.
 * @returns what the installation did.
 */
export async function installCliLauncher(
  environment: CliLauncherEnvironment,
  operations: CliLauncherOperations,
): Promise<CliInstallResult> {
  const candidates = cliLauncherDirectories(environment.pathEntries)
    .filter(directory => operations.isDirectory(directory))
  const writable = candidates.find(directory => operations.isWritableDirectory(directory))
  const directory = writable ?? candidates[0]
  if (directory === undefined) return { status: 'no-directory' }

  const script = cliLauncherScript(environment)
  const path = `${directory}/${CLI_LAUNCHER_NAME}`
  if (operations.readFile(path) === script) {
    return { status: 'unchanged', path, version: environment.version }
  }

  const target = operations.readLink(path)
  const replaced: CliLauncherReplaced | undefined = target !== undefined
    ? { kind: 'symlink', target }
    : operations.exists(path) ? { kind: 'file', backup: `${path}.${environment.version}.bak` } : undefined

  if (writable !== undefined) {
    if (replaced?.kind === 'file') operations.rename(path, replaced.backup)
    else if (replaced !== undefined) operations.remove(path)
    operations.writeFile(path, script, 0o755)
  } else {
    await operations.runPrivileged(privilegedInstall(path, script, replaced))
  }

  writeCliLauncherState(environment, operations, { version: environment.version, path, ...(replaced === undefined ? {} : { replaced }) })
  const version = await operations.installedVersion(path)
  if (version !== environment.version) return { status: 'unavailable', path }
  return { status: 'installed', path, version, ...(replaced === undefined ? {} : { replaced }) }
}

/**
 * Remove the launcher this application installed and restore what it replaced.
 * @param environment - application paths, including the state file.
 * @param operations - filesystem operations.
 * @returns what the removal did.
 */
export function removeCliLauncher(
  environment: CliLauncherEnvironment,
  operations: CliLauncherOperations,
): CliRemoveResult {
  const state = readCliLauncher(environment, operations)
  if (state === undefined) return { status: 'absent' }
  if (operations.isDirectory(state.path)) return { status: 'unavailable', path: state.path }
  if (!operations.exists(state.path)) {
    operations.remove(environment.stateFile)
    return { status: 'removed', path: state.path }
  }

  operations.remove(state.path)
  if (state.replaced?.kind === 'file' && operations.exists(state.replaced.backup)) {
    operations.rename(state.replaced.backup, state.path)
    operations.remove(environment.stateFile)
    return { status: 'removed', path: state.path, restored: state.path }
  }
  if (state.replaced?.kind === 'symlink') {
    operations.writeLink(state.path, state.replaced.target)
    operations.remove(environment.stateFile)
    return { status: 'removed', path: state.path, restored: state.replaced.target }
  }
  operations.remove(environment.stateFile)
  return { status: 'removed', path: state.path }
}

/** Quote one value as an AppleScript string literal. */
function appleScriptString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`
}

/**
 * Run one shell script through the operating system's own authorization prompt.
 * @param script - POSIX shell script executed by `/bin/sh`.
 * @returns completion, rejecting when the user cancels or the script fails.
 */
function runPrivilegedShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', `do shell script ${appleScriptString(script)} with administrator privileges`], (error) => {
      if (error === null) resolve()
      // `ExecFileException` carries the script's own message; keep it as the cause.
      else reject(new Error(error.message, { cause: error }))
    })
  })
}

/**
 * Ask the installed launcher for the version it reports.
 * @param path - absolute launcher path.
 * @returns the reported version, or undefined when the launcher fails.
 */
function probeInstalledVersion(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 60_000 }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      const reported = stdout.trim()
      resolve(reported === '' ? undefined : reported)
    })
  })
}

/**
 * Operations bound to this machine: real filesystem calls, the operating
 * system's authorization prompt, and version probing through the installed
 * launcher itself.
 * @returns operations for {@link installCliLauncher} and {@link removeCliLauncher}.
 */
export function systemCliLauncherOperations(): CliLauncherOperations {
  return {
    exists: path => existsSync(path),
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        // Absent or unreadable candidates are simply not candidates.
        return false
      }
    },
    isWritableDirectory: (path) => {
      try {
        accessSync(path, constants.W_OK)
        return true
      } catch {
        return false
      }
    },
    readLink: (path) => {
      try {
        return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined
      } catch {
        return undefined
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    writeFile: (path, contents, mode) => { writeFileSync(path, contents, { mode }) },
    writeLink: (path, target) => { symlinkSync(target, path) },
    rename: (from, to) => { renameSync(from, to) },
    remove: (path) => { rmSync(path, { force: true }) },
    runPrivileged: runPrivilegedShell,
    installedVersion: probeInstalledVersion,
  }
}
