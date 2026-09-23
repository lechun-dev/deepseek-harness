/** Built Desktop Host lifecycle with Electron disconnecting before profile startup settles. */

import { fork } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finished } from 'node:stream/promises'
import { expect, it, onTestFinished } from 'vitest'

/** The listen record a sibling Web service publishes on this Harness home. */
const published = {
  version: 1,
  pid: 84690,
  port: 3080,
  url: 'http://127.0.0.1:3080/?token=shared',
  injections: [{ kind: 'global', name: 'agent', value: 'worker' }],
}

it.each([[false, false], [true, false], [false, true]] as const)('settles startup after parent IPC disconnect (fail: %s, adopted: %s)', async (fail, adopted) => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-disconnect-'))
  const modules = join(root, 'node_modules', '@deepseek-ai')
  const hostDirectory = fileURLToPath(new URL('../../desktop-host/', import.meta.url))
  const manifest = JSON.parse(readFileSync(join(hostDirectory, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const stubbed = new Set(['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh', '@deepseek-ai/dsh-home-paths'])
  for (const name of Object.keys(manifest.dependencies)) {
    const destination = join(root, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    if (stubbed.has(name)) mkdirSync(destination)
    else symlinkSync(realpathSync(join(hostDirectory, 'node_modules', name)), destination, 'junction')
  }
  for (const [name, source] of [
    ['dsh-home-paths', `export const resolveDshHome = () => ${JSON.stringify(root)}`],
  ] as const) {
    writeFileSync(join(modules, name, 'package.json'), '{"type":"module","exports":"./index.js"}')
    writeFileSync(join(modules, name, 'index.js'), source)
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(modules, 'dsh-app-boot', 'package.json'), '{"type":"module","exports":"./index.js"}')
  writeFileSync(join(modules, 'dsh-app-boot', 'index.js'), `export const loadProfileDirectory = () => ({}); export const loadLayeredEnv = () => ({});
    export const probeWebListen = async () => (${adopted ? JSON.stringify(published) : 'undefined'})`)
  writeFileSync(join(modules, 'dsh', 'package.json'), '{"type":"module","exports":{"./profile-boot":"./profile-boot.js"}}')
  writeFileSync(join(modules, 'dsh', 'profile-boot.js'), `
    import { writeFileSync } from 'node:fs';
    export function runProfile(options) {
      process.send({ type: 'booting', packageManager: options.packageManager });
      return new Promise((resolve, reject) => process.once('disconnect', () => {
        if (${String(fail)}) { reject(new Error('fixture boot failure')); return; }
        resolve({ ctx: { plugin: async () => {}, effect: () => {}, on: () => {}, inject: () => {},
          connection: { authenticatedUrl: value => value }, webServer: { port: 3080 } },
          shutdown: { shutdown: async () => writeFileSync(${JSON.stringify(join(root, 'stopped'))}, 'stopped') } });
      }));
    }
  `)
  const entry = join(root, 'index.js')
  copyFileSync(join(hostDirectory, 'lib', 'index.js'), entry)
  const pnpm = join(root, 'bundled-pnpm.mjs')
  const nodeBin = join(root, 'bin')
  const child = fork(entry, [root, root, root, pnpm, nodeBin], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
  const drained = finished(child.stderr!, { cleanup: true })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([exited, drained])
    rmSync(root, { recursive: true, force: true })
  })
  try {
    const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', (code) => { reject(new Error(`Host exited before reporting: ${String(code)} ${stderr}`)) })
    })
    if (adopted) {
      // The published service is reported verbatim, and this child boots nothing:
      // no package manager transaction, no profile, so no shutdown handshake.
      expect(first).toEqual({ type: 'ready', url: published.url, injections: published.injections, attached: true })
      child.disconnect()
      expect(await exited).toBe(0)
      await drained
      expect(stderr).not.toContain('ERR_IPC_CHANNEL_CLOSED')
      expect(stderr).not.toContain('Unhandled')
      expect(existsSync(join(root, 'stopped'))).toBe(false)
      return
    }
    const boot = first as { packageManager: { command: string; args: string[]; env: Record<string, string> } }
    expect(boot.packageManager.command).toBe(process.execPath)
    expect(boot.packageManager.args).toEqual(['--expose-internals', pnpm])
    expect(boot.packageManager.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(boot.packageManager.env.PATH).toBe(`${nodeBin}${delimiter}${process.env.PATH ?? ''}`)
    child.disconnect()
    const exitCode = await exited
    await drained
    expect(child.signalCode).toBeNull()
    expect(exitCode, stderr).toBe(fail ? 1 : 0)
    expect(stderr).not.toContain('ERR_IPC_CHANNEL_CLOSED')
    expect(stderr).not.toContain('Unhandled')
    if (fail) expect(stderr).toContain('fixture boot failure')
    else expect(readFileSync(join(root, 'stopped'), 'utf8')).toBe('stopped')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([exited, drained])
  }
})
