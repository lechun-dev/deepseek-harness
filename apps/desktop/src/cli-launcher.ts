/**
 * Install this application's bundled dsh runtime as the machine's `dsh`
 * command, so a surface that only reads PATH — MissionOS, a terminal — uses the
 * same installation the desktop window serves.
 *
 * The launcher is a wrapper — a POSIX shell script on macOS, a `.cmd` on
 * Windows — because the bundled runtime lives inside `app.asar` and only the
 * application's own Electron binary reads that archive. Installation is
 * explicit and reversible: an occupied path is preserved and a state file
 * records what to restore. Every candidate directory must be one the current
 * user owns or may write; a system directory is never overwritten.
 * @module @deepseek-ai/dsh-desktop/cli-launcher
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'

/** macOS directories preferred for the launcher, most preferred first. */
export const PREFERRED_LAUNCHER_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin'] as const

/** File name of the installed launcher on macOS and Linux. */
export const CLI_LAUNCHER_NAME = 'dsh'

/** Windows launcher file name, the only spelling its command lookup resolves. */
export const CLI_LAUNCHER_WINDOWS_NAME = 'dsh.cmd'

/** Windows launcher executable name, which `CreateProcess` can run directly. */
export const CLI_LAUNCHER_WINDOWS_EXECUTABLE = 'dsh.exe'

/** Sibling file the Windows launcher executable reads for its target. */
export const CLI_LAUNCHER_SHIM_CONFIG = 'dsh-shim.json'

/** Windows user execution-alias directory, appended to a user PATH by default. */
const WINDOWS_APPS_DIRECTORY = /\\Microsoft\\WindowsApps\\?$/iu

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
  /** Sibling file a Windows launcher reads for its target, when one was written. */
  readonly configPath?: string
  /** What the launcher replaced, when the path was occupied. */
  readonly replaced?: CliLauncherReplaced
}

/** Inputs that decide what the launcher runs. */
export interface CliLauncherEnvironment {
  /** Installed application version, which the bundled runtime also reports. */
  readonly version: string
  /** Platform whose launcher spelling and installation rules apply. */
  readonly platform: NodeJS.Platform
  /** Absolute application executable run in Electron Node mode. */
  readonly executable: string
  /** Absolute bundled `dsh` entry point inside the application. */
  readonly cliEntry: string
  /** `PATH` entries visible to this application, in lookup order. */
  readonly pathEntries: readonly string[]
  /** Absolute state file owned by this application. */
  readonly stateFile: string
  /**
   * Absolute Windows launcher executable carried by this build. Windows cannot
   * execute a `.cmd` through `CreateProcess`, so a PATH consumer that is not a
   * shell needs a real executable; without one the installer writes `.cmd` and
   * reports that a shell is required.
   */
  readonly shimSource?: string
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
  /** Whether two regular files have identical bytes. */
  sameFile(first: string, second: string): boolean
  /** Create or replace a regular file at one path with one mode. */
  writeFile(path: string, contents: string, mode: number): void
  /** Create a symlink, replacing any existing entry. */
  writeLink(path: string, target: string): void
  /** Copy one file, replacing the destination. */
  copyFile(from: string, to: string): void
  /** Move an entry, replacing the destination. */
  rename(from: string, to: string): void
  /** Remove one entry. */
  remove(path: string): void
  /** Run one shell script with administrator rights, rejecting when refused. */
  runPrivileged(script: string): Promise<void>
  /** Run the installed launcher and return the version it reports. */
  installedVersion(path: string): Promise<string | undefined>
  /** Ask the installed launcher for the Multica bridge's probe answer. */
  probeMultica(path: string): Promise<string | undefined>
}

/** Outcome of an installation attempt. */
export type CliInstallResult =
  | {
    readonly status: 'installed'
    readonly path: string
    readonly version: string
    readonly replaced?: CliLauncherReplaced
    /** An earlier PATH entry that still answers for the same command name. */
    readonly shadowedBy?: string
    /** The Multica bridge's probe answer, when the launcher reported one. */
    readonly probe?: string
  }
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

/** Header comment of the installed Windows launcher. */
const WINDOWS_LAUNCHER_PREAMBLE = `@echo off
rem Installed by DeepSeek Harness. Remove or reinstall it from the application menu.
`

/** Marker that terminates the privileged heredoc. */
const LAUNCHER_HEREDOC = 'DSH_LAUNCHER'

/** Quote one value for safe interpolation into a shell command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Quote one value for a Windows command line. */
function windowsQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * The launcher file name for one platform: Windows resolves a command only
 * through a `PATHEXT` extension, so an extensionless file there is inert.
 * @param platform - platform whose lookup rules apply.
 * @returns the installed file name.
 */
export function cliLauncherName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? CLI_LAUNCHER_WINDOWS_NAME : CLI_LAUNCHER_NAME
}

/**
 * The launcher that runs the bundled runtime under the application's own
 * Electron binary. `ELECTRON_RUN_AS_NODE` is what gives that binary plain
 * `node` semantics while still reading the `app.asar` archive.
 * @param environment - application platform and paths.
 * @returns the complete launcher file contents.
 */
export function cliLauncherScript(environment: CliLauncherEnvironment): string {
  if (environment.platform === 'win32') {
    return `${WINDOWS_LAUNCHER_PREAMBLE}set ELECTRON_RUN_AS_NODE=1\r
${windowsQuote(environment.executable)} --expose-internals ${windowsQuote(environment.cliEntry)} %*\r
`
  }
  return `${LAUNCHER_PREAMBLE}ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(environment.executable)} --expose-internals ${shellQuote(environment.cliEntry)} "$@"
`
}

/**
 * Directories this platform prefers for a user-owned launcher: macOS keeps the
 * two conventional locations, and Windows uses the user's execution-alias
 * directory, which its own PATH already carries and no administrator needs to
 * change.
 * @param environment - platform and visible PATH entries.
 * @returns preferred directories, most preferred first.
 */
function preferredLauncherDirectories(environment: CliLauncherEnvironment): string[] {
  if (environment.platform === 'darwin') return [...PREFERRED_LAUNCHER_DIRECTORIES]
  if (environment.platform !== 'win32') return []
  const alias = environment.pathEntries.find(entry => WINDOWS_APPS_DIRECTORY.test(entry))
  return alias === undefined ? [] : [alias]
}

/**
 * Directories the launcher may be written to, in order: the platform's
 * preferred locations first, then every other PATH entry this application can
 * see, so an installation still works where those directories are absent.
 * @param environment - platform and visible PATH entries.
 * @returns candidate directories without duplicates.
 */
export function cliLauncherDirectories(environment: CliLauncherEnvironment): string[] {
  // Windows keeps the alias directory alone: the rest of its PATH holds system
  // directories a user process must never install into.
  const candidates = environment.platform === 'win32'
    ? preferredLauncherDirectories(environment)
    : [...preferredLauncherDirectories(environment), ...environment.pathEntries]
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const entry of candidates) {
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
  const configPath = typeof candidate.configPath === 'string' ? candidate.configPath : undefined
  const replaced = candidate.replaced
  const state: CliLauncherState = {
    version: candidate.version,
    path: candidate.path,
    ...(configPath === undefined ? {} : { configPath }),
  }
  if (replaced === undefined) return state
  if (typeof replaced !== 'object' || replaced === null) return undefined
  const entry = replaced as Record<string, unknown>
  if (entry.kind === 'symlink' && typeof entry.target === 'string') {
    return {
      version: candidate.version, path: candidate.path,
      ...(configPath === undefined ? {} : { configPath }),
      replaced: { kind: 'symlink', target: entry.target },
    }
  }
  if (entry.kind === 'file' && typeof entry.backup === 'string') {
    return {
      version: candidate.version, path: candidate.path,
      ...(configPath === undefined ? {} : { configPath }),
      replaced: { kind: 'file', backup: entry.backup },
    }
  }
  return undefined
}

/**
 * Whether a recorded launcher still points at this application and has every
 * file its platform requires.
 * @param environment - current application paths and version.
 * @param operations - filesystem operations.
 * @param state - installation record to validate.
 * @returns true only when no repair is needed.
 */
export function isCliLauncherCurrent(
  environment: CliLauncherEnvironment,
  operations: CliLauncherOperations,
  state: CliLauncherState | undefined = readCliLauncher(environment, operations),
): boolean {
  if (state === undefined || state.version !== environment.version) return false
  if (!operations.exists(state.path) || operations.isDirectory(state.path)) return false
  if (environment.platform !== 'win32' || environment.shimSource === undefined) {
    return operations.readFile(state.path) === cliLauncherScript(environment)
  }
  if (state.configPath === undefined || !operations.exists(state.configPath)) return false
  const text = operations.readFile(state.configPath)
  if (text === undefined) return false
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return false
    const config = value as Record<string, unknown>
    return config.executable === environment.executable && config.cliEntry === environment.cliEntry
  } catch {
    return false
  }
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
  const shimSource = environment.platform === 'win32' ? environment.shimSource : undefined
  const candidates = cliLauncherDirectories(environment)
    .filter(directory => operations.isDirectory(directory))
  const writable = candidates.find(directory => operations.isWritableDirectory(directory))
  // Only macOS can turn an administrator-owned directory into an installation,
  // through its own authorization prompt; the alias directory on Windows is
  // user-owned, so anything else there is simply not a candidate.
  const directory = writable ?? (environment.platform === 'darwin' ? candidates[0] : undefined)
  if (directory === undefined) return { status: 'no-directory' }

  const usesShim = shimSource !== undefined && operations.exists(shimSource)
  const script = cliLauncherScript(environment)
  const name = usesShim ? CLI_LAUNCHER_WINDOWS_EXECUTABLE : cliLauncherName(environment.platform)
  const separator = environment.platform === 'win32' ? '\\' : '/'
  const path = `${directory}${separator}${name}`
  if (!usesShim && operations.readFile(path) === script) {
    return { status: 'unchanged', path, version: environment.version }
  }

  // A Windows launcher executable reads its target from this sibling file, so
  // the application can move without rebuilding the shim.
  const configPath = usesShim ? `${directory}${separator}${CLI_LAUNCHER_SHIM_CONFIG}` : undefined
  const recorded = readCliLauncher(environment, operations)
  let configOwned = false
  if (usesShim && configPath !== undefined) {
    const config = operations.readFile(configPath)
    configOwned = config?.includes('"executable"') === true && config.includes('"cliEntry"')
  }
  // 2026-09-24 coder(lq): A failed upgrade can leave the executable without
  // its state/config files. Recognize our bundled binary so repair overwrites
  // that orphan instead of preserving and later restoring a broken launcher.
  const managed = recorded?.path === path || configOwned
    || (usesShim && operations.sameFile(path, shimSource))
  const target = operations.readLink(path)
  const replaced: CliLauncherReplaced | undefined = managed
    ? recorded?.replaced
    : target !== undefined
      ? { kind: 'symlink', target }
      : operations.exists(path) ? { kind: 'file', backup: `${path}.${environment.version}.bak` } : undefined
  const shadowedBy = earlierLauncher(environment, operations, directory)
  if (writable !== undefined) {
    if (!managed && replaced?.kind === 'file') operations.rename(path, replaced.backup)
    else if (!managed && replaced !== undefined) operations.remove(path)
    if (usesShim && configPath !== undefined) {
      operations.writeFile(configPath, `${JSON.stringify({ executable: environment.executable, cliEntry: environment.cliEntry }, undefined, 2)}\n`, 0o600)
      operations.copyFile(shimSource, path)
    } else {
      operations.writeFile(path, script, 0o755)
    }
  } else {
    await operations.runPrivileged(privilegedInstall(path, script, replaced))
  }

  writeCliLauncherState(environment, operations, {
    version: environment.version,
    path,
    ...(configPath === undefined ? {} : { configPath }),
    ...(replaced === undefined ? {} : { replaced }),
  })
  const version = await operations.installedVersion(path)
  if (version !== environment.version) return { status: 'unavailable', path }
  const probe = await operations.probeMultica(path)
  return {
    status: 'installed',
    path,
    version,
    ...(replaced === undefined ? {} : { replaced }),
    ...(shadowedBy === undefined ? {} : { shadowedBy }),
    ...(probe === undefined ? {} : { probe }),
  }
}

/**
 * Repair or install the launcher when its record, executable, configuration,
 * or application version is stale.
 * @param environment - current application paths and version.
 * @param operations - filesystem and process operations.
 * @returns the resulting installation status.
 */
export async function ensureCliLauncher(
  environment: CliLauncherEnvironment,
  operations: CliLauncherOperations,
): Promise<CliInstallResult> {
  const state = readCliLauncher(environment, operations)
  if (state !== undefined && isCliLauncherCurrent(environment, operations, state)) {
    return { status: 'unchanged', path: state.path, version: state.version }
  }
  if (state !== undefined) {
    const removed = removeCliLauncher(environment, operations)
    if (removed.status === 'unavailable') return removed
  }
  return installCliLauncher(environment, operations)
}

/**
 * An earlier PATH entry that still answers for the same command name, which
 * would take precedence over the launcher being installed.
 * @param environment - platform and visible PATH entries.
 * @param operations - filesystem operations.
 * @param directory - directory receiving the launcher.
 * @returns the first shadowing path, or undefined when nothing shadows it.
 */
function earlierLauncher(
  environment: CliLauncherEnvironment,
  operations: CliLauncherOperations,
  directory: string,
): string | undefined {
  const names = environment.platform === 'win32'
    ? [CLI_LAUNCHER_WINDOWS_EXECUTABLE, CLI_LAUNCHER_WINDOWS_NAME, CLI_LAUNCHER_NAME]
    : [CLI_LAUNCHER_NAME]
  const separator = environment.platform === 'win32' ? '\\' : '/'
  // Lookup order is PATH order: a directory this launcher is written to wins
  // only against entries that come after it. A directory absent from PATH is
  // shadowed by every entry, because nothing would ever look inside it.
  const position = environment.pathEntries.indexOf(directory)
  const earlier = position === -1 ? environment.pathEntries : environment.pathEntries.slice(0, position)
  for (const entry of earlier) {
    for (const name of names) {
      const candidate = `${entry}${separator}${name}`
      if (operations.exists(candidate)) return candidate
    }
  }
  return undefined
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
  if (state.configPath !== undefined) operations.remove(state.configPath)
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
 * Run one launcher program and return its trimmed standard output.
 * Windows resolves a `.cmd` launcher only through a shell, so that platform
 * runs the command through its own interpreter.
 * @param path - absolute launcher path.
 * @param args - arguments appended to the launcher.
 * @param timeoutMs - bound on the child's lifetime.
 * @returns the child's stdout, or undefined when it failed or printed nothing.
 */
function runLauncher(path: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, [...args], { timeout: timeoutMs, shell: process.platform === 'win32' }, (error, stdout) => {
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
 * Ask the installed launcher for the version it reports.
 * @param path - absolute launcher path.
 * @returns the reported version, or undefined when the launcher fails.
 */
function probeInstalledVersion(path: string): Promise<string | undefined> {
  return runLauncher(path, ['--version'], 60_000)
}

/**
 * Ask the installed launcher whether the Multica bridge profile answers, which
 * is the gate another runtime reads before it registers this machine.
 * @param path - absolute launcher path.
 * @returns the bridge's reported runtime name, or undefined when it did not answer.
 */
async function probeMultica(path: string): Promise<string | undefined> {
  const reported = await runLauncher(path, ['--profile', 'multica', '--probe'], 120_000)
  if (reported === undefined) return undefined
  try {
    const value: unknown = JSON.parse(reported.split(/\r?\n/u)[0] ?? '')
    if (typeof value !== 'object' || value === null) return undefined
    const runtime = (value as Record<string, unknown>).runtime
    return typeof runtime === 'string' && runtime !== '' ? runtime : undefined
  } catch {
    // A non-JSON answer means the profile is absent or its bridge is broken.
    return undefined
  }
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
    sameFile: (first, second) => {
      try {
        return readFileSync(first).equals(readFileSync(second))
      } catch {
        return false
      }
    },
    writeFile: (path, contents, mode) => { writeFileSync(path, contents, { mode }) },
    writeLink: (path, target) => { symlinkSync(target, path) },
    copyFile: (from, to) => { copyFileSync(from, to) },
    rename: (from, to) => { renameSync(from, to) },
    remove: (path) => { rmSync(path, { force: true }) },
    runPrivileged: runPrivilegedShell,
    installedVersion: probeInstalledVersion,
    probeMultica,
  }
}
