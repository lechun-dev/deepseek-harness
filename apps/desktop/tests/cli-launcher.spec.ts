/**
 * Behaviour of the machine-wide `dsh` launcher this application installs:
 * which directory wins, what happens to an existing `dsh`, how installation is
 * verified, and what removal restores.
 */

import { describe, expect, it } from 'vitest'
import {
  CLI_LAUNCHER_NAME,
  cliLauncherName,
  cliLauncherDirectories,
  cliLauncherScript,
  installCliLauncher,
  readCliLauncher,
  removeCliLauncher,
  type CliLauncherEnvironment,
  type CliLauncherOperations,
} from '../src/cli-launcher.ts'

/** In-memory operations: no test touches the real filesystem or prompts. */
class FakeOperations implements CliLauncherOperations {
  readonly files = new Map<string, string>()
  readonly modes = new Map<string, number>()
  readonly links = new Map<string, string>()
  readonly directories = new Set<string>()
  readonly writable = new Set<string>()
  readonly privileged: string[] = []
  readonly renames: [string, string][] = []
  readonly calls: string[] = []
  report: string | undefined = '0.1.6-alpha.3'
  probe: string | undefined
  readonly copies: [string, string][] = []
  privilegedFailure: Error | undefined

  exists(path: string): boolean { return this.files.has(path) || this.links.has(path) }
  isDirectory(path: string): boolean { return this.directories.has(path) }
  isWritableDirectory(path: string): boolean { return this.writable.has(path) }
  readLink(path: string): string | undefined { return this.links.get(path) }
  readFile(path: string): string | undefined { return this.files.get(path) }

  writeFile(path: string, contents: string, mode: number): void {
    this.files.set(path, contents)
    this.modes.set(path, mode)
    this.calls.push(`write ${path}`)
  }

  writeLink(path: string, target: string): void {
    this.links.set(path, target)
    this.calls.push(`link ${path}`)
  }

  rename(from: string, to: string): void {
    const fromFile = this.files.get(from)
    const fromLink = this.links.get(from)
    this.files.delete(from)
    this.links.delete(from)
    if (fromFile !== undefined) this.files.set(to, fromFile)
    if (fromLink !== undefined) this.links.set(to, fromLink)
    this.renames.push([from, to])
    this.calls.push(`rename ${from} ${to}`)
  }

  remove(path: string): void {
    this.files.delete(path)
    this.links.delete(path)
    this.calls.push(`remove ${path}`)
  }

  async runPrivileged(script: string): Promise<void> {
    this.calls.push('privileged')
    if (this.privilegedFailure !== undefined) throw this.privilegedFailure
    this.privileged.push(script)
  }

  copyFile(from: string, to: string): void {
    this.copies.push([from, to])
    this.files.set(to, this.files.get(from) ?? '')
  }

  async installedVersion(): Promise<string | undefined> { return this.report }

  async probeMultica(): Promise<string | undefined> { return this.probe }
}

function environment(overrides: Partial<CliLauncherEnvironment> = {}): CliLauncherEnvironment {
  return {
    version: '0.1.6-alpha.3',
    platform: 'darwin',
    executable: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    cliEntry: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    pathEntries: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'],
    stateFile: '/Users/tester/Library/Application Support/dsh-desktop/cli-launcher.json',
    ...overrides,
  }
}

/** A Windows machine, where the only usable directory is the user's alias folder. */
function windowsEnvironment(overrides: Partial<CliLauncherEnvironment> = {}): CliLauncherEnvironment {
  return environment({
    platform: 'win32',
    executable: 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    cliEntry: 'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    pathEntries: [
      'C:\\Windows\\system32',
      'C:\\Windows',
      'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps',
    ],
    stateFile: 'C:\\Users\\tester\\AppData\\Roaming\\dsh-desktop\\cli-launcher.json',
    ...overrides,
  })
}

function usable(): FakeOperations {
  const operations = new FakeOperations()
  operations.directories.add('/opt/homebrew/bin')
  operations.writable.add('/opt/homebrew/bin')
  return operations
}

describe('cliLauncherScript', () => {
  it('runs the bundled entry through the application binary in Node mode', () => {
    const script = cliLauncherScript(environment())
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1 exec')
    expect(script).toContain("'/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'")
    expect(script).toContain(' --expose-internals ')
    expect(script).toContain('app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(script.endsWith('"$@"\n')).toBe(true)
  })
})

describe('cliLauncherDirectories', () => {
  it('prefers the conventional directories, then PATH order, without duplicates', () => {
    expect(cliLauncherDirectories(environment({ pathEntries: ['/usr/bin', '/opt/homebrew/bin', '', '/custom/bin'] }))).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/custom/bin',
    ])
  })

  it('keeps only the user alias directory on Windows, never a system directory', () => {
    expect(cliLauncherDirectories(windowsEnvironment())).toEqual([
      'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps',
    ])
  })

  it('offers no Windows directory when the alias folder is not on PATH', () => {
    expect(cliLauncherDirectories(windowsEnvironment({ pathEntries: ['C:\\Windows\\system32'] }))).toEqual([])
  })
})

describe('installed launcher self-checks', () => {
  it('reports the Multica bridge answer the launcher returned', async () => {
    const operations = usable()
    operations.probe = 'dsh'
    const result = await installCliLauncher(environment(), operations)
    expect(result.status === 'installed' && result.probe).toBe('dsh')
  })

  it('reports nothing when the bridge profile does not answer', async () => {
    const operations = usable()
    const result = await installCliLauncher(environment(), operations)
    expect(result.status === 'installed' && result.probe).toBeUndefined()
  })

  it('reports an earlier PATH entry that keeps precedence', async () => {
    const operations = usable()
    const env = environment({ pathEntries: ['/usr/bin', '/opt/homebrew/bin'] })
    operations.files.set('/usr/bin/dsh', '#!/bin/sh\necho old\n')
    const result = await installCliLauncher(env, operations)
    expect(result.status === 'installed' && result.shadowedBy).toBe('/usr/bin/dsh')
  })
})

describe('Windows launcher', () => {
  it('writes a .cmd that resolves through PATHEXT', () => {
    const script = cliLauncherScript(windowsEnvironment())
    expect(script.startsWith('@echo off')).toBe(true)
    expect(script).toContain('set ELECTRON_RUN_AS_NODE=1')
    expect(script).toContain('"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe"')
    expect(script).toContain(' --expose-internals ')
    expect(script).toContain(' %*')
    expect(cliLauncherName('win32')).toBe('dsh.cmd')
  })

  it('installs into the alias directory and never escalates', async () => {
    const operations = new FakeOperations()
    const alias = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps'
    operations.directories.add(alias)
    operations.directories.add('C:\\Windows\\system32')
    operations.writable.add(alias)
    const env = windowsEnvironment()

    const result = await installCliLauncher(env, operations)
    expect(result).toEqual({ status: 'installed', path: `${alias}\\dsh.cmd`, version: env.version })
    expect(operations.privileged).toEqual([])
    expect(operations.files.has('C:\\Windows\\system32\\dsh')).toBe(false)
  })


  it('installs the shipped executable plus its target file instead of a .cmd', async () => {
    const operations = new FakeOperations()
    const alias = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps'
    operations.directories.add(alias)
    operations.writable.add(alias)
    const shim = 'C:\\Program Files\\DeepSeek Harness\\resources\\cli-shim\\dsh.exe'
    operations.files.set(shim, 'MZ...')
    operations.probe = 'dsh'
    const env = windowsEnvironment({ shimSource: shim })

    const result = await installCliLauncher(env, operations)
    expect(result.status).toBe('installed')
    expect(operations.copies).toEqual([[shim, alias + '\\dsh.exe']])
    expect(operations.files.get(alias + '\\dsh-shim.json')).toContain('cliEntry')
    expect(result.status === 'installed' && result.probe).toBe('dsh')
  })

  it('reports no-directory instead of escalating when the alias directory is read-only', async () => {
    const operations = new FakeOperations()
    const alias = 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps'
    operations.directories.add(alias)
    operations.directories.add('C:\\Windows\\system32')
    operations.writable.add('C:\\Windows\\system32')

    expect(await installCliLauncher(windowsEnvironment(), operations)).toEqual({ status: 'no-directory' })
    expect(operations.privileged).toEqual([])
    expect(operations.files.size).toBe(0)
  })
})

describe('installCliLauncher', () => {
  it('writes an executable launcher, records it, and verifies the version', async () => {
    const operations = usable()
    const env = environment()
    const result = await installCliLauncher(env, operations)

    expect(result).toEqual({ status: 'installed', path: `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`, version: env.version })
    expect(operations.modes.get(`/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`)).toBe(0o755)
    expect(readCliLauncher(env, operations)).toEqual({ version: env.version, path: `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}` })
  })

  it('skips a preferred directory the user cannot write', async () => {
    const operations = usable()
    operations.writable.delete('/opt/homebrew/bin')
    operations.directories.add('/usr/local/bin')
    operations.writable.add('/usr/local/bin')

    const result = await installCliLauncher(environment(), operations)
    expect(result.status).toBe('installed')
    expect(result.status === 'installed' && result.path).toBe(`/usr/local/bin/${CLI_LAUNCHER_NAME}`)
    expect(operations.privileged).toEqual([])
  })

  it('falls back to one privileged write when no directory is writable', async () => {
    const operations = usable()
    operations.writable.clear()
    const result = await installCliLauncher(environment(), operations)

    expect(result.status).toBe('installed')
    expect(operations.calls).toContain('privileged')
    const script = operations.privileged[0]!
    expect(script).toContain(`cat > '/opt/homebrew/bin/${CLI_LAUNCHER_NAME}' <<'DSH_LAUNCHER'`)
    expect(script).toContain(`chmod 755 '/opt/homebrew/bin/${CLI_LAUNCHER_NAME}'`)
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1 exec')
  })

  it('reports cancellation of the authorization prompt as a failure', async () => {
    const operations = usable()
    operations.writable.clear()
    operations.privilegedFailure = new Error('User canceled.')
    await expect(installCliLauncher(environment(), operations)).rejects.toThrow('User canceled.')
  })

  it('reports no-directory when nothing on PATH exists', async () => {
    const operations = usable()
    operations.directories.clear()
    expect(await installCliLauncher(environment(), operations)).toEqual({ status: 'no-directory' })
  })

  it('leaves an identical launcher untouched', async () => {
    const operations = usable()
    const env = environment()
    operations.files.set(`/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`, cliLauncherScript(env))
    operations.calls.length = 0

    expect(await installCliLauncher(env, operations)).toEqual({
      status: 'unchanged', path: `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`, version: env.version,
    })
    expect(operations.calls).toEqual([])
  })

  it('replaces an existing symlink without writing through it', async () => {
    const operations = usable()
    const env = environment()
    const path = `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`
    operations.links.set(path, '/somewhere/else/dsh')

    const result = await installCliLauncher(env, operations)
    expect(result).toEqual({
      status: 'installed', path, version: env.version,
      replaced: { kind: 'symlink', target: '/somewhere/else/dsh' },
    })
    expect(operations.links.has(path)).toBe(false)
    expect(operations.files.get(path)).toBe(cliLauncherScript(env))
    expect(operations.calls.indexOf(`remove ${path}`)).toBeLessThan(operations.calls.indexOf(`write ${path}`))
  })

  it('preserves a regular file that already owned the name', async () => {
    const operations = usable()
    const env = environment()
    const path = `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`
    operations.files.set(path, '#!/bin/sh\necho old\n')

    const result = await installCliLauncher(env, operations)
    expect(result).toEqual({
      status: 'installed', path, version: env.version,
      replaced: { kind: 'file', backup: `${path}.${env.version}.bak` },
    })
    expect(operations.files.get(`${path}.${env.version}.bak`)).toBe('#!/bin/sh\necho old\n')
  })

  it('records a launcher whose verification failed so it can still be removed', async () => {
    const operations = usable()
    const env = environment()
    operations.report = '0.1.5-rc.2'

    expect(await installCliLauncher(env, operations)).toEqual({ status: 'unavailable', path: `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}` })
    expect(readCliLauncher(env, operations)?.path).toBe(`/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`)
  })
})

describe('removeCliLauncher', () => {
  it('reports nothing to do without a recorded installation', () => {
    expect(removeCliLauncher(environment(), usable())).toEqual({ status: 'absent' })
  })

  it('removes the launcher and restores the symlink it replaced', async () => {
    const operations = usable()
    const env = environment()
    const path = `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`
    operations.links.set(path, '/somewhere/else/dsh')
    await installCliLauncher(env, operations)

    expect(removeCliLauncher(env, operations)).toEqual({ status: 'removed', path, restored: '/somewhere/else/dsh' })
    expect(operations.links.get(path)).toBe('/somewhere/else/dsh')
    expect(readCliLauncher(env, operations)).toBeUndefined()
  })

  it('restores the file it moved aside', async () => {
    const operations = usable()
    const env = environment()
    const path = `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`
    operations.files.set(path, '#!/bin/sh\necho old\n')
    await installCliLauncher(env, operations)

    expect(removeCliLauncher(env, operations)).toEqual({ status: 'removed', path, restored: path })
    expect(operations.files.get(path)).toBe('#!/bin/sh\necho old\n')
  })

  it('clears its record when the launcher disappeared on its own', async () => {
    const operations = usable()
    const env = environment()
    await installCliLauncher(env, operations)
    operations.remove(`/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`)

    expect(removeCliLauncher(env, operations)).toEqual({ status: 'removed', path: `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}` })
    expect(readCliLauncher(env, operations)).toBeUndefined()
  })

  it('refuses to remove a directory that took the name', async () => {
    const operations = usable()
    const env = environment()
    await installCliLauncher(env, operations)
    operations.files.delete(`/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`)
    operations.directories.add(`/opt/homebrew/bin/${CLI_LAUNCHER_NAME}`)

    expect(removeCliLauncher(env, operations)).toEqual({ status: 'unavailable', path: `/opt/homebrew/bin/${CLI_LAUNCHER_NAME}` })
  })
})

describe('readCliLauncher', () => {
  it('treats unreadable records as no installation', () => {
    const operations = usable()
    const env = environment()
    for (const text of ['{', 'null', '{"version":1,"path":"/x"}', '{"version":"1","path":"/x","replaced":{"kind":"other"}}']) {
      operations.files.set(env.stateFile, text)
      expect(readCliLauncher(env, operations)).toBeUndefined()
    }
    operations.files.set(env.stateFile, JSON.stringify({ version: '1', path: '/x', replaced: { kind: 'file' } }))
    expect(readCliLauncher(env, operations)).toBeUndefined()
  })
})
