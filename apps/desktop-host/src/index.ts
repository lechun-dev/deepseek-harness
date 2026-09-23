/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { inspect } from 'node:util'
import { loadLayeredEnv, loadProfileDirectory, probeWebListen, type WebListenRecord } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOfficeEngineResolution } from './office-engine.ts'

/** Port the Web bundle composes when an invocation names none (`packages/bundle/web-app/cordis.patch.yml`). */
const WEB_DEFAULT_PORT = 3080

/**
 * Whether this machine's loopback interface binds a port right now.
 * @param port - Loopback port to test.
 * @returns true when the probe bound and released that port.
 */
function loopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.listen(port, '127.0.0.1', () => { probe.close(() => { resolve(true) }) })
  })
}

/**
 * Arguments owned by the Desktop-launched Web runner.
 *
 * The Host adopts an already-published service for this Harness home before it
 * boots. With no adoptable sibling, Desktop keeps the Web address every other
 * surface composes by letting the Web server bind its own default port, so the
 * browser, a later `dsh web`, and every tool that knows that address reach the
 * one service this home runs; an occupied port fails that row instead, so the
 * probe then falls back to an OS-assigned loopback port. Electron uses the
 * authenticated URL reported after boot either way.
 * @param available - Whether one loopback port binds right now; tests replace it.
 * @returns the inner arguments for the Desktop Web invocation.
 */
export async function desktopHostWebArgs(
  available: (port: number) => Promise<boolean> = loopbackPortAvailable,
): Promise<readonly string[]> {
  return await available(WEB_DEFAULT_PORT) ? ['--no-open'] : ['--no-open', '--port', '0']
}

/** The parent IPC channel this Host is spawned with; `process` in production. */
export interface DesktopHostChannel {
  readonly connected: boolean
  on(event: 'message', listener: (message: unknown) => void): unknown
  once(event: 'disconnect', listener: () => void): unknown
  send?(message: unknown, callback?: (error: Error | null) => void): boolean
  disconnect(): void
}

/**
 * Report the Web service this Harness home already publishes, then stay alive as
 * the backend handle Electron started.
 *
 * This process boots no Harness: the published service owns the session log, the
 * workspace, and every plugin row, so it is the one surface both the browser and
 * the desktop window talk to. Stopping this child therefore cannot stop that
 * service — nothing here is holding it.
 * @param record - the live service published on this Harness home.
 * @param channel - parent IPC channel to report over.
 * @returns completion once Electron disconnects this child.
 */
export async function adoptPublishedService(
  record: WebListenRecord,
  channel: DesktopHostChannel = process,
): Promise<void> {
  if (!channel.connected) return
  channel.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') channel.disconnect()
    // Answer task control rather than leave the update flow waiting: this child
    // owns no tasks, and the composer names the adopted service as the owner.
    if (message.type === 'update-tasks' && 'requestId' in message && Number.isSafeInteger(message.requestId)) {
      channel.send?.({ type: 'update-tasks', requestId: message.requestId, active: true,
        error: 'desktop update: the adopted Web service owns this session' }, (error) => { if (error !== null) console.error(error) })
    }
  })
  await new Promise<void>((resolve) => {
    channel.once('disconnect', resolve)
    channel.send?.({ type: 'ready', url: record.url, injections: record.injections, attached: true },
      (error) => { if (error !== null) console.error(error) })
  })
}

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  installOfficeEngineResolution(runtimeDir)
  const adopted = await probeWebListen(resolveDshHome())
  if (adopted !== undefined) {
    await adoptPublishedService(adopted)
    return
  }
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: await desktopHostWebArgs(),
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const control: { updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl> } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  await ctx.plugin(desktopOffice, {
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() }, (error) => { if (error !== null) console.error(error) })
}

/** Upper bound of the startup diagnostic carried over IPC; the head holds the message and stack. */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
